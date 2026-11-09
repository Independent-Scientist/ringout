import * as C from '../../../shared/src/constants';
import type { Command } from '../../../shared/src/commands';

/**
 * A CPU opponent.
 *
 * The brain only ever emits Commands — the same vocabulary a keyboard produces — so the
 * simulation cannot tell a bot from a player. It never touches positions, velocities or
 * cooldowns; it decides where to walk, where to face, and when to hold the shove button.
 *
 * Determinism: every choice is a pure function of (body state, rivals, tick, memory, seed).
 * No wall clock, no Math.random, so a replay of the same match is identical.
 */

export type BotSelf = {
  px: number;
  pz: number;
  charge: number;
  cooldown_until: bigint;
};

export type BotRival = {
  id: bigint;
  px: number;
  pz: number;
  alive: boolean;
};

export type BotMemory = {
  targetId: bigint;
  releaseAtTick: bigint;
  holdStartedTick: bigint;
};

export type BotPersona = {
  reactionTicks: number;
  aimErrorRad: number;
  chargeTicks: number;
  preferredRange: number;
  edgeCaution: number;
};

/** Small integer hash: stable across engines, so personas are reproducible from a seed. */
function hash(seed: number, salt: number): number {
  let h = (seed ^ (salt * 0x9e3779b9)) >>> 0;
  h = Math.imul(h ^ (h >>> 16), 0x21f0aaad) >>> 0;
  h = Math.imul(h ^ (h >>> 15), 0x735a2d97) >>> 0;
  return (h ^ (h >>> 15)) >>> 0;
}

function unit(seed: number, salt: number): number {
  return hash(seed, salt) / 4294967296;
}

/** Personas spread over a band that is beatable but not passive. */
export function personaFromSeed(seed: number): BotPersona {
  return {
    reactionTicks: 3 + Math.floor(unit(seed, 1) * 4), // 3..6 ticks (100-200 ms)
    aimErrorRad: 0.05 + unit(seed, 2) * 0.16, // 3..12 degrees
    chargeTicks: 9 + Math.floor(unit(seed, 3) * 4), // 0.30..0.43 s
    preferredRange: 1.4 + unit(seed, 4) * 0.5, // 1.4..1.9 m
    edgeCaution: 1.6 + unit(seed, 5) * 1.2, // 1.6..2.8 m from the rim
  };
}

const CHARGE_MIN = 0.25; // release below this and the shove is a waste of the cooldown

function nearestAlive(self: BotSelf, rivals: readonly BotRival[], preference?: bigint): BotRival | undefined {
  let best: BotRival | undefined;
  let bestDist = Infinity;
  for (const rival of rivals) {
    if (!rival.alive) continue;
    const dist = Math.hypot(rival.px - self.px, rival.pz - self.pz);
    // Keep the current target unless someone is meaningfully closer; avoids target thrash.
    const bias = preference !== undefined && rival.id === preference ? -0.4 : 0;
    if (dist + bias < bestDist) {
      bestDist = dist + bias;
      best = rival;
    }
  }
  return best;
}

function steerTowards(fromX: number, fromY: number, toX: number, toY: number, weight: number): [number, number] {
  const dx = toX - fromX;
  const dy = toY - fromY;
  const length = Math.hypot(dx, dy);
  if (length < C.EPSILON) return [0, 0];
  return [(dx / length) * weight, (dy / length) * weight];
}

export type BotDecision = {
  commands: Command[];
  memory: BotMemory;
};

/**
 * One tick of thought. Returns the commands to feed the shared executor and the memory
 * to persist for the next tick.
 */
export function think(
  self: BotSelf,
  rivals: readonly BotRival[],
  arenaRadius: number,
  tick: bigint,
  memory: BotMemory,
  persona: BotPersona
): BotDecision {
  const commands: Command[] = [];
  const target = nearestAlive(self, rivals, memory.targetId);
  if (!target) {
    commands.push({ kind: 'steer', mx: 0, mz: 0 }, { kind: 'charge', hold: false });
    return { commands, memory: { ...memory, releaseAtTick: 0n } };
  }

  const dx = target.px - self.px;
  const dz = target.pz - self.pz;
  const distance = Math.hypot(dx, dz);

  // 1. Edge safety first: a robot with its back to the rim loses, so back off the rim
  //    before anything else, at a weight that beats a chase.
  const rimDistance = Math.hypot(self.px, self.pz);
  const rimDanger = arenaRadius - rimDistance;
  let moveX = 0;
  let moveZ = 0;
  if (rimDanger < persona.edgeCaution) {
    const [cx, cz] = steerTowards(self.px, self.pz, 0, 0, 1.6);
    moveX = cx;
    moveZ = cz;
  } else if (distance > persona.preferredRange) {
    const [cx, cz] = steerTowards(self.px, self.pz, target.px, target.pz, 1);
    moveX = cx;
    moveZ = cz;
  } else if (distance < persona.preferredRange * 0.55) {
    // Too close reads as "about to be shoved": give ground, but never off the disc.
    const [cx, cz] = steerTowards(target.px, target.pz, self.px, self.pz, 0.6);
    moveX = cx;
    moveZ = cz;
  }
  commands.push({ kind: 'steer', mx: moveX, mz: moveZ });

  // 2. Aim at the target with a fixed per-bot error, rotated deterministically per tick so
  //    the error looks like a hand and not a clock.
  const wobble = (unit(Number(tick % 360n), persona.chargeTicks * 7) - 0.5) * persona.aimErrorRad;
  const aimAngle = Math.atan2(dz, dx) + wobble;
  commands.push({ kind: 'aim', ax: Math.cos(aimAngle), az: Math.sin(aimAngle) });

  // 3. Shove: hold for a persona-specific time when in range, release to fire.
  let releaseAtTick = memory.releaseAtTick;
  const cooldownReady = tick >= self.cooldown_until;
  const inRange = distance <= persona.preferredRange + 0.55;
  const canStart = releaseAtTick === 0n && cooldownReady && inRange && self.charge < CHARGE_MIN;

  if (canStart) {
    releaseAtTick = tick + BigInt(persona.chargeTicks);
  }
  // A target that steps out of range mid-charge is not worth the cooldown.
  if (releaseAtTick !== 0n && !inRange && self.charge < CHARGE_MIN) {
    releaseAtTick = 0n;
  }

  const holding = releaseAtTick !== 0n && tick < releaseAtTick;
  commands.push({ kind: 'charge', hold: holding });
  if (releaseAtTick !== 0n && tick >= releaseAtTick) {
    releaseAtTick = 0n;
  }

  return {
    commands,
    memory: {
      targetId: target.id,
      releaseAtTick,
      holdStartedTick: canStart ? tick : memory.holdStartedTick,
    },
  };
}
