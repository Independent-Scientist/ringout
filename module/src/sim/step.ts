import * as C from '../../../shared/src/constants';

export type BodyState = {
  px: number;
  pz: number;
  vx: number;
  vz: number;
  aim_x: number;
  aim_z: number;
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

/**
 * Step a single body forward by dt with a given input.
 * Pure, deterministic integrator shared across server and client.
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
      aim_x: aimX,
      aim_z: aimZ,
      charge: 0,
      server_tick: tick,
    };
  }

  // 2. Charge while shove button is held
  const chargeDelta = i.dash ? dt / C.CHARGE_TIME : 0;
  const charge = Math.min(1, b.charge + chargeDelta);

  // 3. Movement: approach target velocity stably without overshoot
  let vx = b.vx;
  let vz = b.vz;
  const moveLength = Math.hypot(i.mx, i.mz);
  if (moveLength > C.EPSILON) {
    const targetVx = (i.mx / moveLength) * C.MAX_SPEED;
    const targetVz = (i.mz / moveLength) * C.MAX_SPEED;
    const accelRate = Math.min(1, C.MOVE_ACCEL * dt);
    vx += (targetVx - vx) * accelRate;
    vz += (targetVz - vz) * accelRate;
  } else {
    const friction = Math.exp(-C.GROUND_FRICTION * dt);
    vx *= friction;
    vz *= friction;
  }

  // 4. Release = shove (server-only trigger; never predicted for hits)
  let cooldownUntil = b.cooldown_until;
  if (!i.dash && charge > C.SHOVE_MIN_CHARGE && tick >= b.cooldown_until) {
    const shovePower = C.SHOVE_MIN + (C.SHOVE_MAX - C.SHOVE_MIN) * charge;
    vx += aimX * shovePower;
    vz += aimZ * shovePower;
    vx -= aimX * shovePower * C.SELF_RECOIL;
    vz -= aimZ * shovePower * C.SELF_RECOIL;
    const cooldownTicks = BigInt(Math.ceil(C.SHOVE_COOLDOWN * C.TICK_HZ));
    cooldownUntil = tick + cooldownTicks;
  }

  // 5. Integrate position
  const px = b.px + vx * dt;
  const pz = b.pz + vz * dt;

  // 6. Cap speed to prevent tunnelling
  const speed = Math.hypot(vx, vz);
  const maxAllowedSpeed = C.MAX_SPEED * C.SPEED_CAP_MULT;
  if (speed > maxAllowedSpeed) {
    vx *= maxAllowedSpeed / speed;
    vz *= maxAllowedSpeed / speed;
  }

  // 7. Ring-out check
  const isEliminated = Math.hypot(px, pz) > arenaR + C.ELIM_MARGIN;

  return {
    ...b,
    px,
    pz,
    vx,
    vz,
    aim_x: aimX,
    aim_z: aimZ,
    charge: i.dash ? charge : 0,
    alive: !isEliminated,
    cooldown_until: cooldownUntil,
    server_tick: tick,
  };
}

/**
 * Resolve pairwise collisions between bodies in the arena.
 * Bodies must be processed in sorted id order for determinism.
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

      // Elastic impulse along normal
      const relativeVelocity =
        (second.vx - first.vx) * normalX + (second.vz - first.vz) * normalZ;
      if (relativeVelocity > 0) continue;

      const impulse = (-(1 + C.RESTITUTION) * relativeVelocity) / 2;
      first.vx -= impulse * normalX;
      first.vz -= impulse * normalZ;
      second.vx += impulse * normalX;
      second.vz += impulse * normalZ;

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
