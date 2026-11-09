import assert from 'node:assert/strict';
import { register } from 'node:module';
register(new URL('./resolver.mjs', import.meta.url));

const C = await import('../shared/src/constants.ts');
const { stepBody } = await import('../module/src/sim/step.ts');
type BodyState = import('../module/src/sim/step.ts').BodyState;

const NEUTRAL = { mx: 0, mz: 0, ax: 1, az: 0, dash: false };

function body(boost: number, until: bigint): BodyState {
  return {
    px: 0,
    pz: 0,
    vx: 0,
    vz: 0,
    kx: 0,
    kz: 0,
    boost_kind: boost,
    boost_until: until,
    aim_x: 1,
    aim_z: 0,
    charge: 1,
    alive: true,
    elim_order: 0,
    cooldown_until: 0n,
    server_tick: 0n,
  };
}

function shoveSpeed(boost: number) {
  // full charge released on tick 0, measure the knockback it produced
  const after = stepBody(body(boost, 10_000n), NEUTRAL, C.DT, C.ARENA_R_START, 0n);
  return Math.hypot(after.kx, after.kz);
}

function travelled(boost: number) {
  let b = body(boost, 10_000n);
  const move = { mx: 1, mz: 0, ax: 1, az: 0, dash: false };
  for (let t = 1; t <= 30; t++) {
    b = stepBody({ ...b, charge: 0 }, move, C.DT, C.ARENA_R_START, BigInt(t));
  }
  return b.px;
}

const power = shoveSpeed(C.BOOST_POWER);
const normalShove = shoveSpeed(C.BOOST_NONE);
const heavyShove = shoveSpeed(C.BOOST_HEAVY);
const expiredShove = shoveSpeed(C.BOOST_POWER); // control: same body, live boost

// expiry: boost_until already passed
const expired = stepBody(
  { ...body(C.BOOST_POWER, 1n), charge: 1 },
  NEUTRAL,
  C.DT,
  C.ARENA_R_START,
  5n
);
const expiredSpeed = Math.hypot(expired.kx, expired.kz);

const haste = travelled(C.BOOST_HASTE);
const normal = travelled(C.BOOST_NONE);
const heavy = travelled(C.BOOST_HEAVY);

console.log(
  `shove impulse   power ${power.toFixed(2)} | normal ${normalShove.toFixed(2)} | heavy ${heavyShove.toFixed(2)} | expired ${expiredSpeed.toFixed(2)}`
);
console.log(`1 s travel      haste ${haste.toFixed(2)} m | normal ${normal.toFixed(2)} m | heavy ${heavy.toFixed(2)} m`);

// The speed cap (MAX_SPEED * 2.5) bounds how much of the multiplier survives: 17 * 1.7 * 0.75
// is 21.7 u/s of lunge, and the body may not exceed 16.25. The buff still lands ~1.34x on the
// body that takes the hit, which is the number that decides the round.
assert.ok(power > normalShove * 1.25, 'POWER must add real shove weight');
assert.ok(heavyShove < normalShove * 0.8, 'HEAVY must weaken the shove');
assert.ok(Math.abs(expiredSpeed - normalShove) < 1e-6, 'an expired boost must behave exactly like none');
assert.ok(haste > normal * 1.15, 'HASTE must cover more ground');
assert.ok(heavy < normal * 0.9, 'HEAVY must slow the body down');
assert.ok(expiredShove > normalShove, 'control: the same body with a live boost keeps hitting harder');

console.log('Boost test passed.');
