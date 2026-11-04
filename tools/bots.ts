import { execFileSync } from 'node:child_process';
import { register } from 'node:module';
import { parseArgs } from 'node:util';

// Register ESM extensionless module resolver before importing generated bindings
register(new URL('./resolver.mjs', import.meta.url));

const { DbConnection, tables } = await import('../client/src/module_bindings/index.ts');

const options = {
  n: { type: 'string', default: '4' },
  seconds: { type: 'string', default: '30' },
  'print-metrics': { type: 'boolean', default: false },
  'idle-collision': { type: 'boolean', default: false },
  'simultaneous-elim': { type: 'boolean', default: false },
  'three-player-score': { type: 'boolean', default: false },
  'timeout-round': { type: 'boolean', default: false },
} as const;

const { values } = parseArgs({ options, allowPositionals: true });
const idleCollisionMode = Boolean(values['idle-collision']);
const simultaneousElimMode = Boolean(values['simultaneous-elim']);
const threePlayerScoreMode = Boolean(values['three-player-score']);
const timeoutRoundMode = Boolean(values['timeout-round']);
const botCount =
  idleCollisionMode || simultaneousElimMode || timeoutRoundMode
    ? 2
    : threePlayerScoreMode
      ? 3
      : Math.max(1, Number.parseInt(values.n ?? '4', 10));
const durationSeconds = idleCollisionMode
  ? 6
  : simultaneousElimMode
    ? 7
    : threePlayerScoreMode
      ? 16
      : timeoutRoundMode
        ? 95
        : Math.max(1, Number.parseInt(values.seconds ?? '30', 10));
const printMetrics = Boolean(values['print-metrics']);

const SERVER_URI = process.env.VITE_ST_URI ?? 'ws://127.0.0.1:3000';
const DATABASE = process.env.VITE_ST_DB ?? 'ringout-dev';

type BotInstance = {
  id: number;
  connection: any;
  identityHex: string;
  ready: boolean;
  seq: number;
  seed: number;
};

// Seeded pseudo-random number generator (Mulberry32)
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

console.log(`Starting ${botCount} bots for ${durationSeconds}s against ${SERVER_URI} / ${DATABASE}...`);

const bots: BotInstance[] = [];
let targetMatchCode = '';
let targetMatchId: bigint | undefined;
let rowsWritten = 0;
const tickIntervalsMs: number[] = [];
let lastTickTime: number | null = null;
let ticksObserved = 0;

function computeStats(samples: number[]): { mean: number; stdDev: number } {
  if (samples.length === 0) return { mean: 0, stdDev: 0 };
  const sum = samples.reduce((acc, v) => acc + v, 0);
  const mean = sum / samples.length;
  const variance =
    samples.reduce((acc, v) => acc + (v - mean) * (v - mean), 0) / samples.length;
  return { mean, stdDev: Math.sqrt(variance) };
}

async function createBot(index: number): Promise<BotInstance> {
  return new Promise((resolve, reject) => {
    let identityHex = '';
    const botName = `bot-${index}`;

    const connection = DbConnection.builder()
      .withUri(SERVER_URI)
      .withDatabaseName(DATABASE)
      .onConnect((_ctx, identity) => {
        identityHex = identity.toHexString();
      })
      .onConnectError((_ctx, err) => {
        reject(new Error(`Bot ${index} connect error: ${err.message}`));
      })
      .build();

    const bot: BotInstance = {
      id: index,
      connection,
      identityHex: '',
      ready: false,
      seq: 1,
      seed: 1337 + index * 97,
    };

    connection.subscriptionBuilder()
      .onApplied(async () => {
        bot.identityHex = identityHex;
        try {
          await connection.reducers.joinLobby({ name: botName });
          resolve(bot);
        } catch (err: any) {
          reject(new Error(`Bot ${index} join_lobby failed: ${err.message}`));
        }
      })
      .subscribe([
        tables.player,
        tables.match,
        tables.body,
        tables.inputFrame,
        tables.matchScore,
        tables.event,
      ]);
  });
}

// 1. Connect all bots to lobby
for (let i = 0; i < botCount; i++) {
  const bot = await createBot(i);
  bots.push(bot);
}

// 2. Host (bot 0) creates match or finds existing
const host = bots[0]!;
await host.connection.reducers.createMatch({});

// Wait for match creation to propagate
await new Promise<void>((resolve) => {
  const check = () => {
    const me = [...host.connection.db.player.iter()].find(
      (p) => p.id.toHexString() === host.identityHex
    );
    if (me && me.matchId !== undefined) {
      targetMatchId = me.matchId;
      const m = host.connection.db.match.id.find(targetMatchId);
      if (m) {
        targetMatchCode = m.code;
        resolve();
        return;
      }
    }
    setTimeout(check, 50);
  };
  check();
});

// 3. Other bots join the match
for (let i = 1; i < bots.length; i++) {
  const bot = bots[i]!;
  await bot.connection.reducers.joinMatch({ code: targetMatchCode });
}

// 4. All bots mark ready
for (const bot of bots) {
  await bot.connection.reducers.setReady({ ready: true });
}

// 5. Host starts match once all bots are ready
await new Promise<void>((resolve) => {
  const checkReady = () => {
    const playersInMatch = [...host.connection.db.player.iter()].filter(
      (p) => p.matchId === targetMatchId
    );
    if (playersInMatch.length >= botCount && playersInMatch.every((p) => p.ready)) {
      resolve();
      return;
    }
    setTimeout(checkReady, 50);
  };
  checkReady();
});

await host.connection.reducers.startMatch({});

function queryBodySql(label: string) {
  const out = execFileSync(
    'spacetime',
    [
      'sql',
      DATABASE,
      '--server',
      'local',
      `SELECT name, px, pz, last_seq, server_tick FROM body WHERE match_id = ${targetMatchId}`,
    ],
    { encoding: 'utf8' }
  );
  console.log(`\n--- ${label} ---\n${out.trim()}`);
}

if (idleCollisionMode) {
  await new Promise((resolve) => setTimeout(resolve, 3200));
  queryBodySql('Before collision (bot-0 idle, bot-1 walking into bot-0)');
}

let simultaneousDrawLogged = false;
let elimTickObserved: number | null = null;
let pauseTickStats = false;
const perTickTrace: Array<{ tick: number; intervalMs: number; status: string }> = [];
let timeoutRoundLogged = false;
let threePlayerScoreLogged = false;

function runSqlQuery(query: string): string {
  return execFileSync('spacetime', ['sql', DATABASE, '--server', 'local', query], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  }).trim();
}

// 6. Track ticks observed on the match table
host.connection.db.match.onUpdate((_ctx: any, _old: any, updatedMatch: any) => {
  if (targetMatchId !== undefined && updatedMatch.id === targetMatchId) {
    const now = performance.now();
    ticksObserved++;
    if (lastTickTime !== null && !pauseTickStats) {
      const intervalMs = now - lastTickTime;
      tickIntervalsMs.push(intervalMs);
      perTickTrace.push({
        tick: Number(updatedMatch.tick),
        intervalMs,
        status: updatedMatch.status,
      });
    }
    lastTickTime = now;

    if (simultaneousElimMode && updatedMatch.status === 'round_end' && !simultaneousDrawLogged) {
      simultaneousDrawLogged = true;
      elimTickObserved = Number(updatedMatch.tick);
      // Wait 5 ticks (~170ms) so ticks 121..124 are recorded without blocking the WS event loop,
      // then pause interval stats while execFileSync runs the SQL proof.
      setTimeout(() => {
        pauseTickStats = true;
        const matchSql = runSqlQuery(
          `SELECT id, status, round, score_a, score_b, tick FROM match WHERE id = ${targetMatchId}`
        );
        const bodySql = runSqlQuery(
          `SELECT id, name, px, pz, alive, elim_order, server_tick FROM body WHERE match_id = ${targetMatchId}`
        );
        const eventSql = runSqlQuery(
          `SELECT id, kind, x, z, tick FROM event WHERE match_id = ${targetMatchId}`
        );
        console.log(`\n--- Simultaneous Elimination Draw SQL (match) ---\n${matchSql}`);
        console.log(`\n--- Simultaneous Elimination Draw SQL (body) ---\n${bodySql}`);
        console.log(`\n--- Simultaneous Elimination Draw SQL (event) ---\n${eventSql}`);

        const windowTrace = perTickTrace.filter(
          (t) => elimTickObserved !== null && Math.abs(t.tick - elimTickObserved) <= 4
        );
        console.log('\n--- Per-tick intervals around elimination tick ---');
        for (const item of windowTrace) {
          const marker = item.tick === elimTickObserved ? ' <-- elimination tick' : '';
          console.log(
            `tick ${item.tick} (${item.status}): ${item.intervalMs.toFixed(2)} ms${marker}`
          );
        }
        setTimeout(() => {
          lastTickTime = null;
          pauseTickStats = false;
        }, 50);
      }, 170);
    }

    if (
      threePlayerScoreMode &&
      updatedMatch.status === 'round_end' &&
      updatedMatch.round === 3 &&
      !threePlayerScoreLogged
    ) {
      threePlayerScoreLogged = true;
      setTimeout(() => {
        pauseTickStats = true;
        const scoreSql = runSqlQuery(
          `SELECT id, match_id, owner, name, wins FROM match_score WHERE match_id = ${targetMatchId}`
        );
        const matchSql = runSqlQuery(
          `SELECT id, status, round, score_a, score_b, winner, tick FROM match WHERE id = ${targetMatchId}`
        );
        console.log(
          `\n--- Three-Player Identity Scoring SQL (match_score after Round 1 won by bot-0, Round 2 won by bot-2) ---\n${scoreSql}`
        );
        console.log(`\n--- Three-Player Identity Scoring SQL (match) ---\n${matchSql}\n`);
        setTimeout(() => {
          lastTickTime = null;
          pauseTickStats = false;
        }, 50);
      }, 50);
    }

    if (timeoutRoundMode && updatedMatch.status === 'round_end' && !timeoutRoundLogged) {
      timeoutRoundLogged = true;
      setTimeout(() => {
        pauseTickStats = true;
        const matchSql = runSqlQuery(
          `SELECT id, status, round, score_a, score_b, arena_radius, tick FROM match WHERE id = ${targetMatchId}`
        );
        const scoreSql = runSqlQuery(
          `SELECT id, match_id, owner, name, wins FROM match_score WHERE match_id = ${targetMatchId}`
        );
        const bodySql = runSqlQuery(
          `SELECT id, name, px, pz, alive, server_tick FROM body WHERE match_id = ${targetMatchId}`
        );
        const eventSql = runSqlQuery(
          `SELECT id, kind, a, x, z, tick FROM event WHERE match_id = ${targetMatchId}`
        );
        console.log(`\n--- 90s Timeout Round SQL (match) ---\n${matchSql}`);
        console.log(`\n--- 90s Timeout Round SQL (match_score) ---\n${scoreSql}`);
        console.log(`\n--- 90s Timeout Round SQL (body) ---\n${bodySql}`);
        console.log(`\n--- 90s Timeout Round SQL (event) ---\n${eventSql}\n`);
        setTimeout(() => {
          lastTickTime = null;
          pauseTickStats = false;
        }, 50);
      }, 50);
    }
  }
});

// 7. Input submission loop at 30 Hz per bot
const rngs = bots.map((b) => createRng(b.seed));
const startTime = performance.now();
const endTime = startTime + durationSeconds * 1000;

const botIntervals = bots.map((bot, index) => {
  const rng = rngs[index]!;
  return setInterval(() => {
    if (performance.now() >= endTime) return;
    if (idleCollisionMode && index === 0) return;

    const currentMatch =
      targetMatchId !== undefined ? bot.connection.db.match.id.find(targetMatchId) : undefined;
    if (!currentMatch || currentMatch.status !== 'playing') return;

    const bodiesInMatch = [...bot.connection.db.body.iter()].filter(
      (b: any) => b.matchId === targetMatchId
    );
    const myBody = bodiesInMatch.find((b: any) => b.owner.toHexString() === bot.identityHex);
    if (!myBody || !myBody.alive) return;

    let mx = 0;
    let mz = 0;
    let dash = false;
    if (idleCollisionMode) {
      const idleTarget = bodiesInMatch.find((b: any) => b.owner.toHexString() === host.identityHex);
      if (!idleTarget) return;
      const dx = idleTarget.px - myBody.px;
      const dz = idleTarget.pz - myBody.pz;
      const dist = Math.hypot(dx, dz) || 1;
      mx = dx / dist;
      mz = dz / dist;
    } else if (simultaneousElimMode) {
      mx = index === 0 ? 1 : -1;
      mz = 0;
    } else if (threePlayerScoreMode) {
      // Round 1: bot-0 stays inside, bot-1 and bot-2 walk outward.
      // Round 2: bot-2 stays inside, bot-0 and bot-1 walk outward.
      const designatedSurvivor = currentMatch.round === 1 ? 0 : 2;
      if (index === designatedSurvivor) {
        return;
      }
      const dist = Math.hypot(myBody.px, myBody.pz) || 1;
      mx = myBody.px / dist;
      mz = myBody.pz / dist;
    } else if (timeoutRoundMode) {
      // bot-0 parks near centre (0.5, 0); bot-1 parks at (-3.2, 0), both inside ARENA_R_END (5.0m)
      const targetX = index === 0 ? 0.5 : -3.2;
      const targetZ = 0;
      const dx = targetX - myBody.px;
      const dz = targetZ - myBody.pz;
      const dist = Math.hypot(dx, dz);
      if (dist < 0.15) {
        return;
      }
      mx = dx / dist;
      mz = dz / dist;
    } else {
      const distFromCenter = Math.hypot(myBody.px, myBody.pz);
      if (distFromCenter > currentMatch.arenaRadius * 0.65) {
        mx = -myBody.px / distFromCenter;
        mz = -myBody.pz / distFromCenter;
      } else {
        const angle = rng() * Math.PI * 2;
        mx = Math.cos(angle);
        mz = Math.sin(angle);
        dash = rng() > 0.75;
      }
    }

    bot.connection.reducers
      .submitInputs({ samples: [{ seq: bot.seq++, mx, mz, ax: mx, az: mz, dash }] })
      .then(() => {
        rowsWritten++;
      })
      .catch(() => {});
  }, 1000 / 30);
});

await new Promise((resolve) => setTimeout(resolve, durationSeconds * 1000));
for (const interval of botIntervals) clearInterval(interval);
await new Promise((resolve) => setTimeout(resolve, 300));

if (idleCollisionMode) {
  queryBodySql('After collision (bot-0 moved with last_seq = 0)');
}

// Count remaining input frames (verifies pruning)
const remainingInputFrames = [...host.connection.db.inputFrame.iter()].filter(
  (frame: any) => targetMatchId === undefined || frame.matchId === targetMatchId
).length;

const stats = computeStats(tickIntervalsMs);

console.log('--- Bots Simulation Results ---');
console.log(`ticks observed: ${ticksObserved}`);
console.log(
  `mean interval: ${stats.mean.toFixed(2)} ms, σ: ${stats.stdDev.toFixed(2)} ms`
);
console.log(`rows written: ${rowsWritten}`);
console.log(`input_frame row count: ${remainingInputFrames}`);

if (printMetrics) {
  console.log('\n--- Metrics Summary ---');
  console.log(`Bots Count:        ${botCount}`);
  console.log(`Duration:          ${durationSeconds} s`);
  console.log(`Tick Mean:         ${stats.mean.toFixed(2)} ms`);
  console.log(`Tick StdDev (σ):   ${stats.stdDev.toFixed(2)} ms`);
  console.log(`Total Rows Sent:   ${rowsWritten}`);
  console.log(`Remaining Queue:   ${remainingInputFrames} (pruned)`);
}

// Cleanup: disconnect all bots
for (const bot of bots) {
  bot.connection.disconnect();
}

process.exit(0);
