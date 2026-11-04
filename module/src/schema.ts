import { schema, table, t } from 'spacetimedb/server';

/**
 * One row per connected client. Identity, name and colour are the join-time
 * fields; the match columns are declared here so later phases do not migrate the table.
 */
export const Player = table(
  { name: 'player', public: true },
  {
    id: t.identity().primaryKey(),
    name: t.string(),
    color: t.u8(),
    ready: t.bool(),
    match_id: t.option(t.u64()),
    connected_at: t.u64(),
    violations: t.u32(),
  }
);

/** Match state and best-of-three round phase machine. */
export const match = table(
  { name: 'match', public: true },
  {
    id: t.u64().primaryKey().autoInc(),
    code: t.string().index('btree'),
    status: t.string(), // lobby | countdown | playing | round_end | finished
    round: t.u8(),
    score_a: t.u8(),
    score_b: t.u8(),
    tick: t.u64(),
    started_at: t.u64(),
    countdown_ends: t.u64(),
    round_ends: t.u64(),
    arena_radius: t.f32(),
    winner: t.option(t.identity()),
  }
);

/** Server-authoritative physics body state per active player in a match. */
export const body = table(
  { name: 'body', public: true },
  {
    id: t.u64().primaryKey().autoInc(),
    match_id: t.u64().index('btree'),
    owner: t.identity().index('btree'),
    name: t.string(),
    color: t.u8(),
    px: t.f32(),
    pz: t.f32(),
    vx: t.f32(),
    vz: t.f32(),
    aim_x: t.f32(),
    aim_z: t.f32(),
    charge: t.f32(),
    alive: t.bool(),
    elim_order: t.u8(),
    last_seq: t.u32(),
    server_tick: t.u64(),
    cooldown_until: t.u64(),
    disconnected_at: t.u64(),
  }
);

/** Sequenced client input frames pending consumption by the tick reducer. */
export const inputFrame = table(
  { name: 'input_frame', public: true },
  {
    id: t.u64().primaryKey().autoInc(),
    match_id: t.u64().index('btree'),
    owner: t.identity().index('btree'),
    seq: t.u32(),
    mx: t.f32(),
    mz: t.f32(),
    ax: t.f32(),
    az: t.f32(),
    dash: t.bool(),
    applied: t.bool(),
  }
);

/** Per-player round win count within a match, keyed by (match_id, owner). */
export const matchScore = table(
  { name: 'match_score', public: true },
  {
    id: t.u64().primaryKey().autoInc(),
    match_id: t.u64().index('btree'),
    owner: t.identity().index('btree'),
    name: t.string(),
    wins: t.u8(),
  }
);

/** Transient server-authoritative events consumed by the client for FX and banners. */
export const event = table(
  { name: 'event', public: true },
  {
    id: t.u64().primaryKey().autoInc(),
    match_id: t.u64().index('btree'),
    kind: t.string(), // shove | hit | elim | round_end | match_end
    a: t.option(t.identity()),
    b: t.option(t.identity()),
    x: t.f32(),
    z: t.f32(),
    dx: t.f32(),
    dz: t.f32(),
    tick: t.u64(),
  }
);

/** Schedule table driving the authoritative 30 Hz tick loop per match. */
export const matchTick = table(
  { name: 'match_tick', public: true },
  {
    scheduled_id: t.u64().primaryKey().autoInc(),
    scheduled_at: t.scheduleAt(),
    match_id: t.u64().index('btree'),
  }
);

export const player = Player;
export const Match = match;
export const Body = body;
export const InputFrame = inputFrame;
export const MatchScore = matchScore;
export const Event = event;
export const MatchTick = matchTick;

/** The four robot colours, by index. Kept here so the server and the HUD agree. */
export const PLAYER_COLORS = ['cyan', 'magenta', 'violet', 'amber'] as const;

const spacetimedb = schema({
  Player,
  match,
  body,
  inputFrame,
  matchScore,
  event,
  matchTick,
});

export default spacetimedb;
