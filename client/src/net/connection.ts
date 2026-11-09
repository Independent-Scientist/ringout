import { ARENA_R_START, DT, TICK_HZ } from '../../../shared/src/constants';
import { DbConnection, tables } from '../module_bindings';
import type { Body } from '../module_bindings/types';
import { colorCssForIndex } from '../render/bodies';
import type { ScoreEntry } from '../ui/hud';
import { sampleAutopilotInput, type InputState } from './input';
import type { RemoteInterpolator } from './interpolation';
import { startTicker, type LatencyShim } from './latency';
import { metrics } from './metrics';
import type { PredictionController, ServerBodySnapshot } from './prediction';

const SERVER_URI = import.meta.env.VITE_ST_URI ?? 'ws://127.0.0.1:3000';
const DATABASE = import.meta.env.VITE_ST_DB ?? 'ringout-dev';

const PARAMS = new URLSearchParams(location.search);
const SLOT = PARAMS.get('slot') ?? 'default';
const URL_NAME = PARAMS.get('name')?.trim().slice(0, 12) ?? '';
const BRAWL_MODE = PARAMS.get('brawl') === '1';
const MIN_PLAYERS = Math.max(
  2,
  Number.parseInt(PARAMS.get('players') ?? (BRAWL_MODE ? '4' : '2'), 10) || (BRAWL_MODE ? 4 : 2)
);
const TOKEN_KEY = `${SERVER_URI}/${DATABASE}/auth_token/${SLOT}`;
const NAME_KEY = `${SERVER_URI}/${DATABASE}/player_name/${SLOT}`;

export type LobbyInfo = {
  isHost: boolean;
  canStart: boolean;
  isReady: boolean;
  readyCount: number;
  totalCount: number;
  minPlayers: number;
  maxPlayers: number;
  cpuCount: number;
  hostName: string;
};

export type ConnectionHandlers = {
  onStatus: (status: string) => void;
  onIdentity: (identity: string) => void;
  onYou: (name: string, colorCss: string, inLobby: boolean, isHost?: boolean) => void;
  onPlayers: (count: number, readyCount?: number, inLobby?: boolean) => void;
  onMetricsUpdate: () => void;
  onSpectator: () => void;
  onArenaRadius: (radius: number) => void;
  onGameEvent: (
    kind: string,
    x: number,
    z: number,
    dx: number,
    dz: number,
    actorHex?: string,
    targetHex?: string
  ) => void;
  /** Fired the instant the local player releases a charged shove, before the server confirms it. */
  onLocalShove?: (x: number, z: number, dx: number, dz: number) => void;
  onMatchUpdate: (
    matchCode: string,
    matchStatus: string,
    isHost: boolean,
    canStart: boolean,
    isReady: boolean,
    round: number,
    scoreEntries: ReadonlyArray<ScoreEntry>,
    bannerText: string,
    bannerColorCss?: string,
    lobbyInfo?: LobbyInfo
  ) => void;
  onEnsureBody: (
    id: bigint,
    colorIndex: number,
    name: string,
    isSelf: boolean,
    px: number,
    pz: number
  ) => number;
  onRemoveBody: (id: bigint) => void;
};

export type ActiveConnection = {
  connection: DbConnection;
  setSampledInput: (input: InputState) => void;
  stepFixed: (dt: number) => void;
  setName: (name: string) => void;
  toggleReady: () => void;
  startMatch: () => void;
  rematch: () => void;
  /** Seat a server-side CPU opponent in the lobby. */
  addBot: () => void;
  /** Remove the most recently seated CPU. */
  removeBot: () => void;
  getMyIdentity: () => string;
  isAutopilot: () => boolean;
};

type AutopilotConfig = {
  latencyMs: number;
  durationSec: number;
  chaosPercent: number;
  pin: boolean;
};

function parseAutopilot(): AutopilotConfig | null {
  const rawLat = PARAMS.get('autopilot');
  if (rawLat === null && !BRAWL_MODE) return null;
  const parsedLat = Number.parseInt(rawLat ?? '0', 10);
  const latencyMs = Number.isNaN(parsedLat) ? 0 : parsedLat;
  const rawSec = PARAMS.get('seconds');
  const parsedSec = rawSec ? Number.parseInt(rawSec, 10) : 30;
  const durationSec = Number.isNaN(parsedSec) || parsedSec <= 0 ? 30 : parsedSec;
  const rawChaos = PARAMS.get('chaos');
  const parsedChaos = rawChaos ? Number.parseFloat(rawChaos) : 0;
  const chaosPercent = Number.isNaN(parsedChaos) ? 0 : Math.max(0, Math.min(100, parsedChaos));
  const pin = PARAMS.get('pin') === '1' || PARAMS.get('pin') === 'true';
  return { latencyMs, durationSec, chaosPercent, pin };
}

function toBodySnapshot(row: Body): ServerBodySnapshot {
  return {
    id: row.id,
    px: row.px,
    pz: row.pz,
    vx: row.vx,
    vz: row.vz,
    kx: row.kx,
    kz: row.kz,
    aimX: row.aimX,
    aimZ: row.aimZ,
    charge: row.charge,
    alive: row.alive,
    elimOrder: row.elimOrder,
    lastSeq: row.lastSeq,
    serverTick: row.serverTick,
    cooldownUntil: row.cooldownUntil,
  };
}

export function connect(
  handlers: ConnectionHandlers,
  latency: LatencyShim,
  prediction: PredictionController,
  interpolator: RemoteInterpolator
): ActiveConnection {
  const autopilot = parseAutopilot();
  let playerName = '';
  let myIdentityHex = '';
  let nextSeq = 1;
  let lastAckedSeq = 0;
  let previousSample: { seq: number; mx: number; mz: number; ax: number; az: number; dash: boolean } | null =
    null;
  let wasDashHeld = false;
  let isSubscribed = false;
  let hasAliveSelfBody = false;
  let currentMatchId: bigint | undefined;
  let currentMatchStatus = 'none';
  let currentArenaRadius = ARENA_R_START;
  let lastRoundWinnerHex: string | undefined;
  let lastSampledInput: InputState = { mx: 0, mz: 0, ax: 0, az: -1, dash: false };

  const ownerColorIndex = new Map<string, number>();

  let autopilotTicks = 0;
  let roundPlayingTicks = 0;
  let currentRoundNumber = 1;
  let autopilotSpawnAngle = 0;
  let autopilotStartedAt: number | null = null;
  let autopilotPrinted = false;
  let readyInFlight = false;
  let startInFlight = false;
  let tickerCount = 0;
  let lastContactAtMs = -10000;
  let spawnedInPagePeers = false;
  let chaosActive = (autopilot?.chaosPercent ?? 0) > 0;
  let chaosSeed = 0x13579bdf;
  const chaosStallQueue: Array<() => void> = [];

  function flushChaosStallQueue() {
    while (chaosStallQueue.length > 0) {
      const sendFn = chaosStallQueue.shift();
      if (sendFn) sendFn();
    }
  }

  if (autopilot) {
    latency.setLatencyMs(autopilot.latencyMs);
    metrics.setLatencyMs(autopilot.latencyMs);
    if (autopilot.pin) {
      handlers.onSpectator();
    }
  }

  const connection = DbConnection.builder()
    .withUri(SERVER_URI)
    .withDatabaseName(DATABASE)
    .withToken(
      sessionStorage.getItem(TOKEN_KEY) ??
        (SLOT !== 'default' ? localStorage.getItem(TOKEN_KEY) : undefined) ??
        undefined
    )
    .withAutomaticReconnect()
    .onConnect((_ctx, identity, token) => {
      sessionStorage.setItem(TOKEN_KEY, token);
      if (SLOT !== 'default') {
        localStorage.setItem(TOKEN_KEY, token);
      }
      myIdentityHex = identity.toHexString();
      const storedName =
        sessionStorage.getItem(NAME_KEY)?.trim().slice(0, 12) ??
        localStorage.getItem(NAME_KEY)?.trim().slice(0, 12) ??
        '';
      playerName = URL_NAME || storedName || `player-${myIdentityHex.slice(-4)}`;
      handlers.onIdentity(myIdentityHex);
      handlers.onStatus('connected');
    })
    .onConnectError((_ctx, error) => handlers.onStatus(`connect error: ${error.message}`))
    .onDisconnect((_ctx, error) =>
      handlers.onStatus(error ? `disconnected: ${error.message}` : 'disconnected')
    )
    .build();

  const reportPlayerCount = () => handlers.onPlayers([...connection.db.player.iter()].length);

  function nameForIdentity(identityHex: string | undefined): string {
    if (!identityHex) return 'Player';
    const player = [...connection.db.player.iter()].find(
      (p) => p.id.toHexString() === identityHex
    );
    if (player) return player.name.slice(0, 12);
    const bodyRow = [...connection.db.body.iter()].find(
      (b) => b.owner.toHexString() === identityHex
    );
    if (bodyRow) return bodyRow.name.slice(0, 12);
    const scoreRow = [...connection.db.matchScore.iter()].find(
      (s) => s.owner.toHexString() === identityHex
    );
    return scoreRow ? scoreRow.name.slice(0, 12) : `player-${identityHex.slice(-4)}`;
  }

  function colorIndexForIdentity(identityHex: string | undefined, fallbackColor = 0): number {
    if (!identityHex) return 0;
    const mapped = ownerColorIndex.get(identityHex);
    if (mapped !== undefined) return mapped;
    return Math.abs(fallbackColor) % 4;
  }

  function refreshPaletteAssignments(matchId: bigint) {
    const matchPlayers = [...connection.db.player.iter()]
      .filter((p) => p.matchId === matchId)
      .sort((a, b) => Number(a.connectedAt - b.connectedAt));
    for (let i = 0; i < matchPlayers.length; i++) {
      const hex = matchPlayers[i]!.id.toHexString();
      if (!ownerColorIndex.has(hex)) {
        ownerColorIndex.set(hex, i % 4);
      }
    }
    const bodies = [...connection.db.body.iter()]
      .filter((b) => b.matchId === matchId)
      .sort((a, b) => Number(a.id - b.id));
    for (let i = 0; i < bodies.length; i++) {
      const hex = bodies[i]!.owner.toHexString();
      if (!ownerColorIndex.has(hex)) {
        ownerColorIndex.set(hex, i % 4);
      }
    }
  }

  function checkMatchState() {
    if (!myIdentityHex) return;
    const me = [...connection.db.player.iter()].find((p) => p.id.toHexString() === myIdentityHex);
    const myDisplayName = me ? me.name.slice(0, 12) : playerName;

    if (!me || me.matchId === undefined) {
      currentMatchId = undefined;
      currentMatchStatus = 'none';
      for (const b of connection.db.body.iter()) {
        handlers.onRemoveBody(b.id);
      }
      handlers.onYou(myDisplayName, colorCssForIndex(me?.color ?? 0), true);
      handlers.onMatchUpdate('', 'none', false, false, false, 1, [], '');
      return;
    }

    const currentMatch = [...connection.db.match.iter()].find((m) => m.id === me.matchId);
    if (!currentMatch) return;
    const matchChanged = currentMatchId !== currentMatch.id;
    currentMatchId = currentMatch.id;
    currentMatchStatus = currentMatch.status;
    currentRoundNumber = currentMatch.round;
    currentArenaRadius = currentMatch.arenaRadius;
    handlers.onArenaRadius(currentMatch.arenaRadius);

    if (matchChanged) {
      for (const b of connection.db.body.iter()) {
        if (b.matchId === currentMatchId) {
          handleBodyRow(b, true);
        } else {
          handlers.onRemoveBody(b.id);
        }
      }
    }

    refreshPaletteAssignments(currentMatch.id);
    const myColorIdx = colorIndexForIdentity(myIdentityHex, me.color);
    const inLobby = currentMatch.status === 'lobby';

    const matchPlayers = [...connection.db.player.iter()]
      .filter((p) => p.matchId === currentMatch.id)
      .sort((a, b) =>
        a.connectedAt !== b.connectedAt
          ? a.connectedAt < b.connectedAt
            ? -1
            : 1
          : a.id.toHexString().localeCompare(b.id.toHexString())
      );

    const host = matchPlayers[0];
    const isHost = host?.id.toHexString() === myIdentityHex;
    const readyCount = matchPlayers.filter((p) => p.ready).length;
    const totalCount = matchPlayers.length;
    const cpuCount = matchPlayers.filter((p) => p.isBot).length;
    // Any ready player can start once the minimum is met; an idle host must not
    // block a lobby of willing players.
    const canStart = me.ready && readyCount >= MIN_PLAYERS && currentMatch.status === 'lobby';
    const hostName = host?.name?.slice(0, 12) || 'Host';

    handlers.onYou(myDisplayName, colorCssForIndex(myColorIdx), inLobby, isHost);
    handlers.onPlayers(totalCount, readyCount, inLobby);

    if (pendingReady && !me.ready && inLobby) {
      pendingReady = false;
      latency.send(() => connection.reducers.setReady({ ready: true }).catch(() => {}));
    }

    const scoreRows = [...connection.db.matchScore.iter()]
      .filter((s) => s.matchId === currentMatch.id)
      .sort((a, b) => Number(a.id - b.id));

    const scoreEntries: ScoreEntry[] = scoreRows.map((row, idx) => {
      const ownerHex = row.owner.toHexString();
      if (!ownerColorIndex.has(ownerHex)) {
        ownerColorIndex.set(ownerHex, idx % 4);
      }
      const colorIdx = colorIndexForIdentity(ownerHex, idx);
      return {
        ownerHex,
        name: nameForIdentity(ownerHex),
        wins: row.wins,
        colorCss: colorCssForIndex(colorIdx),
        isSelf: ownerHex === myIdentityHex,
        joinOrder: idx,
      };
    });

    // Order by score descending, then join order ascending
    scoreEntries.sort((a, b) => {
      if (b.wins !== a.wins) return b.wins - a.wins;
      return a.joinOrder - b.joinOrder;
    });

    let bannerText = '';
    let bannerColorCss: string | undefined;
    if (currentMatch.status === 'countdown') {
      bannerText = '3 · 2 · 1 · SHOVE';
    } else if (currentMatch.status === 'round_end') {
      if (lastRoundWinnerHex) {
        bannerText = `Round to ${nameForIdentity(lastRoundWinnerHex)}`;
        bannerColorCss = colorCssForIndex(colorIndexForIdentity(lastRoundWinnerHex));
      } else {
        bannerText = 'Draw — replaying';
      }
    } else if (currentMatch.status === 'finished') {
      const winHex = currentMatch.winner?.toHexString();
      if (winHex) {
        bannerText = `${nameForIdentity(winHex)} wins the match`;
        bannerColorCss = colorCssForIndex(colorIndexForIdentity(winHex));
      } else {
        bannerText = 'Match finished';
      }
    }

    const lobbyInfo: LobbyInfo = {
      isHost,
      canStart,
      isReady: me.ready,
      readyCount,
      totalCount,
      minPlayers: MIN_PLAYERS,
      // The module caps a match at four seats; the lobby needs the same number to disable
      // the CPU button before the reducer has to refuse.
      maxPlayers: 4,
      cpuCount,
      hostName,
    };

    handlers.onMatchUpdate(
      currentMatch.code,
      currentMatch.status,
      isHost,
      canStart,
      me.ready,
      currentMatch.round,
      scoreEntries,
      bannerText,
      bannerColorCss,
      lobbyInfo
    );

    if (autopilot && currentMatch.status === 'lobby') {
      const earlierLobby = [...connection.db.match.iter()].find(
        (m) => m.status === 'lobby' && m.id < currentMatch.id
      );
      if (earlierLobby && matchPlayers.length === 1) {
        latency.send(() =>
          connection.reducers.joinMatch({ code: earlierLobby.code }).catch(() => {})
        );
        return;
      }
      if (!me.ready && !readyInFlight) {
        readyInFlight = true;
        latency.send(() => {
          connection.reducers
            .setReady({ ready: true })
            .catch(() => {})
            .finally(() => {
              readyInFlight = false;
            });
        });
      } else if (canStart && !startInFlight) {
        startInFlight = true;
        latency.send(() => {
          connection.reducers
            .startMatch({})
            .catch(() => {})
            .finally(() => {
              startInFlight = false;
            });
        });
      }
    }
  }

  let pendingReady = false;
  let matchJoinInFlight = false;

  function autoJoinOrCreateMatch() {
    if (matchJoinInFlight) return;
    const me = [...connection.db.player.iter()].find((p) => p.id.toHexString() === myIdentityHex);
    if (!me || me.matchId !== undefined) return;

    const requestedMatch = PARAMS.get('match')?.trim().toUpperCase();
    const forceNew = PARAMS.get('new') === '1' || PARAMS.get('new') === 'true';

    if (requestedMatch) {
      const match = [...connection.db.match.iter()].find(
        (m) => m.code.toUpperCase() === requestedMatch && m.status === 'lobby'
      );
      if (match) {
        matchJoinInFlight = true;
        latency.send(() =>
          connection.reducers
            .joinMatch({ code: match.code })
            .catch(() => {})
            .finally(() => {
              matchJoinInFlight = false;
            })
        );
        return;
      }
    }

    if (forceNew) {
      matchJoinInFlight = true;
      latency.send(() =>
        connection.reducers
          .createMatch({})
          .catch(() => {})
          .finally(() => {
            matchJoinInFlight = false;
          })
      );
      return;
    }

    const availableMatches = [...connection.db.match.iter()]
      .filter((m) => {
        if (m.status !== 'lobby') return false;
        const count = [...connection.db.player.iter()].filter((p) => p.matchId === m.id).length;
        return count < 4;
      })
      .sort((a, b) => Number(a.id - b.id));
    const availableMatch = availableMatches[0];
    matchJoinInFlight = true;
    if (availableMatch) {
      latency.send(() =>
        connection.reducers
          .joinMatch({ code: availableMatch.code })
          .catch(() => {})
          .finally(() => {
            matchJoinInFlight = false;
          })
      );
    } else {
      latency.send(() =>
        connection.reducers
          .createMatch({})
          .catch(() => {})
          .finally(() => {
            matchJoinInFlight = false;
          })
      );
    }
  }

  function steerToward(
    selfX: number,
    selfZ: number,
    targetX: number,
    targetZ: number
  ): { mx: number; mz: number; dist: number } {
    const dx = targetX - selfX;
    const dz = targetZ - selfZ;
    const dist = Math.hypot(dx, dz);
    if (dist < 0.15) {
      return { mx: 0, mz: 0, dist };
    }
    const scale = Math.min(1, dist * 1.5);
    return {
      mx: (dx / dist) * scale,
      mz: (dz / dist) * scale,
      dist,
    };
  }

  function aimAtNearestRemote(selfX: number, selfZ: number): { ax: number; az: number } {
    let bestDist = Infinity;
    let bestDx = -selfX;
    let bestDz = -selfZ;
    for (const b of connection.db.body.iter()) {
      if (currentMatchId === undefined || b.matchId !== currentMatchId) continue;
      if (!b.alive) continue;
      if (b.owner.toHexString() === myIdentityHex) continue;
      const dx = b.px - selfX;
      const dz = b.pz - selfZ;
      const d = Math.hypot(dx, dz);
      if (d < bestDist && d > 0.01) {
        bestDist = d;
        bestDx = dx;
        bestDz = dz;
      }
    }
    const len = Math.hypot(bestDx, bestDz);
    if (len < 0.01) return { ax: 1, az: 0 };
    return { ax: bestDx / len, az: bestDz / len };
  }

  function sampleBrawlInputForSlot(
    slotNum: number,
    x: number,
    z: number,
    elapsedSec: number,
    roundNum: number
  ): InputState {
    if (slotNum >= 11) {
      const isPortraitView = window.innerWidth < window.innerHeight;
      const targetX = slotNum === 11 ? (isPortraitView ? -1.4 : -2.6) : isPortraitView ? 1.4 : 2.6;
      const targetZ = slotNum === 11 ? (isPortraitView ? -10.2 : 0.8) : isPortraitView ? -11.2 : -0.8;
      const move = steerToward(x, z, targetX, targetZ);
      return {
        mx: move.mx,
        mz: move.mz,
        ax: slotNum === 11 ? 1 : -1,
        az: 0,
        dash: false,
      };
    }

    // Diamond formation around (0, 0) so all 4 robots are within SHOVE_RANGE (2.2 m)
    // while occupying distinct screen quadrants so all 4 nameplates remain readable.
    const brawlTargetX =
      slotNum === 1 ? -0.25 : slotNum === 2 ? 1.25 : slotNum === 3 ? -1.28 : 0.18;
    const brawlTargetZ =
      slotNum === 1 ? 1.18 : slotNum === 2 ? 0.12 : slotNum === 3 ? -0.15 : -1.25;

    if (roundNum === 1) {
      // Phase A (elapsedSec 0..5.5s -> 5.0s frame):
      // First collide at (0, 0) during 0..2.9s so body-body contact corrections accumulate,
      // then step into the central diamond and release staggered shoves around t = 4.86..5.05s
      if (elapsedSec <= 5.5) {
        const tgtX = elapsedSec <= 2.9 ? 0 : brawlTargetX;
        const tgtZ = elapsedSec <= 2.9 ? 0 : brawlTargetZ;
        const move = steerToward(x, z, tgtX, tgtZ);
        const aim = aimAtNearestRemote(x, z);
        let dash = false;
        if (slotNum === 1) dash = elapsedSec >= 3.80 && elapsedSec <= 4.86;
        else if (slotNum === 2) dash = elapsedSec >= 3.90 && elapsedSec <= 4.95;
        else if (slotNum === 3) dash = elapsedSec >= 4.00 && elapsedSec <= 5.05;
        else dash = elapsedSec >= 4.10 && elapsedSec <= 5.35;

        return {
          mx: move.mx,
          mz: move.mz,
          ax: aim.ax,
          az: aim.az,
          dash,
        };
      }

      // Phase B (elapsedSec 5.5..15.5s):
      // - slot 4 holds at (0, -10.5) until 9.28s, then sprints north across -14.3m at ~9.78s (10.0s elim frame)
      // - slot 2 holds at (10.5, 0) until 9.38s, then sprints east across +14.3m at ~9.88s (10.0s elim frame)
      // - slot 1 moves to (9.0, 0) and releases shove at 9.88s (10.0s shove + elim frame)
      // - slot 3 holds at (-10.5, 0) until 12.05s, then sprints west across -14.3m at ~12.55s (15.0s Round to Ada banner)
      if (slotNum === 4) {
        if (elapsedSec < 9.28) {
          const move = steerToward(x, z, 0, -10.5);
          return { mx: move.mx, mz: move.mz, ax: 0, az: -1, dash: false };
        }
        return { mx: 0, mz: -1, ax: 0, az: -1, dash: false };
      }

      if (slotNum === 2) {
        if (elapsedSec < 9.38) {
          const move = steerToward(x, z, 10.5, 0);
          return { mx: move.mx, mz: move.mz, ax: -1, az: 0, dash: false };
        }
        return { mx: 1, mz: 0, ax: 1, az: 0, dash: false };
      }

      if (slotNum === 3) {
        if (elapsedSec < 12.05) {
          const move = steerToward(x, z, -10.5, 0);
          return { mx: move.mx, mz: move.mz, ax: 1, az: 0, dash: false };
        }
        return { mx: -1, mz: 0, ax: -1, az: 0, dash: false };
      }

      // slot 1 (Ada)
      if (elapsedSec < 10.2) {
        const move = steerToward(x, z, 9.0, 0);
        return {
          mx: move.mx,
          mz: move.mz,
          ax: 1,
          az: 0,
          dash: elapsedSec >= 8.80 && elapsedSec <= 9.88,
        };
      }
      const move = steerToward(x, z, 0, 0);
      return { mx: move.mx, mz: move.mz, ax: -1, az: 0, dash: false };
    }

    // Round 2+ (Round 2 playing starts at ~18.55s):
    // Phase C (elapsedSec <= 20.5s -> 20.0s frame):
    // All 4 converge on the central diamond; Ada/Bruno release shoves at 19.86s / 19.95s, Cleo/Diego hold charge
    if (elapsedSec <= 20.5) {
      const move = steerToward(x, z, brawlTargetX, brawlTargetZ);
      const aim = aimAtNearestRemote(x, z);
      let dash = false;
      if (slotNum === 1) dash = elapsedSec >= 18.80 && elapsedSec <= 19.86;
      else if (slotNum === 2) dash = elapsedSec >= 18.90 && elapsedSec <= 19.95;
      else if (slotNum === 3) dash = elapsedSec >= 19.00 && elapsedSec <= 20.05;
      else dash = elapsedSec >= 19.10 && elapsedSec <= 20.35;
      return {
        mx: move.mx,
        mz: move.mz,
        ax: aim.ax,
        az: aim.az,
        dash,
      };
    }

    // Phase D (elapsedSec > 20.5s -> 25.0s elimination + match win banner):
    if (slotNum === 4) {
      if (elapsedSec < 22.0) {
        const move = steerToward(x, z, 0, -10.5);
        return { mx: move.mx, mz: move.mz, ax: 0, az: -1, dash: false };
      }
      return { mx: 0, mz: -1, ax: 0, az: -1, dash: false };
    }

    if (slotNum === 2) {
      if (elapsedSec < 23.0) {
        const move = steerToward(x, z, 0, 10.5);
        return { mx: move.mx, mz: move.mz, ax: 0, az: 1, dash: false };
      }
      return { mx: 0, mz: 1, ax: 0, az: 1, dash: false };
    }

    if (slotNum === 3) {
      if (elapsedSec < 24.32) {
        const move = steerToward(x, z, 10.5, 0);
        return { mx: move.mx, mz: move.mz, ax: 1, az: 0, dash: false };
      }
      return { mx: 1, mz: 0, ax: 1, az: 0, dash: false };
    }

    // slot 1 (Ada) stays at (9.0, 0) and releases shove at 24.88s
    const move = steerToward(x, z, 9.0, 0);
    return {
      mx: move.mx,
      mz: move.mz,
      ax: 1,
      az: 0,
      dash: elapsedSec >= 23.80 && elapsedSec <= 24.88,
    };
  }

  function sampleBrawlInput(elapsedSec: number, roundNum: number): InputState {
    const selfTransform = prediction.getRenderTransform();
    if (!selfTransform) {
      return { mx: 0, mz: 0, ax: 1, az: 0, dash: false };
    }
    const slotNum = Number.parseInt(SLOT, 10) || 1;
    return sampleBrawlInputForSlot(slotNum, selfTransform.x, selfTransform.z, elapsedSec, roundNum);
  }

  function spawnInPageBrawlPeers(startFromSlot: number, maxSlot: number) {
    const peerNames = ['Ada', 'Bruno', 'Cleo', 'Diego'];
    for (let s = startFromSlot; s <= maxSlot; s++) {
      const peerSlot = s;
      const peerName = peerNames[peerSlot - 1] ?? `Bot-${peerSlot}`;
      let peerIdentityHex = '';
      let peerSeq = 1;
      let peerPlayingStartedAt: number | null = null;
      const peerConn = DbConnection.builder()
        .withUri(SERVER_URI)
        .withDatabaseName(DATABASE)
        .onConnect((_ctx, identity) => {
          peerIdentityHex = identity.toHexString();
        })
        .build();

      peerConn
        .subscriptionBuilder()
        .onApplied(() => {
          setTimeout(() => {
            peerConn.reducers
              .joinLobby({ name: peerName })
              .then(() => {
                const lobby = [...peerConn.db.match.iter()].find((m) => m.status === 'lobby');
                if (lobby) {
                  return peerConn.reducers.joinMatch({ code: lobby.code });
                }
              })
              .then(() => peerConn.reducers.setReady({ ready: true }))
              .catch(() => {});
          }, (peerSlot - 2) * 200);
        })
        .subscribe([tables.player, tables.match, tables.body]);

      startTicker(() => {
        if (!peerIdentityHex) return;
        const me = [...peerConn.db.player.iter()].find(
          (p) => p.id.toHexString() === peerIdentityHex
        );
        if (!me || me.matchId === undefined) return;
        const m = [...peerConn.db.match.iter()].find((row) => row.id === me.matchId);
        if (!m) return;
        if (m.status === 'lobby' && !me.ready) {
          peerConn.reducers.setReady({ ready: true }).catch(() => {});
          return;
        }
        if (m.status !== 'playing') return;
        const myBody = [...peerConn.db.body.iter()].find(
          (b) => b.matchId === m.id && b.owner.toHexString() === peerIdentityHex
        );
        if (!myBody || !myBody.alive) return;
        const now = performance.now();
        if (peerPlayingStartedAt === null) {
          peerPlayingStartedAt = now;
        }
        const elapsed = (now - peerPlayingStartedAt) / 1000;
        const inp = sampleBrawlInputForSlot(peerSlot, myBody.px, myBody.pz, elapsed, m.round);
        const seq = peerSeq++;
        peerConn.reducers.submitInputs({ samples: [{ seq, ...inp }] }).catch(() => {});
      }, Math.round(1000 / TICK_HZ));
    }
  }

  function handleBodyRow(row: Body, isInitialSync: boolean) {
    if (currentMatchId === undefined || row.matchId !== currentMatchId) {
      handlers.onRemoveBody(row.id);
      return;
    }
    const ownerHex = row.owner.toHexString();
    const isSelf = ownerHex === myIdentityHex;
    const snapshot = toBodySnapshot(row);
    refreshPaletteAssignments(row.matchId);
    const preferredColor = colorIndexForIdentity(ownerHex, row.color);
    const displayName = nameForIdentity(ownerHex) || row.name.slice(0, 12);
    const isPin = Boolean(autopilot?.pin);

    const apply = () => {
      if (!isInitialSync && !isPin) metrics.recordRow();
      const assignedColor = handlers.onEnsureBody(
        snapshot.id,
        preferredColor,
        displayName,
        isSelf,
        snapshot.px,
        snapshot.pz
      );
      ownerColorIndex.set(ownerHex, assignedColor);

      if (isSelf) {
        const wasAlive = hasAliveSelfBody;
        hasAliveSelfBody = snapshot.alive;
        if (isPin) {
          prediction.reset(snapshot);
          return;
        }
        const isRoundSpawn =
          isInitialSync ||
          (!wasAlive && snapshot.alive) ||
          currentMatchStatus !== 'playing' ||
          (snapshot.serverTick === 0n && snapshot.lastSeq === 0);
        if (isRoundSpawn) {
          nextSeq = Math.max(nextSeq, snapshot.lastSeq + 1);
          autopilotSpawnAngle = Math.atan2(snapshot.pz, snapshot.px);
          prediction.reset(snapshot);
        } else {
          const now = performance.now();
          lastAckedSeq = Math.max(lastAckedSeq, snapshot.lastSeq);
          metrics.recordAckSeq(snapshot.lastSeq, now);
          const selfTransform = prediction.getRenderTransform();
          for (const b of connection.db.body.iter()) {
            if (b.matchId !== row.matchId || !b.alive) continue;
            if (b.owner.toHexString() === myIdentityHex) continue;
            const dRow = Math.hypot(b.px - snapshot.px, b.pz - snapshot.pz);
            const dSelf = selfTransform
              ? Math.hypot(b.px - selfTransform.x, b.pz - selfTransform.z)
              : dRow;
            if (Math.min(dRow, dSelf) < 4.5) {
              lastContactAtMs = now;
              break;
            }
          }
          const isContact =
            !chaosActive && now - lastContactAtMs < 4500 + latency.getLatencyMs() * 2;
          prediction.reconcile(snapshot, currentArenaRadius, isContact);
        }
      } else {
        interpolator.pushSnapshot(snapshot, performance.now());
      }
    };

    if (isInitialSync) apply();
    else latency.recv(apply);
  }

  connection.subscriptionBuilder()
    .onApplied(() => {
      isSubscribed = true;
      handlers.onStatus('subscribed');
      reportPlayerCount();

      interpolator.reset();
      prediction.reset();
      hasAliveSelfBody = false;

      for (const existingBody of connection.db.body.iter()) {
        handleBodyRow(existingBody, true);
      }

      if (!autopilot?.pin) {
        metrics.reset();
        handlers.onMetricsUpdate();
      }

      const slotIdx = Number.parseInt(SLOT, 10) || 1;
      const joinDelayMs =
        BRAWL_MODE && slotIdx > 1 && slotIdx <= 4 ? 700 + (slotIdx - 2) * 350 : 0;

      setTimeout(() => {
        latency.send(() => {
          connection.reducers
            .joinLobby({ name: playerName })
            .then(() => {
              autoJoinOrCreateMatch();
              checkMatchState();
              if (BRAWL_MODE && slotIdx === 1 && !spawnedInPagePeers) {
                setTimeout(() => {
                  if (spawnedInPagePeers) return;
                  const count = [...connection.db.player.iter()].length;
                  if (count < MIN_PLAYERS) {
                    spawnedInPagePeers = true;
                    spawnInPageBrawlPeers(count + 1, MIN_PLAYERS);
                  }
                }, 2600);
              }
            })
            .catch((error: Error) => handlers.onStatus(`join failed: ${error.message}`));
        });
      }, joinDelayMs);
    })
    .subscribe([tables.player, tables.match, tables.body, tables.matchScore, tables.event]);

  const recordRowIfMeasured = () => {
    if (!autopilot?.pin) metrics.recordRow();
  };

  const onPlayerDelta = () => {
    if (!isSubscribed) return;
    latency.recv(() => {
      recordRowIfMeasured();
      reportPlayerCount();
      autoJoinOrCreateMatch();
      checkMatchState();
    });
  };

  connection.db.player.onInsert(onPlayerDelta);
  connection.db.player.onUpdate(onPlayerDelta);
  connection.db.player.onDelete(onPlayerDelta);

  connection.db.match.onInsert(() => {
    if (!isSubscribed) return;
    latency.recv(() => {
      recordRowIfMeasured();
      autoJoinOrCreateMatch();
      checkMatchState();
    });
  });
  connection.db.match.onUpdate(() => {
    if (!isSubscribed) return;
    latency.recv(() => {
      recordRowIfMeasured();
      checkMatchState();
    });
  });

  connection.db.body.onInsert((_ctx, row) => {
    if (isSubscribed) handleBodyRow(row, false);
  });
  connection.db.body.onUpdate((_ctx, _old, row) => {
    if (isSubscribed) handleBodyRow(row, false);
  });
  connection.db.body.onDelete((_ctx, row) => {
    if (!isSubscribed) return;
    const deletedId = row.id;
    const wasSelf = row.owner.toHexString() === myIdentityHex;
    latency.recv(() => {
      recordRowIfMeasured();
      if (wasSelf) {
        hasAliveSelfBody = false;
        prediction.reset();
      } else {
        interpolator.removeBody(deletedId);
      }
      handlers.onRemoveBody(deletedId);
    });
  });

  const onScoreDelta = () => {
    if (!isSubscribed) return;
    latency.recv(() => {
      recordRowIfMeasured();
      checkMatchState();
    });
  };
  connection.db.matchScore.onInsert(onScoreDelta);
  connection.db.matchScore.onUpdate(onScoreDelta);
  connection.db.matchScore.onDelete(onScoreDelta);

  connection.db.event.onInsert((_ctx, row) => {
    if (!isSubscribed) return;
    const kind = row.kind;
    const eventMatchId = row.matchId;
    const actorHex = row.a?.toHexString();
    const targetHex = row.b?.toHexString();
    const x = row.x;
    const z = row.z;
    const dx = row.dx;
    const dz = row.dz;
    latency.recv(() => {
      if (currentMatchId === undefined || eventMatchId !== currentMatchId) return;
      recordRowIfMeasured();
      if (kind === 'hit' || kind === 'shove') {
        lastContactAtMs = performance.now();
      }
      if (kind === 'round_end') {
        lastRoundWinnerHex = actorHex;
        checkMatchState();
      } else if (kind === 'match_end') {
        checkMatchState();
      }
      handlers.onGameEvent(kind, x, z, dx, dz, actorHex, targetHex);
    });
  });

  // Hidden-tab policy: a hidden tab keeps sending its last sampled input at 30 Hz
  // and refreshes HUD metrics at ~2 Hz off the Worker ticker.
  const stopSubmitTimer = startTicker(() => {
    if (autopilot?.pin) return;

    tickerCount += 1;
    if (tickerCount % 15 === 0) {
      metrics.refresh();
      handlers.onMetricsUpdate();
    }

    if (!isSubscribed || !myIdentityHex) return;
    const isFrozen = currentMatchStatus === 'countdown' || currentMatchStatus === 'round_end';
    if (currentMatchStatus !== 'playing' && !isFrozen) return;
    if (currentMatchStatus === 'playing' && !hasAliveSelfBody) return;

    const nowMs = performance.now();
    if (autopilot) {
      if (currentMatchStatus !== 'playing') {
        roundPlayingTicks = 0;
        lastSampledInput = {
          mx: 0,
          mz: 0,
          ax: -Math.cos(autopilotSpawnAngle),
          az: -Math.sin(autopilotSpawnAngle),
          dash: false,
        };
      } else {
        if (autopilotStartedAt === null) {
          autopilotStartedAt = nowMs;
          autopilotTicks = 0;
          metrics.reset();
          handlers.onMetricsUpdate();
        }
        autopilotTicks += 1;
        roundPlayingTicks += 1;
        const elapsedSec = (nowMs - autopilotStartedAt) / 1000;
        lastSampledInput = BRAWL_MODE
          ? sampleBrawlInput(elapsedSec, currentRoundNumber)
          : sampleAutopilotInput(autopilotTicks * DT, autopilotSpawnAngle);

        if (!autopilotPrinted && elapsedSec >= autopilot.durationSec) {
          autopilotPrinted = true;
          metrics.refresh();
          handlers.onMetricsUpdate();
          console.log(`RINGOUT_METRICS ${JSON.stringify(metrics.snapshot())}`);
          if (chaosActive) {
            chaosActive = false;
            flushChaosStallQueue();
            metrics.beginRecoveryWindow(latency.getLatencyMs() * 2 + 150);
          }
        }
      }
    }

    const inputSnapshot = { ...lastSampledInput };
    const seq = nextSeq++;

    // Local feedback: the punch, sound and arc start on release instead of waiting
    // for the server's shove event to come back over the wire.
    const releasedShove = wasDashHeld && !inputSnapshot.dash;
    wasDashHeld = inputSnapshot.dash;
    if (releasedShove && prediction.canShove()) {
      const selfTransform = prediction.getRenderTransform();
      if (selfTransform) {
        handlers.onLocalShove?.(selfTransform.x, selfTransform.z, selfTransform.aimX, selfTransform.aimZ);
      }
    }

    prediction.commitSentInput(seq, inputSnapshot, currentArenaRadius, isFrozen);
    metrics.recordSentSeq(seq, nowMs);

    // Redundancy: carry the previous unacked frame so a single lost packet costs
    // nothing. The server skips duplicates by seq, so resending is free.
    const currentSample = { seq, ...inputSnapshot };
    const samples =
      previousSample && previousSample.seq > lastAckedSeq
        ? [previousSample, currentSample]
        : [currentSample];
    previousSample = currentSample;

    const dispatchInput = () => {
      latency.send(() => {
        connection.reducers.submitInputs({ samples }).catch(() => {});
      });
    };

    if (autopilot && chaosActive && currentMatchStatus === 'playing') {
      chaosSeed = (chaosSeed * 1664525 + 1013904223) >>> 0;
      const roll = (chaosSeed / 0x100000000) * 100;
      if (roll < autopilot.chaosPercent) {
        return;
      }
      const elapsedMs = autopilotStartedAt !== null ? nowMs - autopilotStartedAt : 0;
      const cycleMs = elapsedMs % 5000;
      if (cycleMs >= 2000 && cycleMs < 2500) {
        chaosStallQueue.push(dispatchInput);
        return;
      }
      flushChaosStallQueue();
    }

    dispatchInput();
  }, 1000 / TICK_HZ);

  if (import.meta.hot) {
    import.meta.hot.dispose(() => {
      stopSubmitTimer();
      connection.disconnect();
    });
  }

  return {
    connection,
    setSampledInput(input: InputState) {
      if (!autopilot) lastSampledInput = input;
    },
    stepFixed(dt: number) {
      if (hasAliveSelfBody && !autopilot?.pin) {
        const isFrozen = currentMatchStatus === 'countdown' || currentMatchStatus === 'round_end';
        prediction.stepLocal(lastSampledInput, dt, currentArenaRadius, isFrozen);
      }
    },
    setName(rawName: string) {
      const trimmed = rawName.trim().slice(0, 12);
      if (trimmed.length === 0) return;
      playerName = trimmed;
      try {
        sessionStorage.setItem(NAME_KEY, trimmed);
        if (SLOT !== 'default') {
          localStorage.setItem(NAME_KEY, trimmed);
        }
      } catch {}
      latency.send(() => connection.reducers.setName({ name: trimmed }).catch(() => {}));
    },
    toggleReady() {
      if (!myIdentityHex) return;
      const me = [...connection.db.player.iter()].find((p) => p.id.toHexString() === myIdentityHex);
      if (!me || me.matchId === undefined) {
        pendingReady = !pendingReady;
        return;
      }
      const nextReady = !me.ready;
      latency.send(() => connection.reducers.setReady({ ready: nextReady }).catch(() => {}));
    },
    startMatch() {
      latency.send(() => connection.reducers.startMatch({}).catch(() => {}));
    },
    rematch() {
      latency.send(() => connection.reducers.rematch({}).catch(() => {}));
    },
    addBot() {
      latency.send(() => connection.reducers.addBot({}).catch(() => {}));
    },
    removeBot() {
      latency.send(() => connection.reducers.removeBot({}).catch(() => {}));
    },
    getMyIdentity: () => myIdentityHex,
    isAutopilot: () => autopilot !== null,
  };
}
