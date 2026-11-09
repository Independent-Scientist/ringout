import { metrics } from './metrics';
import type { RenderTransform } from './prediction';

const RENDER_DELAY_MS = 100;
const MAX_EXTRAP_MS = 150;
const SNAP_THRESHOLD_M = 2.0;
const MAX_SNAPSHOTS = 32;

export type RemoteRowData = {
  id: bigint;
  px: number;
  pz: number;
  vx: number;
  vz: number;
  /** Knockback velocity; extrapolation needs total velocity, not just the stick's share. */
  kx?: number;
  kz?: number;
  aimX: number;
  aimZ: number;
  charge: number;
  alive: boolean;
  serverTick: bigint;
};

type Snapshot = {
  t: number;
  px: number;
  pz: number;
  vx: number;
  vz: number;
  aimX: number;
  aimZ: number;
  charge: number;
  alive: boolean;
};

type RemoteTrack = {
  snapshots: Snapshot[];
  renderX: number;
  renderZ: number;
  aimX: number;
  aimZ: number;
  charge: number;
  alive: boolean;
};

export type RemoteInterpolator = {
  pushSnapshot: (row: RemoteRowData, nowMs?: number) => void;
  removeBody: (id: bigint) => void;
  sample: (id: bigint, nowMs: number, dt: number) => RenderTransform | null;
  reset: () => void;
};

/**
 * Snapshot interpolator for remote bodies.
 * Renders at serverTime - 100 ms, lerps between bracketing snapshots,
 * extrapolates up to 150 ms, and snaps only when a state discontinuity exceeds 2 m.
 */
export function createRemoteInterpolator(): RemoteInterpolator {
  const tracks = new Map<string, RemoteTrack>();

  return {
    pushSnapshot(row: RemoteRowData, nowMs = performance.now()) {
      const velX = row.vx + (row.kx ?? 0);
      const velZ = row.vz + (row.kz ?? 0);
      const key = row.id.toString();
      let track = tracks.get(key);
      if (!track) {
        track = {
          snapshots: [
            {
              t: nowMs,
              px: row.px,
              pz: row.pz,
              vx: velX,
              vz: velZ,
              aimX: row.aimX,
              aimZ: row.aimZ,
              charge: row.charge,
              alive: row.alive,
            },
          ],
          renderX: row.px,
          renderZ: row.pz,
          aimX: row.aimX,
          aimZ: row.aimZ,
          charge: row.charge,
          alive: row.alive,
        };
        tracks.set(key, track);
        return;
      }

      const prev = track.snapshots[track.snapshots.length - 1];
      if (prev && !prev.alive && row.alive) {
        track.snapshots = [
          {
            t: nowMs,
            px: row.px,
            pz: row.pz,
            vx: velX,
            vz: velZ,
            aimX: row.aimX,
            aimZ: row.aimZ,
            charge: row.charge,
            alive: row.alive,
          },
        ];
        track.renderX = row.px;
        track.renderZ = row.pz;
        track.aimX = row.aimX;
        track.aimZ = row.aimZ;
        track.charge = row.charge;
        track.alive = row.alive;
        return;
      }

      if (prev) {
        const dtSec = Math.min(MAX_EXTRAP_MS, Math.max(0, nowMs - prev.t)) / 1000;
        const expectedX = prev.px + prev.vx * dtSec;
        const expectedZ = prev.pz + prev.vz * dtSec;
        const jumpError = Math.hypot(row.px - expectedX, row.pz - expectedZ);
        if (jumpError > SNAP_THRESHOLD_M) {
          metrics.recordSnap();
          track.snapshots = [
            {
              t: nowMs,
              px: row.px,
              pz: row.pz,
              vx: velX,
              vz: velZ,
              aimX: row.aimX,
              aimZ: row.aimZ,
              charge: row.charge,
              alive: row.alive,
            },
          ];
          track.renderX = row.px;
          track.renderZ = row.pz;
          track.aimX = row.aimX;
          track.aimZ = row.aimZ;
          track.charge = row.charge;
          track.alive = row.alive;
          return;
        }
      }

      const timestamp = prev && nowMs <= prev.t ? prev.t + 1 : nowMs;
      track.snapshots.push({
        t: timestamp,
        px: row.px,
        pz: row.pz,
        vx: velX,
        vz: velZ,
        aimX: row.aimX,
        aimZ: row.aimZ,
        charge: row.charge,
        alive: row.alive,
      });
      track.charge = row.charge;
      track.alive = row.alive;

      while (track.snapshots.length > MAX_SNAPSHOTS) {
        track.snapshots.shift();
      }
    },

    removeBody(id: bigint) {
      tracks.delete(id.toString());
    },

    sample(id: bigint, nowMs: number, _dt: number): RenderTransform | null {
      const track = tracks.get(id.toString());
      if (!track || track.snapshots.length === 0) return null;

      const targetTime = nowMs - RENDER_DELAY_MS;
      const snaps = track.snapshots;

      let before = snaps[0]!;
      let after: Snapshot | undefined;

      for (let i = 0; i < snaps.length; i++) {
        const current = snaps[i]!;
        if (current.t <= targetTime) {
          before = current;
        } else {
          after = current;
          break;
        }
      }

      let wantX = before.px;
      let wantZ = before.pz;
      let wantAimX = before.aimX;
      let wantAimZ = before.aimZ;

      if (after && after.t > before.t && targetTime >= before.t) {
        const k = Math.min(1, Math.max(0, (targetTime - before.t) / (after.t - before.t)));
        wantX = before.px + (after.px - before.px) * k;
        wantZ = before.pz + (after.pz - before.pz) * k;
        wantAimX = before.aimX + (after.aimX - before.aimX) * k;
        wantAimZ = before.aimZ + (after.aimZ - before.aimZ) * k;
      } else if (!after && targetTime > before.t) {
        const extrapMs = Math.min(MAX_EXTRAP_MS, targetTime - before.t);
        const extrapSec = extrapMs / 1000;
        wantX = before.px + before.vx * extrapSec;
        wantZ = before.pz + before.vz * extrapSec;
      }

      track.renderX = wantX;
      track.renderZ = wantZ;
      track.aimX = wantAimX;
      track.aimZ = wantAimZ;

      return {
        x: track.renderX,
        z: track.renderZ,
        aimX: track.aimX,
        aimZ: track.aimZ,
        charge: track.charge,
        alive: track.alive,
      };
    },

    reset() {
      tracks.clear();
    },
  };
}