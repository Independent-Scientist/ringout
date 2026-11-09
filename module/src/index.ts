import { Identity, ScheduleAt } from 'spacetimedb';
import { SenderError, t } from 'spacetimedb/server';
import spacetimedb, { PLAYER_COLORS } from './schema';
import * as C from '../../shared/src/constants';

export default spacetimedb;
export { tick } from './reducers/tick';

function suffixOf(identityHex: string): string {
  return identityHex.slice(-4);
}

function colorFor(identityHex: string): number {
  const lastByte = Number.parseInt(identityHex.slice(-2), 16);
  return Number.isNaN(lastByte) ? 0 : lastByte % PLAYER_COLORS.length;
}

function generateMatchCode(ctx: { random: () => number; db: any }): string {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  for (let attempt = 0; attempt < 10; attempt++) {
    let code = '';
    for (let i = 0; i < 4; i++) {
      const idx = Math.floor(ctx.random() * chars.length);
      code += chars[idx];
    }
    const matches = [...ctx.db.match.code.filter(code)];
    if (matches.length === 0) return code;
  }
  return 'PLAY';
}

export const init = spacetimedb.init(() => {
  console.info('ringout module initialised');
});

export const onConnect = spacetimedb.clientConnected((ctx) => {
  for (const b of ctx.db.body.owner.filter(ctx.sender)) {
    if (b.disconnected_at > 0n) {
      ctx.db.body.id.update({ ...b, disconnected_at: 0n });
    }
  }
  console.info(`client connected ${suffixOf(ctx.sender.toHexString())}`);
});

export const onDisconnect = spacetimedb.clientDisconnected((ctx) => {
  for (const input of ctx.db.inputFrame.owner.filter(ctx.sender)) {
    ctx.db.inputFrame.id.delete(input.id);
  }

  const bodies = [...ctx.db.body.owner.filter(ctx.sender)];
  if (bodies.length > 0) {
    const now = ctx.timestamp.microsSinceUnixEpoch;
    for (const b of bodies) {
      if (b.disconnected_at === 0n) {
        ctx.db.body.id.update({ ...b, disconnected_at: now });
      }
    }
    console.info(`player disconnected ${suffixOf(ctx.sender.toHexString())}, 15s grace started`);
    return;
  }

  const player = ctx.db.Player.id.find(ctx.sender);
  if (player) {
    console.info(`player left ${suffixOf(ctx.sender.toHexString())}`);
    ctx.db.Player.id.delete(ctx.sender);
  }
});

function sweepOrphans(ctx: any): void {
  const caller = ctx.db.Player.id.find(ctx.sender);
  const callerMatchId = caller?.match_id;

  // 1. Identify all finished matches (excluding caller's match if any)
  const finishedMatchIds = new Set<bigint>();
  for (const m of ctx.db.match.iter()) {
    if (m.status === 'finished' && m.id !== callerMatchId) {
      finishedMatchIds.add(m.id);
    }
  }

  // 2. Identify active valid matches: 'lobby', 'countdown', 'playing', 'round_end'
  const activeMatchIds = new Set<bigint>();
  for (const m of ctx.db.match.iter()) {
    if (
      m.status === 'lobby' ||
      m.status === 'countdown' ||
      m.status === 'playing' ||
      m.status === 'round_end'
    ) {
      activeMatchIds.add(m.id);
    }
  }

  // 3. Delete body, inputFrame, and event rows for finished matches or non-active matches
  const now = ctx.timestamp.microsSinceUnixEpoch;
  for (const b of ctx.db.body.iter()) {
    if (b.match_id === callerMatchId) continue;
    if (finishedMatchIds.has(b.match_id) || !activeMatchIds.has(b.match_id)) {
      if (b.disconnected_at > 0n) {
        ctx.db.Player.id.delete(b.owner);
      }
      ctx.db.body.id.delete(b.id);
    } else if (b.disconnected_at > 0n && now - b.disconnected_at >= C.DISCONNECT_GRACE_US) {
      ctx.db.Player.id.delete(b.owner);
      ctx.db.body.id.delete(b.id);
    }
  }

  for (const frame of ctx.db.inputFrame.iter()) {
    if (frame.match_id === callerMatchId) continue;
    if (finishedMatchIds.has(frame.match_id) || !activeMatchIds.has(frame.match_id)) {
      ctx.db.inputFrame.id.delete(frame.id);
    }
  }

  for (const ev of ctx.db.event.iter()) {
    if (ev.match_id === callerMatchId) continue;
    if (finishedMatchIds.has(ev.match_id) || !activeMatchIds.has(ev.match_id)) {
      ctx.db.event.id.delete(ev.id);
    }
  }

  // 4. Reset finished matches that have no scheduled ticks left to lobby,
  // clean up abandoned matches with no active connected players,
  // and prune redundant empty lobbies.
  for (const m of ctx.db.match.iter()) {
    if (m.id === callerMatchId) continue;
    if (m.status === 'finished') {
      const ticks = [...ctx.db.matchTick.match_id.filter(m.id)];
      if (ticks.length === 0) {
        ctx.db.match.id.update({
          ...m,
          status: 'lobby',
          round: 1,
          score_a: 0,
          score_b: 0,
          tick: 0n,
          countdown_ends: 0n,
          round_ends: 0n,
          arena_radius: C.ARENA_R_START,
          winner: undefined,
        });
      }
    } else if (
      m.status === 'playing' ||
      m.status === 'countdown' ||
      m.status === 'round_end'
    ) {
      const matchBodies = [...ctx.db.body.match_id.filter(m.id)];
      const matchPlayers = [...ctx.db.Player.iter()].filter((p) => p.match_id === m.id);
      const allBodiesDisconnected =
        matchBodies.length > 0 && matchBodies.every((b) => b.disconnected_at > 0n);
      const noPlayers = matchPlayers.length === 0;

      if (allBodiesDisconnected || noPlayers) {
        // Abandoned match with all players disconnected - clean up immediately
        for (const b of matchBodies) {
          ctx.db.body.id.delete(b.id);
          ctx.db.Player.id.delete(b.owner);
        }
        for (const sc of ctx.db.matchScore.match_id.filter(m.id)) {
          ctx.db.matchScore.id.delete(sc.id);
        }
        for (const frame of ctx.db.inputFrame.match_id.filter(m.id)) {
          ctx.db.inputFrame.id.delete(frame.id);
        }
        for (const ev of ctx.db.event.match_id.filter(m.id)) {
          ctx.db.event.id.delete(ev.id);
        }
        for (const sched of ctx.db.matchTick.match_id.filter(m.id)) {
          ctx.db.matchTick.scheduled_id.delete(sched.scheduled_id);
        }
        ctx.db.match.id.update({
          ...m,
          status: 'lobby',
          round: 1,
          score_a: 0,
          score_b: 0,
          tick: 0n,
          countdown_ends: 0n,
          round_ends: 0n,
          arena_radius: C.ARENA_R_START,
          winner: undefined,
        });
      }
    }
  }

  // Prune extra empty lobbies so clients all converge on a single lobby
  const emptyLobbies = [...ctx.db.match.iter()]
    .filter((m) => {
      if (m.status !== 'lobby' || m.id === callerMatchId) return false;
      const count = [...ctx.db.Player.iter()].filter((p) => p.match_id === m.id).length;
      return count === 0;
    })
    .sort((a, b) => Number(a.id - b.id));

  // Keep only the first empty lobby, delete the rest
  for (let i = 1; i < emptyLobbies.length; i++) {
    const extraLobby = emptyLobbies[i]!;
    for (const b of ctx.db.body.match_id.filter(extraLobby.id)) ctx.db.body.id.delete(b.id);
    for (const sc of ctx.db.matchScore.match_id.filter(extraLobby.id)) ctx.db.matchScore.id.delete(sc.id);
    for (const frame of ctx.db.inputFrame.match_id.filter(extraLobby.id)) ctx.db.inputFrame.id.delete(frame.id);
    for (const ev of ctx.db.event.match_id.filter(extraLobby.id)) ctx.db.event.id.delete(ev.id);
    for (const sched of ctx.db.matchTick.match_id.filter(extraLobby.id)) ctx.db.matchTick.scheduled_id.delete(sched.scheduled_id);
    ctx.db.match.id.delete(extraLobby.id);
  }

  // 5. Clear player.match_id/ready for players pointing at a match that is not lobby/countdown/playing/round_end
  for (const p of ctx.db.Player.iter()) {
    if (p.id.equals(ctx.sender)) continue;
    if (p.match_id !== undefined && !activeMatchIds.has(p.match_id)) {
      ctx.db.Player.id.update({
        ...p,
        match_id: undefined,
        ready: false,
      });
    }
  }
}

export const join_lobby = spacetimedb.reducer({ name: t.string() }, (ctx, { name }) => {
  sweepOrphans(ctx);
  const identityHex = ctx.sender.toHexString();
  const trimmed = name.trim().slice(0, 16);
  const fallbackName = `player-${suffixOf(identityHex)}`;
  const displayName = trimmed.length > 0 ? trimmed : fallbackName;

  const existing = ctx.db.Player.id.find(ctx.sender);
  if (existing) {
    ctx.db.Player.id.update({
      ...existing,
      name: displayName,
      connected_at: ctx.timestamp.microsSinceUnixEpoch,
    });
    return;
  }

  ctx.db.Player.insert({
    id: ctx.sender,
    name: displayName,
    color: colorFor(identityHex),
    ready: false,
    match_id: undefined,
    connected_at: ctx.timestamp.microsSinceUnixEpoch,
    violations: 0,
    is_bot: false,
  });
});

export const set_name = spacetimedb.reducer({ name: t.string() }, (ctx, { name }) => {
  const trimmed = name.trim().slice(0, 16);
  if (trimmed.length === 0) {
    throw new SenderError('name must not be empty');
  }

  const player = ctx.db.Player.id.find(ctx.sender);
  if (!player) {
    throw new SenderError('join the lobby before setting a name');
  }

  ctx.db.Player.id.update({ ...player, name: trimmed });
});

export const create_match = spacetimedb.reducer((ctx) => {
  sweepOrphans(ctx);
  const player = ctx.db.Player.id.find(ctx.sender);
  if (!player) {
    throw new SenderError('must join lobby before creating a match');
  }

  const code = generateMatchCode(ctx);
  const createdMatch = ctx.db.match.insert({
    id: 0n,
    code,
    status: 'lobby',
    round: 1,
    score_a: 0,
    score_b: 0,
    tick: 0n,
    started_at: ctx.timestamp.microsSinceUnixEpoch,
    countdown_ends: 0n,
    round_ends: 0n,
    arena_radius: C.ARENA_R_START,
    winner: undefined,
  });

  ctx.db.Player.id.update({
    ...player,
    match_id: createdMatch.id,
    ready: false,
  });
});

export const join_match = spacetimedb.reducer({ code: t.string() }, (ctx, { code }) => {
  sweepOrphans(ctx);
  const player = ctx.db.Player.id.find(ctx.sender);
  if (!player) {
    throw new SenderError('must join lobby before joining a match');
  }

  const normalizedCode = code.trim().toUpperCase();
  const targetMatch = [...ctx.db.match.code.filter(normalizedCode)].find(
    (m) => m.status === 'lobby'
  );
  if (!targetMatch) {
    throw new SenderError('match not found');
  }

  const playersInMatch = [...ctx.db.Player.iter()].filter((p) => p.match_id === targetMatch.id);
  if (playersInMatch.length >= 4) {
    throw new SenderError('match is full');
  }

  ctx.db.Player.id.update({
    ...player,
    match_id: targetMatch.id,
    ready: false,
  });
});

export const set_ready = spacetimedb.reducer({ ready: t.bool() }, (ctx, { ready }) => {
  const player = ctx.db.Player.id.find(ctx.sender);
  if (!player || player.match_id === undefined) {
    throw new SenderError('must be in a match to set ready');
  }

  const currentMatch = ctx.db.match.id.find(player.match_id);
  if (!currentMatch || currentMatch.status !== 'lobby') {
    throw new SenderError('can only set ready in lobby state');
  }

  ctx.db.Player.id.update({ ...player, ready });
});

/**
 * Synthetic identity for a CPU seat. Real identities are derived from a client's public
 * key, so a value built from a prefix, the match id and a slot can never collide with one,
 * and no client can ever connect as it.
 */
function botIdentityFor(matchId: bigint, slot: number): Identity {
  const hex = `b07${matchId.toString(16).padStart(8, '0')}${slot.toString(16).padStart(4, '0')}`;
  return Identity.fromString(hex.padEnd(64, '0'));
}

export const add_bot = spacetimedb.reducer((ctx) => {
  const player = ctx.db.Player.id.find(ctx.sender);
  if (!player || player.match_id === undefined) {
    throw new SenderError('must be in a match to add a CPU');
  }
  const currentMatch = ctx.db.match.id.find(player.match_id);
  if (!currentMatch || currentMatch.status !== 'lobby') {
    throw new SenderError('a CPU can only be added in the lobby');
  }

  const seated = [...ctx.db.Player.iter()].filter((p) => p.match_id === currentMatch.id);
  if (seated.length >= 4) {
    throw new SenderError('match is full');
  }

  let seat: Identity | undefined;
  for (let slot = 0; slot < 4; slot++) {
    const candidate = botIdentityFor(currentMatch.id, slot);
    if (!ctx.db.Player.id.find(candidate)) {
      seat = candidate;
      break;
    }
  }
  if (!seat) {
    throw new SenderError('no free CPU seat');
  }

  const takenColors = new Set(seated.map((p) => p.color));
  const colorIndex = PLAYER_COLORS.findIndex((_color, index) => !takenColors.has(index));
  const color = colorIndex >= 0 ? colorIndex : seated.length % PLAYER_COLORS.length;
  const seatNumber = seated.filter((p) => p.is_bot).length + 1;

  ctx.db.Player.insert({
    id: seat,
    name: `CPU ${seatNumber}`,
    color,
    ready: true,
    match_id: currentMatch.id,
    connected_at: ctx.timestamp.microsSinceUnixEpoch + BigInt(seatNumber),
    violations: 0,
    is_bot: true,
  });

  ctx.db.bot.insert({
    owner: seat,
    match_id: currentMatch.id,
    seed: Number.parseInt(seat.toHexString().slice(-8), 16) >>> 0,
    target_id: 0n,
    release_at_tick: 0n,
    hold_started_tick: 0n,
  });
});

export const remove_bot = spacetimedb.reducer((ctx) => {
  const player = ctx.db.Player.id.find(ctx.sender);
  if (!player || player.match_id === undefined) {
    throw new SenderError('must be in a match to remove a CPU');
  }
  const currentMatch = ctx.db.match.id.find(player.match_id);
  if (!currentMatch || currentMatch.status !== 'lobby') {
    throw new SenderError('a CPU can only be removed in the lobby');
  }

  const bots = [...ctx.db.Player.iter()]
    .filter((p) => p.match_id === currentMatch.id && p.is_bot)
    .sort((a, b) => (a.connected_at < b.connected_at ? 1 : -1));
  const last = bots[0];
  if (!last) {
    throw new SenderError('no CPU to remove');
  }

  ctx.db.bot.owner.delete(last.id);
  ctx.db.Player.id.delete(last.id);
});

export const start_match = spacetimedb.reducer((ctx) => {
  const player = ctx.db.Player.id.find(ctx.sender);
  if (!player || player.match_id === undefined) {
    throw new SenderError('must be in a match to start');
  }

  const currentMatch = ctx.db.match.id.find(player.match_id);
  if (!currentMatch || currentMatch.status !== 'lobby') {
    throw new SenderError('match cannot be started');
  }

  const players = [...ctx.db.Player.iter()]
    .filter((p) => p.match_id === currentMatch.id)
    .sort((a, b) =>
      a.connected_at !== b.connected_at
        ? a.connected_at < b.connected_at
          ? -1
          : 1
        : a.id.toHexString().localeCompare(b.id.toHexString())
    );

  const caller = players.find((p) => p.id.equals(ctx.sender));
  if (!caller) {
    throw new SenderError('must be in this match to start it');
  }
  const readyPlayers = players.filter((p) => p.ready);
  // Any ready player may start, not only the host: an untouched host tab must
  // never be able to hold a lobby of willing players hostage.
  if (!caller.ready) {
    throw new SenderError('ready up before starting the match');
  }
  if (readyPlayers.length < 2) {
    throw new SenderError('at least two ready players required to start match');
  }

  // Players who did not ready are benched instead of blocking the match.
  // A stale tab or an idle friend must never hold the lobby hostage.
  for (const benched of players) {
    if (benched.ready) {
      continue;
    }
    ctx.db.Player.id.update({ ...benched, match_id: undefined, ready: false });
  }

  for (const oldScore of ctx.db.matchScore.match_id.filter(currentMatch.id)) {
    ctx.db.matchScore.id.delete(oldScore.id);
  }

  const spawnRadius = C.SPAWN_R_FACTOR * C.ARENA_R_START;
  for (let idx = 0; idx < readyPlayers.length; idx++) {
    const member = readyPlayers[idx]!;
    const angle = (2 * Math.PI * idx) / readyPlayers.length;
    const px = Math.cos(angle) * spawnRadius;
    const pz = Math.sin(angle) * spawnRadius;
    const aimX = -Math.cos(angle);
    const aimZ = -Math.sin(angle);

    ctx.db.body.insert({
      id: 0n,
      match_id: currentMatch.id,
      owner: member.id,
      name: member.name,
      color: member.color,
      px,
      pz,
      vx: 0,
      vz: 0,
      kx: 0,
      kz: 0,
      aim_x: aimX,
      aim_z: aimZ,
      charge: 0,
      alive: true,
      elim_order: 0,
      last_seq: 0,
      server_tick: 0n,
      cooldown_until: 0n,
      disconnected_at: 0n,
    });

    ctx.db.matchScore.insert({
      id: 0n,
      match_id: currentMatch.id,
      owner: member.id,
      name: member.name,
      wins: 0,
    });
  }

  const countdownTicks = BigInt(C.COUNTDOWN_S * C.TICK_HZ);
  const roundCapTicks = BigInt(C.ROUND_CAP_S * C.TICK_HZ);

  ctx.db.match.id.update({
    ...currentMatch,
    status: 'countdown',
    round: 1,
    score_a: 0,
    score_b: 0,
    tick: 0n,
    started_at: ctx.timestamp.microsSinceUnixEpoch,
    countdown_ends: countdownTicks,
    round_ends: countdownTicks + roundCapTicks,
    arena_radius: C.ARENA_R_START,
    winner: undefined,
  });

  ctx.db.matchTick.insert({
    scheduled_id: 0n,
    scheduled_at: ScheduleAt.interval(C.TICK_US),
    match_id: currentMatch.id,
  });
});

export const rematch = spacetimedb.reducer((ctx) => {
  const player = ctx.db.Player.id.find(ctx.sender);
  if (!player || player.match_id === undefined) {
    throw new SenderError('must be in a match to request a rematch');
  }

  const currentMatch = ctx.db.match.id.find(player.match_id);
  if (!currentMatch || currentMatch.status !== 'finished') {
    throw new SenderError('rematch is only available after the match finishes');
  }

  for (const b of ctx.db.body.match_id.filter(currentMatch.id)) {
    if (b.disconnected_at > 0n) {
      ctx.db.Player.id.delete(b.owner);
    }
    ctx.db.body.id.delete(b.id);
  }
  for (const sc of ctx.db.matchScore.match_id.filter(currentMatch.id)) {
    ctx.db.matchScore.id.delete(sc.id);
  }
  for (const frame of ctx.db.inputFrame.match_id.filter(currentMatch.id)) {
    ctx.db.inputFrame.id.delete(frame.id);
  }
  for (const ev of ctx.db.event.match_id.filter(currentMatch.id)) {
    ctx.db.event.id.delete(ev.id);
  }
  for (const sched of ctx.db.matchTick.match_id.filter(currentMatch.id)) {
    ctx.db.matchTick.scheduled_id.delete(sched.scheduled_id);
  }

  for (const p of ctx.db.Player.iter()) {
    if (p.match_id === currentMatch.id) {
      ctx.db.Player.id.update({ ...p, ready: false });
    }
  }

  ctx.db.match.id.update({
    ...currentMatch,
    status: 'lobby',
    round: 1,
    score_a: 0,
    score_b: 0,
    tick: 0n,
    countdown_ends: 0n,
    round_ends: 0n,
    arena_radius: C.ARENA_R_START,
    winner: undefined,
  });
});

/**
 * Input arrives in small batches: the current frame plus the previous one.
 * A dropped packet therefore costs nothing — the next call carries the missing
 * frame again, and a duplicate is skipped by seq instead of being counted as a
 * violation, because resending is the expected behaviour.
 */
const InputSample = t.object('InputSample', {
  seq: t.u32(),
  mx: t.f32(),
  mz: t.f32(),
  ax: t.f32(),
  az: t.f32(),
  dash: t.bool(),
});

const MAX_SAMPLES_PER_CALL = 4;

export const submit_inputs = spacetimedb.reducer(
  { samples: t.array(InputSample) },
  (ctx, { samples }) => {
    const player = ctx.db.Player.id.find(ctx.sender);
    const recordViolation = (reason: string) => {
      if (player) {
        ctx.db.Player.id.update({ ...player, violations: player.violations + 1 });
      }
      console.warn(`input rejected (${suffixOf(ctx.sender.toHexString())}): ${reason}`);
    };

    if (!player || player.match_id === undefined) {
      recordViolation('not in an active match');
      return;
    }

    if (samples.length === 0) {
      return;
    }
    if (samples.length > MAX_SAMPLES_PER_CALL) {
      recordViolation('too many samples in one call');
      return;
    }

    const currentMatch = ctx.db.match.id.find(player.match_id);
    if (!currentMatch || currentMatch.status === 'lobby' || currentMatch.status === 'finished') {
      recordViolation('match is not accepting inputs');
      return;
    }

    const playerBody = [...ctx.db.body.owner.filter(ctx.sender)].find(
      (b) => b.match_id === player.match_id && (b.alive || currentMatch.status === 'round_end')
    );
    if (!playerBody) {
      recordViolation('no active body in match');
      return;
    }

    const pendingSeqs = new Set(
      [...ctx.db.inputFrame.owner.filter(ctx.sender)]
        .filter((frame) => frame.match_id === player.match_id && !frame.applied)
        .map((frame) => frame.seq)
    );

    let lastAccepted = playerBody.last_seq;
    let queued = pendingSeqs.size;

    for (const sample of [...samples].sort((a, b) => a.seq - b.seq)) {
      if (sample.seq <= lastAccepted || pendingSeqs.has(sample.seq)) {
        continue;
      }

      if (queued >= C.INPUT_QUEUE_CAP) {
        recordViolation('input queue capacity exceeded');
        break;
      }

      let moveX = sample.mx;
      let moveZ = sample.mz;
      const moveLen = Math.hypot(moveX, moveZ);
      if (moveLen > 1) {
        moveX /= moveLen;
        moveZ /= moveLen;
      }

      let aimX = sample.ax;
      let aimZ = sample.az;
      const aimLen = Math.hypot(aimX, aimZ);
      if (aimLen > 1) {
        aimX /= aimLen;
        aimZ /= aimLen;
      }

      ctx.db.inputFrame.insert({
        id: 0n,
        match_id: player.match_id,
        owner: ctx.sender,
        seq: sample.seq,
        mx: moveX,
        mz: moveZ,
        ax: aimX,
        az: aimZ,
        dash: sample.dash,
        applied: false,
      });

      pendingSeqs.add(sample.seq);
      lastAccepted = sample.seq;
      queued += 1;
    }
  }
);
