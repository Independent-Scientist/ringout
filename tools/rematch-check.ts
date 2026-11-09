/**
 * Rematch path, exercised end to end without a browser.
 *
 * Plays a match to a real finish (the human walks itself off the disc each round, so the CPU
 * takes it 2-0), then presses Rematch and asserts the lobby it leaves behind: match back in
 * 'lobby', no bodies, the CPU seat still seated and ready, the human unready, and a second
 * match that actually starts.
 */
import { register } from 'node:module';

register(new URL('./resolver.mjs', import.meta.url));

const { DbConnection, tables } = await import('../client/src/module_bindings/index.ts');

const SERVER_URI = process.env.VITE_ST_URI ?? 'ws://127.0.0.1:3000';
const DATABASE = process.env.VITE_ST_DB ?? 'ringout-dev';
const TIMEOUT_MS = Number(process.env.TIMEOUT_MS ?? 150000);

const connection = DbConnection.builder()
  .withUri(SERVER_URI)
  .withDatabaseName(DATABASE)
  .onConnect((_ctx, identity) => console.log(`connected as ${identity.toHexString().slice(0, 8)}`))
  .onConnectError((_ctx, err) => {
    console.error(`connect error: ${err.message}`);
    process.exit(1);
  })
  .build();

await new Promise<void>((resolve) => {
  connection.subscriptionBuilder().onApplied(() => resolve()).subscribe([
    tables.player,
    tables.match,
    tables.body,
    tables.matchScore,
    tables.event,
    tables.bot,
  ]);
});

const myHex = connection.identity.toHexString();
const findMe = () => [...connection.db.player.iter()].find((p) => p.id.toHexString() === myHex);
const myMatch = () => {
  const me = findMe();
  return me?.matchId !== undefined ? connection.db.match.id.find(me.matchId) : undefined;
};
const status = () => myMatch()?.status ?? 'none';
const bodiesInMatch = () =>
  [...connection.db.body.iter()].filter((b) => b.matchId === myMatch()?.id);
const botsInMatch = () => [...connection.db.bot.iter()].filter((b) => b.matchId === myMatch()?.id);

await connection.reducers.joinLobby({ name: 'rematch-check' });
if (findMe()?.matchId === undefined) {
  await connection.reducers.createMatch({});
}
await connection.reducers.addBot({});
await connection.reducers.setReady({ ready: true });

// Wait for the CPU seat to exist and both seats to be ready, then start.
await new Promise<void>((resolve) => {
  const check = () => {
    const bots = botsInMatch();
    const me = findMe();
    if (bots.length === 1 && me?.ready) resolve();
    else setTimeout(check, 100);
  };
  check();
});
await connection.reducers.startMatch({});
await new Promise((r) => setTimeout(r, 1200));
console.log(`started: status=${status()} bodies=${bodiesInMatch().length}`);

// Walk outwards at 30 Hz whenever a round is live; idle otherwise.
let seq = 1;
const inputTimer = setInterval(() => {
  const me = findMe();
  const body = [...connection.db.body.iter()].find((b) => b.owner.toHexString() === myHex);
  if (status() !== 'playing' || !me || !body || !body.alive) return;
  // Spawn is on +X for the first of two seats, so +X is outwards.
  connection.reducers
    .submitInputs({ samples: [{ seq: seq++, mx: 1, mz: 0, ax: 1, az: 0, dash: false }] })
    .catch(() => {});
}, 33);

const deadline = Date.now() + TIMEOUT_MS;
let sawRoundEnd = 0;
let lastStatus = status();
while (Date.now() < deadline && status() !== 'finished') {
  await new Promise((r) => setTimeout(r, 250));
  const now = status();
  if (now !== lastStatus) {
    if (now === 'round_end') sawRoundEnd += 1;
    console.log(`status: ${lastStatus} -> ${now} (score ${myMatch()?.scoreA}-${myMatch()?.scoreB})`);
    lastStatus = now;
  }
}
clearInterval(inputTimer);

const finalStatus = status();
const finalMatch = myMatch();
console.log(`\nmatch reached: ${finalStatus}, score ${finalMatch?.scoreA}-${finalMatch?.scoreB}, round ends seen ${sawRoundEnd}`);

const failures: string[] = [];
if (finalStatus !== 'finished') failures.push(`match never finished (status ${finalStatus})`);

if (finalStatus === 'finished') {
  const codeBefore = finalMatch?.code;
  await connection.reducers.rematch({});
  await new Promise((r) => setTimeout(r, 800));

  const after = myMatch()!;
  const bodies = bodiesInMatch();
  const bots = botsInMatch();
  const botSeats = [...connection.db.player.iter()].filter(
    (p) => p.matchId === myMatch()?.id && p.isBot
  );
  const me = findMe();
  console.log(
    `after rematch: status=${after?.status} code=${after?.code} bodies=${bodies.length} bots=${bots.length} bot.ready=${botSeats[0]?.ready} me.ready=${me?.ready}`
  );

  if (after?.status !== 'lobby') failures.push(`rematch left the match in '${after?.status}'`);
  if (bodies.length !== 0) failures.push(`rematch left ${bodies.length} ghost bodies`);
  if (bots.length !== 1) failures.push(`rematch lost the CPU seat (${bots.length} bot rows)`);
  if (me?.ready !== false) failures.push('rematch left the human marked ready');
  // The old rematch un-readied every seat including the CPU, and a bot cannot press Ready:
  // the lobby then sat at 0/2 forever. The CPU must come back ready.
  if (botSeats.length !== 1) failures.push(`rematch left ${botSeats.length} CPU seats, expected 1`);
  if (botSeats[0]?.ready !== true) failures.push('rematch left the CPU seat un-ready');
  if (after?.code !== codeBefore) failures.push('rematch changed the match code');
  if (after.round !== 1 || after.scoreA !== 0 || after.scoreB !== 0) failures.push('rematch did not reset round/score');

  // and it must be startable again
  await connection.reducers.setReady({ ready: true });
  await new Promise((r) => setTimeout(r, 500));
  await connection.reducers.startMatch({});
  await new Promise((r) => setTimeout(r, 1200));
  const restarted = myMatch();
  const newBodies = bodiesInMatch();
  console.log(`restarted: status=${restarted?.status} bodies=${newBodies.length}`);
  if (restarted?.status !== 'countdown' && restarted?.status !== 'playing') {
    failures.push(`second start did not begin a match (status ${restarted?.status})`);
  }
  if (newBodies.length !== 2) failures.push(`second start spawned ${newBodies.length} bodies, expected 2`);
}

if (failures.length > 0) {
  console.error('\nFAILED:\n  ' + failures.join('\n  '));
  process.exit(1);
}
console.log('\nRematch check passed.');
process.exit(0);
