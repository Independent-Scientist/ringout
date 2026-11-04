import assert from 'node:assert/strict';
import { register } from 'node:module';
register(new URL('./resolver.mjs', import.meta.url));

const C = await import('../shared/src/constants.ts');
const { resolveCollisions, stepBody } = await import('../module/src/sim/step.ts');
type BodyState = import('../module/src/sim/step.ts').BodyState;
type InputFrame = import('../module/src/sim/step.ts').InputFrame;

function createRng(seed: number) {
  let s = seed;
  return function () {
    s |= 0;
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function runSimulation(seed: number): string {
  const rng = createRng(seed);
  const bodies: BodyState[] = [
    {
      px: -2,
      pz: 0,
      vx: 0,
      vz: 0,
      aim_x: 1,
      aim_z: 0,
      charge: 0,
      alive: true,
      elim_order: 0,
      cooldown_until: 0n,
      server_tick: 0n,
    },
    {
      px: 2,
      pz: 0,
      vx: 0,
      vz: 0,
      aim_x: -1,
      aim_z: 0,
      charge: 0,
      alive: true,
      elim_order: 0,
      cooldown_until: 0n,
      server_tick: 0n,
    },
  ];

  for (let tick = 1n; tick <= 1000n; tick++) {
    for (let i = 0; i < bodies.length; i++) {
      const angle = rng() * Math.PI * 2;
      const input: InputFrame = {
        mx: Math.cos(angle),
        mz: Math.sin(angle),
        ax: Math.cos(angle),
        az: Math.sin(angle),
        dash: rng() > 0.85,
      };
      bodies[i] = stepBody(bodies[i]!, input, C.DT, C.ARENA_R_START, tick);
    }
    resolveCollisions(bodies, C.DT);
  }

  return JSON.stringify(bodies, (_key, val) =>
    typeof val === 'bigint' ? val.toString() : val
  );
}

const run1 = runSimulation(42);
const run2 = runSimulation(42);
assert.equal(run1, run2, 'Simulation must be byte-identical for identical inputs');
console.log('Determinism test passed: 1000 ticks produced byte-identical states.');
