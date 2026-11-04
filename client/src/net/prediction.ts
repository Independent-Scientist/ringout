import { stepBody, type BodyState, type InputFrame } from '@sim/sim/step';
import { ARENA_R_START, DT, SHOVE_MIN_CHARGE } from '../../../shared/src/constants';
import { metrics } from './metrics';

const RING_CAPACITY = 128;
const CORRECTION_THRESHOLD_M = 0.02;

export type PendingInput = InputFrame & {
  seq: number;
  dt: number;
  frozen: boolean;
};

export type ServerBodySnapshot = {
  id: bigint;
  px: number;
  pz: number;
  vx: number;
  vz: number;
  aimX: number;
  aimZ: number;
  charge: number;
  alive: boolean;
  elimOrder: number;
  lastSeq: number;
  serverTick: bigint;
  cooldownUntil: bigint;
};

export type RenderTransform = {
  x: number;
  z: number;
  aimX: number;
  aimZ: number;
  charge: number;
  alive: boolean;
};

class InputRingBuffer {
  private readonly buffer: Array<PendingInput | undefined> = new Array(RING_CAPACITY);
  private head = 0;
  private count = 0;

  get size(): number {
    return this.count;
  }

  push(item: PendingInput): void {
    const writeIndex = (this.head + this.count) % RING_CAPACITY;
    this.buffer[writeIndex] = item;
    if (this.count < RING_CAPACITY) {
      this.count += 1;
    } else {
      this.head = (this.head + 1) % RING_CAPACITY;
    }
  }

  dropUpTo(ackSeq: number): void {
    while (this.count > 0) {
      const oldest = this.buffer[this.head];
      if (!oldest || oldest.seq > ackSeq) break;
      this.buffer[this.head] = undefined;
      this.head = (this.head + 1) % RING_CAPACITY;
      this.count -= 1;
    }
  }

  forEach(callback: (item: PendingInput) => void): void {
    for (let i = 0; i < this.count; i++) {
      const item = this.buffer[(this.head + i) % RING_CAPACITY];
      if (item) callback(item);
    }
  }

  clear(): void {
    this.buffer.fill(undefined);
    this.head = 0;
    this.count = 0;
  }
}

function fromRow(row: ServerBodySnapshot): BodyState {
  return {
    px: row.px,
    pz: row.pz,
    vx: row.vx,
    vz: row.vz,
    aim_x: row.aimX,
    aim_z: row.aimZ,
    charge: row.charge,
    alive: row.alive,
    elim_order: row.elimOrder,
    cooldown_until: row.cooldownUntil,
    server_tick: row.serverTick,
  };
}

export type PredictionController = {
  reset: (initialRow?: ServerBodySnapshot) => void;
  stepLocal: (input: InputFrame, dt: number, arenaRadius?: number, frozen?: boolean) => void;
  commitSentInput: (
    seq: number,
    input: InputFrame,
    arenaRadius?: number,
    frozen?: boolean
  ) => void;
  reconcile: (row: ServerBodySnapshot, arenaRadius?: number, isContact?: boolean) => void;
  decayOffset: (dt: number) => void;
  getRenderTransform: () => RenderTransform | null;
  getPendingCount: () => number;
  /** True when a shove released right now would pass the local cooldown/charge gate. */
  canShove: () => boolean;
};

/**
 * Own-body client prediction and server reconciliation controller.
 * Keeps simulation state strictly separate from the decaying render-only visualOffset.
 */
export function createPredictionController(): PredictionController {
  const pendingRing = new InputRingBuffer();
  let initialized = false;
  let canonical: BodyState = {
    px: 0,
    pz: 0,
    vx: 0,
    vz: 0,
    aim_x: 0,
    aim_z: -1,
    charge: 0,
    alive: false,
    elim_order: 0,
    cooldown_until: 0n,
    server_tick: 0n,
  };
  let self: BodyState = { ...canonical };
  let subStep: { input: InputFrame; dt: number; frozen: boolean } | null = null;
  const visualOffset = { x: 0, z: 0 };

  return {
    reset(initialRow?: ServerBodySnapshot) {
      pendingRing.clear();
      subStep = null;
      visualOffset.x = 0;
      visualOffset.z = 0;
      if (initialRow) {
        canonical = fromRow(initialRow);
        self = { ...canonical };
        initialized = true;
      } else {
        initialized = false;
      }
    },

    stepLocal(input: InputFrame, dt: number, arenaRadius = ARENA_R_START, frozen = false) {
      if (!initialized || !canonical.alive) return;
      const accumulatedDt = subStep ? Math.min(DT, subStep.dt + dt) : Math.min(DT, dt);
      subStep = { input, dt: accumulatedDt, frozen };
      const next = stepBody(
        canonical,
        input,
        accumulatedDt,
        arenaRadius,
        canonical.server_tick + 1n,
        frozen
      );
      // Never predict own elimination on the client; server row is authoritative.
      self = { ...next, alive: canonical.alive };
    },

    commitSentInput(
      seq: number,
      input: InputFrame,
      arenaRadius = ARENA_R_START,
      frozen = false
    ) {
      if (!initialized || !canonical.alive) return;
      pendingRing.push({ ...input, seq, dt: DT, frozen });
      const next = stepBody(
        canonical,
        input,
        DT,
        arenaRadius,
        canonical.server_tick + 1n,
        frozen
      );
      canonical = { ...next, alive: canonical.alive };
      subStep = null;
      self = { ...canonical };
    },

    reconcile(row: ServerBodySnapshot, arenaRadius = ARENA_R_START, isContact = false) {
      if (!initialized || (row.serverTick === 0n && row.lastSeq === 0 && pendingRing.size === 0)) {
        pendingRing.clear();
        subStep = null;
        visualOffset.x = 0;
        visualOffset.z = 0;
        canonical = fromRow(row);
        self = { ...canonical };
        initialized = true;
        return;
      }

      if (!row.alive) {
        pendingRing.clear();
        subStep = null;
        visualOffset.x = 0;
        visualOffset.z = 0;
        canonical = fromRow(row);
        self = { ...canonical };
        return;
      }

      pendingRing.dropUpTo(row.lastSeq);

      let replayed = fromRow(row);
      pendingRing.forEach((item) => {
        const next = stepBody(
          replayed,
          item,
          item.dt,
          arenaRadius,
          replayed.server_tick + 1n,
          item.frozen
        );
        replayed = { ...next, alive: row.alive };
      });

      const replayedNow = subStep
        ? {
            ...stepBody(
              replayed,
              subStep.input,
              subStep.dt,
              arenaRadius,
              replayed.server_tick + 1n,
              subStep.frozen
            ),
            alive: row.alive,
          }
        : replayed;

      const err = Math.hypot(replayedNow.px - self.px, replayedNow.pz - self.pz);
      if (err > CORRECTION_THRESHOLD_M) {
        const beforeX = self.px;
        const beforeZ = self.pz;
        metrics.recordCorrection(err, pendingRing.size, isContact ? 'contact' : 'ack');
        canonical = replayed;
        self = replayedNow;
        visualOffset.x += beforeX - self.px;
        visualOffset.z += beforeZ - self.pz;
      }
    },

    decayOffset(dt: number) {
      const factor = Math.pow(0.85, dt * 60);
      visualOffset.x *= factor;
      visualOffset.z *= factor;
    },

    getRenderTransform(): RenderTransform | null {
      if (!initialized) return null;
      return {
        x: self.px + visualOffset.x,
        z: self.pz + visualOffset.z,
        aimX: self.aim_x,
        aimZ: self.aim_z,
        charge: self.charge,
        alive: self.alive,
      };
    },

    getPendingCount: () => pendingRing.size,

    canShove: () =>
      initialized &&
      canonical.alive &&
      canonical.charge >= SHOVE_MIN_CHARGE &&
      canonical.server_tick >= canonical.cooldown_until,
  };
}
