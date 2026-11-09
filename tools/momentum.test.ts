import assert from 'node:assert/strict';
import { register } from 'node:module';
register(new URL('./resolver.mjs', import.meta.url));

const C = await import('../shared/src/constants.ts');
const { stepBody, resolveCollisions } = await import('../module/src/sim/step.ts');
type BodyState = import('../module/src/sim/step.ts').BodyState;
type InputFrame = import('../module/src/sim/step.ts').InputFrame;

function makeBody(px: number, pz: number, aimX: number, aimZ: number, charge = 0): BodyState {
  return {
    px,
    pz,
    vx: 0,
    vz: 0,
    kx: 0,
    kz: 0,
    aim_x: aimX,
    aim_z: aimZ,
    charge,
    alive: true,
    elim_order: 0,
    cooldown_until: 0n,
    server_tick: 0n,
  };
}

type Scenario = {
  slideAt1s: number;
  totalAt250: number;
  knockbackAt250: number;
  initialImpulse: number;
  initialKnockback: number;
};

/**
 * Full-charge shove into a victim standing just inside contact range, replayed on the
 * shipping integrator. The victim holds a stick the whole time, as a real player does.
 */
function shove(victimStick: InputFrame, ticks = 30): Scenario {
  const shover = makeBody(0, 0, 1, 0, 1);
  const victim = makeBody(1.1, 0, 1, 0);
  const bodies: BodyState[] = [shover, victim];
  let initialImpulse = 0;
  let initialKnockback = 0;
  let at250: BodyState | undefined;

  for (let t = 0; t < ticks; t++) {
    const shoverInput: InputFrame = { mx: 0, mz: 0, ax: 1, az: 0, dash: false };
    bodies[0] = stepBody(bodies[0]!, shoverInput, C.DT, C.ARENA_R_START, BigInt(t));
    bodies[1] = stepBody(bodies[1]!, victimStick, C.DT, C.ARENA_R_START, BigInt(t));
    const contacts = resolveCollisions(bodies, C.DT);
    if (t === 0) {
      initialImpulse = Math.hypot(bodies[1]!.vx + bodies[1]!.kx, bodies[1]!.vz + bodies[1]!.kz);
      initialKnockback = Math.hypot(bodies[1]!.kx, bodies[1]!.kz);
      assert.ok(contacts.length > 0, 'shove must reach the victim through body contact');
    }
    if (t === 7) at250 = { ...bodies[1]! };
  }

  assert.ok(at250, 'sampled 250 ms after contact');
  return {
    slideAt1s: bodies[1]!.px - 1.1,
    totalAt250: Math.hypot(at250!.vx + at250!.kx, at250!.vz + at250!.kz),
    knockbackAt250: Math.hypot(at250!.kx, at250!.kz),
    initialImpulse,
    initialKnockback,
  };
}

const into = shove({ mx: -1, mz: 0, ax: 1, az: 0, dash: false });
const idle = shove({ mx: 0, mz: 0, ax: 1, az: 0, dash: false });
const away = shove({ mx: 1, mz: 0, ax: 1, az: 0, dash: false });

console.log('victim into the shove :', JSON.stringify(into));
console.log('victim idle           :', JSON.stringify(idle));
console.log('victim running away   :', JSON.stringify(away));

// The regression this test exists for: a victim holding the stick into a shove used to
// cancel it inside 100 ms and end up 0.6 m BEHIND where they started.
// Knockback is what the shove owns; the stick is allowed to subtract from total speed.
assert.ok(
  into.knockbackAt250 >= into.initialKnockback * 0.6,
  `victim must keep 60% of the knockback at 250 ms, kept ${(into.knockbackAt250 / into.initialKnockback).toFixed(2)}`
);
assert.ok(into.slideAt1s >= 1.8, `victim must slide at least 1.8 m in 1 s, got ${into.slideAt1s.toFixed(2)}`);
assert.ok(into.knockbackAt250 >= 3, `knockback channel must still be live at 250 ms, got ${into.knockbackAt250.toFixed(2)}`);

// An idle victim (or one whose packets stalled) must still be carried, and further.
assert.ok(idle.slideAt1s >= 4, `idle victim must slide at least 4 m in 1 s, got ${idle.slideAt1s.toFixed(2)}`);
assert.ok(idle.slideAt1s > into.slideAt1s, 'an idle victim must travel further than one leaning into the shove');

// A victim already running away gets the shove stacked on top of their own movement.
assert.ok(away.slideAt1s > into.slideAt1s, 'running with the shove must carry further than running into it');

// The stick may lean against a shove but never reverse it: control authority is capped.
assert.ok(into.slideAt1s > 0, 'a shove into a resisting victim must still move them forwards');

console.log('Momentum test passed.');