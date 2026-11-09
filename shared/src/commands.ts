/**
 * The command vocabulary.
 *
 * Every intent a body can have — a human at a keyboard or a CPU on the server — is
 * expressed as a Command, applied to the same executor, and turned into the same input
 * frame. Nothing else may reach the simulation, so a bot cannot move in a way a player
 * could not, and a new input device only has to learn this file.
 */

export type InputIntent = {
  mx: number;
  mz: number;
  ax: number;
  az: number;
  dash: boolean;
};

export type Command =
  /** Move intent. Held until replaced; magnitude is clamped to 1. */
  | { kind: 'steer'; mx: number; mz: number }
  /** Facing intent. Held until replaced; magnitude is clamped to 1. */
  | { kind: 'aim'; ax: number; az: number }
  /** Shove button: hold to charge, release to shove. */
  | { kind: 'charge'; hold: boolean };

export const IDLE_INTENT: InputIntent = { mx: 0, mz: 0, ax: 0, az: 0, dash: false };

const EPSILON = 0.001;

function clampUnit(x: number, y: number): [number, number] {
  if (!Number.isFinite(x) || !Number.isFinite(y)) return [0, 0];
  const length = Math.hypot(x, y);
  if (length < EPSILON) return [0, 0];
  const scale = length > 1 ? 1 / length : 1;
  return [x * scale, y * scale];
}

/** Apply one command to an intent. Pure; returns a new intent. */
export function applyCommand(intent: InputIntent, command: Command): InputIntent {
  switch (command.kind) {
    case 'steer': {
      const [mx, mz] = clampUnit(command.mx, command.mz);
      return { ...intent, mx, mz };
    }
    case 'aim': {
      const [ax, az] = clampUnit(command.ax, command.az);
      // A neutral aim command means "keep facing where you were", never "face nowhere".
      if (ax === 0 && az === 0) return intent;
      return { ...intent, ax, az };
    }
    case 'charge':
      return { ...intent, dash: command.hold };
    default:
      return intent;
  }
}

/** Apply a batch in order; later commands win, as a stick and a button do. */
export function applyCommands(intent: InputIntent, commands: readonly Command[]): InputIntent {
  let next = intent;
  for (const command of commands) {
    next = applyCommand(next, command);
  }
  return next;
}

/** The single producer of input frames. Clamps again: a frame must never carry junk. */
export function intentToFrame(intent: InputIntent): InputIntent {
  const [mx, mz] = clampUnit(intent.mx, intent.mz);
  const [ax, az] = clampUnit(intent.ax, intent.az);
  return { mx, mz, ax, az, dash: intent.dash };
}

/**
 * The executor every source shares: holds the current intent, applies a batch of commands,
 * and yields exactly one frame per tick.
 */
export type CommandExecutor = {
  apply: (commands: readonly Command[]) => InputIntent;
  frame: () => InputIntent;
  reset: () => void;
};

export function createCommandExecutor(): CommandExecutor {
  let intent: InputIntent = { ...IDLE_INTENT };
  return {
    apply(commands) {
      intent = applyCommands(intent, commands);
      return intent;
    },
    frame: () => intentToFrame(intent),
    reset() {
      intent = { ...IDLE_INTENT };
    },
  };
}
