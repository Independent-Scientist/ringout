/**
 * All tuning numbers for RINGOUT live here.
 * No numeric literal other than 0, 1, 2 may appear in step.ts.
 */

// Timing and network rate
export const TICK_HZ = 30;
export const DT = 1 / TICK_HZ;
export const TICK_US = 33_333n;

// Player body dimensions and movement
export const PLAYER_R = 0.55;
export const MOVE_ACCEL = 10; // 1/s, velocity approach rate
export const MAX_SPEED = 6.5; // units/s
export const GROUND_FRICTION = 3.0; // 1/s when no input
export const RESTITUTION = 0.42;

// Shove mechanics
export const SHOVE_MIN = 5; // units/s of impulse, no charge
export const SHOVE_MAX = 17; // units/s of impulse, full charge
export const CHARGE_TIME = 0.45; // s to full charge
export const SHOVE_COOLDOWN = 0.7; // s
export const SELF_RECOIL = 0.25; // fraction of impulse applied backwards
export const SHOVE_MIN_CHARGE = 0.15;
export const SPEED_CAP_MULT = 2.5;

// Arena boundaries and shrinking
export const ARENA_R_START = 14;
export const ARENA_R_END = 5;
export const SHRINK_START_S = 10;
export const SHRINK_END_S = 80;
export const ELIM_MARGIN = 0.4; // beyond radius + margin = out
export const SPAWN_R_FACTOR = 0.6; // spawn bodies evenly on 0.6 * ARENA_R_START

// Match structure
export const COUNTDOWN_S = 3;
export const ROUND_CAP_S = 90;
export const ROUND_END_S = 5;
export const MATCH_END_S = 10;
export const ROUNDS_TO_WIN = 2;
export const EVENT_PRUNE_S = 5;
export const HIT_MIN_IMPULSE = 1.5;

// Numerical tolerances and queue limits
export const EPSILON = 0.001;
export const INPUT_QUEUE_CAP = 60;
export const DISCONNECT_GRACE_S = 15;
export const DISCONNECT_GRACE_US = 15_000_000n;
