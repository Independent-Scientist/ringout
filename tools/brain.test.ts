import assert from 'node:assert/strict';
import { register } from 'node:module';
register(new URL('./resolver.mjs', import.meta.url));

const { think, personaFromSeed } = await import('../module/src/ai/brain.ts');

const persona = personaFromSeed(9001);
const self = { px: 0, pz: 0, charge: 0, cooldown_until: 0n };
const memory = {
  targetId: 0n,
  releaseAtTick: 0n,
  holdStartedTick: 0n,
  nextDecisionTick: 0n,
  aimX: 0,
  aimZ: 0,
  steerX: 0,
  steerZ: 0,
};

function run(reactionTicks: number, ticks = 24) {
  let mem = { ...memory };
  const aims: Array<[number, number]> = [];
  for (let t = 0; t < ticks; t++) {
    // the rival circles, so a live-reading brain would track it every tick
    const angle = (t / ticks) * Math.PI;
    const rivals = [{ id: 2n, px: Math.cos(angle) * 4, pz: Math.sin(angle) * 4, alive: true }];
    const decision = think(self, rivals, 14, BigInt(t), mem, persona, reactionTicks);
    const aim = decision.commands.find((c) => c.kind === 'aim');
    aims.push([aim!.ax, aim!.az]);
    mem = decision.memory;
  }
  return aims;
}

const slow = run(6);
const fast = run(1);
const changes = (aims: Array<[number, number]>) =>
  aims.reduce((count, [ax, az], i) => (i > 0 && (ax !== aims[i - 1]![0] || az !== aims[i - 1]![1]) ? count + 1 : count), 0);

console.log('aim changes with 6-tick reaction:', changes(slow), 'of', slow.length, 'ticks');
console.log('aim changes with 1-tick reaction:', changes(fast), 'of', fast.length, 'ticks');

// A 200 ms link must not let a CPU track a dodging player every frame.
assert.ok(changes(slow) <= slow.length / 4, `slow brain must hold its aim, changed ${changes(slow)} times`);
assert.ok(changes(fast) > changes(slow) * 2, 'a low-latency brain must react more often than a laggy one');

// The hold is exact: ticks inside the window replay the identical command.
for (let t = 0; t < slow.length; t++) {
  if (t % 6 !== 0 && t > 0) {
    assert.deepEqual(slow[t], slow[t - 1], `tick ${t} must replay the decision taken at tick ${t - (t % 6)}`);
  }
}

console.log('Brain reaction test passed.');
