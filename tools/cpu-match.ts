/**
 * End-to-end check for CPU opponents: one real (headless) client, three server-side bots,
 * a full match, and a printed account of what the server actually did.
 *
 * The human stands still on purpose — every body that moves, shoves or wins a round here
 * is doing it through the bot brain, the command executor and the same stepBody a player
 * drives. No bot writes a position.
 */
import { register } from 'node:module';

register(new URL('./resolver.mjs', import.meta.url));

const { DbConnection, tables } = await import('../client/src/module_bindings/index.ts');

const SERVER_URI = process.env.VITE_ST_URI ?? 'ws://127.0.0.1:3000';
const DATABASE = process.env.VITE_ST_DB ?? 'ringout-dev';
const RUN_SECONDS = Number(process.env.RUN_SECONDS ?? 95);
const BOTS = Number(process.env.BOTS ?? 3);
const LATENCY_MS = Number(process.env.LATENCY_MS ?? 0);

const connection = DbConnection.builder()
  .withUri(SERVER_URI)
  .withDatabaseName(DATABASE)
  .onConnect((_ctx, identity) => console.log(`connected as ${identity.toHexString().slice(0, 8)}`))
  .onConnectError((_ctx, err) => {
    console.error(`connect error: ${err.message}`);
    process.exit(1);
  })
  .build();

let myHex = '';
let matchId: bigint | undefined;

const applied = new Promise<void>((resolve) => {
  connection.subscriptionBuilder().onApplied(() => resolve()).subscribe([
    tables.player,
    tables.match,
    tables.body,
    tables.inputFrame,
    tables.matchScore,
    tables.event,
    tables.bot,
    tables.pickup,
  ]);
});

await applied;
myHex = connection.identity.toHexString();
await connection.reducers.joinLobby({ name: 'harness' });
if (LATENCY_MS > 0) {
  // Stand in for a player on a real link: the module handicaps the CPU seats by this.
  await connection.reducers.reportLatency({ ms: LATENCY_MS });
  console.log(`reported latency: ${LATENCY_MS} ms`);
}
await connection.reducers.createMatch({});

const me = [...connection.db.player.iter()].find((p) => p.id.toHexString() === myHex);
matchId = me?.matchId;
if (matchId === undefined) throw new Error('no match after create_match');

for (let i = 0; i < BOTS; i++) {
  await connection.reducers.addBot({});
}
await connection.reducers.setReady({ ready: true });

// Wait for the bots to appear and be ready, then start.
await new Promise<void>((resolve) => {
  const check = () => {
    const seats = [...connection.db.player.iter()].filter((p) => p.matchId === matchId);
    const bots = seats.filter((p) => p.isBot);
    if (bots.length === BOTS && bots.every((p) => p.ready)) resolve();
    else setTimeout(check, 50);
  };
  check();
});

const seatsBeforeStart = [...connection.db.player.iter()].filter((p) => p.matchId === matchId);
console.log(
  `lobby: ${seatsBeforeStart.length} seats — ${seatsBeforeStart
    .map((p) => `${p.name}${p.isBot ? ' (cpu)' : ''}${p.ready ? ' ready' : ''}`)
    .join(', ')}`
);

await connection.reducers.startMatch({});

// The human seat walks to whichever pickup is nearest: that is what proves the floor works,
// since a stationary body would never touch one.
let mySeq = 1;
const pickupWalkTimer = setInterval(() => {
  // Hazards are walked around, exactly as a player would: only buffs are worth a detour.
  const pickups = [...connection.db.pickup.iter()].filter(
    (p) => p.matchId === matchId && p.kind !== 3
  );
  const me = [...connection.db.body.iter()].find(
    (b) => b.matchId === matchId && b.owner.toHexString() === myHex
  );
  if (!me || !me.alive) return;
  let best: { px: number; pz: number } | undefined;
  let bestDist = Infinity;
  for (const p of pickups) {
    const d = Math.hypot(p.px - me.px, p.pz - me.pz);
    if (d < bestDist) {
      bestDist = d;
      best = p;
    }
  }
  const dx = best ? best.px - me.px : 0;
  const dz = best ? best.pz - me.pz : 0;
  const len = Math.hypot(dx, dz);
  const mx = len > 0.2 ? dx / len : 0;
  const mz = len > 0.2 ? dz / len : 0;
  connection.reducers
    .submitInputs({ samples: [{ seq: mySeq++, mx, mz, ax: mx || 1, az: mz, dash: false }] })
    .catch(() => {});
}, 33);

const seenEvents = { shove: new Set<string>(), hit: new Set<string>(), elim: new Set<string>(), round: new Set<string>(), pickup: new Set<string>(), heavy: new Set<string>() };
const counts = () => ({
  shove: seenEvents.shove.size,
  hit: seenEvents.hit.size,
  elim: seenEvents.elim.size,
  round: seenEvents.round.size,
  pickup: seenEvents.pickup.size,
  heavy: seenEvents.heavy.size,
});
let maxPickupsOnFloor = 0;
const started = Date.now();
let lastLog = 0;
let maxTick = 0n;

const bodiesSeen = new Map<string, { name: string; moved: number; maxSpeed: number }>();
const aimTrack = new Map<string, { x: number; z: number; changes: number }>();

await new Promise<void>((resolve) => {
  const poll = () => {
    for (const ev of connection.db.event.iter()) {
      const key = `${ev.id}`;
      if (ev.kind === 'shove') seenEvents.shove.add(key);
      else if (ev.kind === 'hit') seenEvents.hit.add(key);
      else if (ev.kind === 'elim') seenEvents.elim.add(key);
      else if (ev.kind === 'round_end' || ev.kind === 'match_end') seenEvents.round.add(key);
      else if (ev.kind === 'pickup_heavy') seenEvents.heavy.add(key);
      else if (ev.kind.startsWith('pickup_')) seenEvents.pickup.add(key);
    }
    for (const b of connection.db.body.iter()) {
      if (b.matchId !== matchId) continue;
      const prev = bodiesSeen.get(b.id.toString()) ?? { name: b.name, moved: 0, maxSpeed: 0 };
      const speed = Math.hypot(b.vx + b.kx, b.vz + b.kz);
      bodiesSeen.set(b.id.toString(), {
        name: b.name,
        moved: prev.moved,
        maxSpeed: Math.max(prev.maxSpeed, speed),
      });
      maxTick = b.serverTick > maxTick ? b.serverTick : maxTick;
      const aimPrev = aimTrack.get(b.name);
      if (!aimPrev) {
        aimTrack.set(b.name, { x: b.aimX, z: b.aimZ, changes: 0 });
      } else if (Math.hypot(b.aimX - aimPrev.x, b.aimZ - aimPrev.z) > 1e-4) {
        aimPrev.x = b.aimX;
        aimPrev.z = b.aimZ;
        aimPrev.changes += 1;
      }
    }
    maxPickupsOnFloor = Math.max(
      maxPickupsOnFloor,
      [...connection.db.pickup.iter()].filter((p) => p.matchId === matchId).length
    );
    const now = Date.now();
    if (now - lastLog > 5000) {
      lastLog = now;
      const m = matchId !== undefined ? connection.db.match.id.find(matchId) : undefined;
      console.log(
        `t+${Math.round((now - started) / 1000)}s status=${m?.status} tick=${m?.tick} round=${m?.round} score=${m?.scoreA}-${m?.scoreB} alive=${
          [...connection.db.body.iter()].filter((b) => b.matchId === matchId && b.alive).length
        }`
      );
    }
    if (now - started > RUN_SECONDS * 1000) resolve();
    else setTimeout(poll, 100);
  };
  poll();
});

clearInterval(pickupWalkTimer);

const m = matchId !== undefined ? connection.db.match.id.find(matchId) : undefined;
console.log('\n--- result ---');
console.log(`match status: ${m?.status} round=${m?.round} score=${m?.scoreA}-${m?.scoreB} winner=${m?.winner?.toHexString().slice(0, 8) ?? '-'}`);
console.log(`ticks advanced: ${m?.tick} (last body tick ${maxTick})`);
console.log(
  `shove releases: ${counts().shove}, contact hits: ${counts().hit}, eliminations: ${counts().elim}, round ends: ${counts().round}, pickups taken: ${counts().pickup}, hazards taken: ${counts().heavy} (max on floor ${maxPickupsOnFloor})`
);
console.log('bodies:');
const failures: string[] = [];
const seconds = (Date.now() - started) / 1000;
for (const [, body] of bodiesSeen) {
  const aim = aimTrack.get(body.name);
  console.log(
    `  ${body.name.padEnd(10)} top speed ${body.maxSpeed.toFixed(2)} u/s | aim changes ${aim?.changes ?? 0} (${((aim?.changes ?? 0) / seconds).toFixed(1)}/s)`
  );
  if (!body.name.startsWith('harness') && (aim?.changes ?? 0) === 0) {
    failures.push(`${body.name} never turned: aim is frozen`);
  }
}
console.log('bot rows:');
for (const b of connection.db.bot.iter()) {
  console.log(
    `  ${b.owner.toHexString().slice(0, 10)} target=${b.targetId} release_at=${b.releaseAtTick}`
  );
}

if (counts().shove === 0) failures.push('no shove events — the bots never released');
if (counts().elim === 0) failures.push('no eliminations — nobody ever got pushed out');
if ((m?.tick ?? 0n) < BigInt(RUN_SECONDS * 20)) failures.push('the tick barely advanced');
for (const [id, body] of bodiesSeen) {
  const isHumanSeat = body.name === 'harness';
  if (!isHumanSeat && body.maxSpeed < 1) failures.push(`${body.name} never moved`);
  void id;
}
if (counts().hit === 0) failures.push('no contact hits — the shoves never landed');
if (counts().pickup === 0) failures.push('no pickups were taken — the floor is inert');
// Bots must treat HEAVY as a hazard. A body can still be shoved onto one, so allow a little.
if (counts().heavy > 1) failures.push(`bots walked into ${counts().heavy} hazards`);
if (maxPickupsOnFloor === 0) failures.push('no pickup ever spawned');

if (failures.length > 0) {
  console.error('\nFAILED:\n  ' + failures.join('\n  '));
  process.exit(1);
}
console.log('\nCPU match passed.');
process.exit(0);