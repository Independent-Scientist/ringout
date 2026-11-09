import * as C from '../../../shared/src/constants';

export type BodyState = {
  px: number;
  pz: number;
  /** Velocity the player asked for. Owned by the movement controller. */
  vx: number;
  vz: number;
  /** Velocity the world gave the body: shove lunges and body-body impulses. Owned by friction. */
  kx: number;
  kz: number;
  aim_x: number;
  aim_z: number;
  /** Active pickup boost and the tick it lapses (BOOST_* in constants). */
  boost_kind: number;
  boost_until: bigint;
  charge: number;
  alive: boolean;
  elim_order: number;
  cooldown_until: bigint;
  server_tick: bigint;
};

export type InputFrame = {
  mx: number;
  mz: number;
  ax: number;
  az: number;
  dash: boolean;
};

export type CollisionContact = {
  indexA: number;
  indexB: number;
  x: number;
  z: number;
  impulse: number;
};

type Motion = {
  vx: number;
  vz: number;
  kx: number;
  kz: number;
  aimX: number;
  aimZ: number;
  charge: number;
  cooldownUntil: bigint;
};

/**
 * Integrate velocity channels, apply the speed cap and the ring-out test.
 * Called exactly once per input frame, because the client predicts exactly one step per
 * frame it sends: any extra step here is an acknowledgement correction.
 */
function advance<T extends BodyState>(
  b: T,
  m: Motion,
  dt: number,
  arenaR: number,
  tick: bigint
): T {
  // Knockback never comes from a stick, so only friction can take it away.
  const knockbackDecay = Math.exp(-C.KNOCKBACK_FRICTION * dt);
  let kx = m.kx * knockbackDecay;
  let kz = m.kz * knockbackDecay;
  if (Math.hypot(kx, kz) < C.KNOCKBACK_MIN) {
    kx = 0;
    kz = 0;
  }

  // Control tops out at MAX_SPEED, so any excess speed is knockback: scale that channel only,
  // otherwise the cap would quietly re-implement the bug it exists to bound.
  const speed = Math.hypot(m.vx + kx, m.vz + kz);
  const maxAllowedSpeed = C.MAX_SPEED * C.SPEED_CAP_MULT;
  if (speed > maxAllowedSpeed) {
    const scale = maxAllowedSpeed / speed;
    kx *= scale;
    kz *= scale;
  }

  const px = b.px + (m.vx + kx) * dt;
  const pz = b.pz + (m.vz + kz) * dt;
  const isEliminated = Math.hypot(px, pz) > arenaR + C.ELIM_MARGIN;

  return {
    ...b,
    px,
    pz,
    vx: m.vx,
    vz: m.vz,
    kx,
    kz,
    aim_x: m.aimX,
    aim_z: m.aimZ,
    charge: m.charge,
    alive: !isEliminated,
    cooldown_until: m.cooldownUntil,
    server_tick: tick,
  };
}

/**
 * Step a single body forward by dt with a given input.
 * Pure, deterministic integrator shared across server and client.
 *
 * Velocity is split in two channels: `v` is what the stick asks for and is servo-driven
 * (snappy, clamped to MAX_SPEED); `k` is what the world did to the body (shove lunge,
 * collision impulse) and only friction removes it. The stick can lean against a shove —
 * while staggered it steers at STAGGER_CONTROL strength — but it can never cancel one.
 */
export function stepBody<T extends BodyState>(
  b: T,
  i: InputFrame,
  dt: number,
  arenaR: number,
  tick: bigint,
  frozen = false
): T {
  if (!b.alive) return b;

  // 1. Aim: maintain previous aim when stick is neutral
  const aimLength = Math.hypot(i.ax, i.az);
  const aimX = aimLength > C.EPSILON ? i.ax / aimLength : b.aim_x;
  const aimZ = aimLength > C.EPSILON ? i.az / aimLength : b.aim_z;

  if (frozen) {
    return {
      ...b,
      vx: 0,
      vz: 0,
      kx: 0,
      kz: 0,
      aim_x: aimX,
      aim_z: aimZ,
      charge: 0,
      server_tick: tick,
    };
  }

  // 2. Pickup boosts scale the two numbers the player feels. They live on the body, so the
  //    client predicts them from the same row it reconciles against.
  const boostKind = b.boost_until > tick ? b.boost_kind : C.BOOST_NONE;
  const speedMult =
    boostKind === C.BOOST_HASTE
      ? C.BOOST_HASTE_SPEED_MULT
      : boostKind === C.BOOST_HEAVY
        ? C.BOOST_HEAVY_SPEED_MULT
        : 1;
  const shoveMult =
    boostKind === C.BOOST_POWER
      ? C.BOOST_POWER_SHOVE_MULT
      : boostKind === C.BOOST_HEAVY
        ? C.BOOST_HEAVY_SHOVE_MULT
        : 1;

  // 3. Charge while shove button is held
  const chargeDelta = i.dash ? dt / C.CHARGE_TIME : 0;
  const charge = Math.min(1, b.charge + chargeDelta);

  // 4. Stagger: a live shove takes authority away from the stick without removing it
  const knockbackSpeed = Math.hypot(b.kx, b.kz);
  const authority = knockbackSpeed > C.STAGGER_MIN ? C.STAGGER_CONTROL : 1;

  // 5. Movement: approach target velocity stably without overshoot
  let vx = b.vx;
  let vz = b.vz;
  const moveLength = Math.hypot(i.mx, i.mz);
  if (moveLength > C.EPSILON) {
    const targetVx = (i.mx / moveLength) * C.MAX_SPEED * authority * speedMult;
    const targetVz = (i.mz / moveLength) * C.MAX_SPEED * authority * speedMult;
    const accelRate = Math.min(1, C.MOVE_ACCEL * dt);
    vx += (targetVx - vx) * accelRate;
    vz += (targetVz - vz) * accelRate;
  } else {
    const friction = Math.exp(-C.GROUND_FRICTION * dt);
    vx *= friction;
    vz *= friction;
  }

  // 6. Release = shove (server-only trigger; never predicted for hits). The lunge is
  //    knockback, so the shover's own stick cannot eat it either.
  let kx = b.kx;
  let kz = b.kz;
  let cooldownUntil = b.cooldown_until;
  if (!i.dash && charge > C.SHOVE_MIN_CHARGE && tick >= b.cooldown_until) {
    const shovePower = (C.SHOVE_MIN + (C.SHOVE_MAX - C.SHOVE_MIN) * charge) * shoveMult;
    const lunge = shovePower * (1 - C.SELF_RECOIL);
    kx += aimX * lunge;
    kz += aimZ * lunge;
    const cooldownTicks = BigInt(Math.ceil(C.SHOVE_COOLDOWN * C.TICK_HZ));
    cooldownUntil = tick + cooldownTicks;
  }

  return advance(
    b,
    { vx, vz, kx, kz, aimX, aimZ, charge: i.dash ? charge : 0, cooldownUntil },
    dt,
    arenaR,
    tick
  );
}

/**
 * Resolve pairwise collisions between bodies in the arena.
 * Bodies must be processed in sorted id order for determinism.
 * Impulses land on the knockback channel, so a collision shakes the body without
 * handing the stick a way to cancel it next tick.
 */
export function resolveCollisions(bodies: BodyState[], _dt: number): CollisionContact[] {
  const contacts: CollisionContact[] = [];
  for (let a = 0; a < bodies.length; a++) {
    for (let b = a + 1; b < bodies.length; b++) {
      const first = bodies[a];
      const second = bodies[b];
      if (!first || !second || !first.alive || !second.alive) continue;

      let dx = second.px - first.px;
      let dz = second.pz - first.pz;
      let dist = Math.hypot(dx, dz);
      if (dist === 0) {
        dx = C.EPSILON;
        dz = 0;
        dist = C.EPSILON;
      }

      const overlap = C.PLAYER_R * 2 - dist;
      if (overlap <= 0) continue;

      const normalX = dx / dist;
      const normalZ = dz / dist;

      // Equal-mass positional separation
      first.px -= (normalX * overlap) / 2;
      first.pz -= (normalZ * overlap) / 2;
      second.px += (normalX * overlap) / 2;
      second.pz += (normalZ * overlap) / 2;

      // Elastic impulse along normal, measured on total velocity (control + knockback)
      const relativeVelocity =
        (second.vx + second.kx - first.vx - first.kx) * normalX +
        (second.vz + second.kz - first.vz - first.kz) * normalZ;
      if (relativeVelocity > 0) continue;

      const impulse = (-(1 + C.RESTITUTION) * relativeVelocity) / 2;
      first.kx -= impulse * normalX;
      first.kz -= impulse * normalZ;
      second.kx += impulse * normalX;
      second.kz += impulse * normalZ;

      contacts.push({
        indexA: a,
        indexB: b,
        x: (first.px + second.px) / 2,
        z: (first.pz + second.pz) / 2,
        impulse,
      });
    }
  }
  return contacts;
}

/** Compute arena radius at a given elapsed time in seconds. */
export function radiusAt(elapsedSeconds: number): number {
  if (elapsedSeconds <= C.SHRINK_START_S) return C.ARENA_R_START;
  if (elapsedSeconds >= C.SHRINK_END_S) return C.ARENA_R_END;
  const progress =
    (elapsedSeconds - C.SHRINK_START_S) / (C.SHRINK_END_S - C.SHRINK_START_S);
  return C.ARENA_R_START + (C.ARENA_R_END - C.ARENA_R_START) * progress;
}
