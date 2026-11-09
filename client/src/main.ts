import { createSfxController } from './audio/sfx';
import { connect } from './net/connection';
import { bindTouchControls, sampleInput } from './net/input';
import { createRemoteInterpolator } from './net/interpolation';
import { createLatencyShim } from './net/latency';
import { metrics } from './net/metrics';
import { createPredictionController } from './net/prediction';
import { createBodyRenderer } from './render/bodies';
import { createFxRenderer } from './render/fx';
import { createScene } from './render/scene';
import { hud } from './ui/hud';

const CLIENT_DT = 1 / 60;

const canvas = document.querySelector<HTMLCanvasElement>('#view');
if (!canvas) {
  throw new Error('index.html must contain <canvas id="view">');
}

const lobbyBar = document.querySelector<HTMLDivElement>('#lobby-bar');
const nameForm = document.querySelector<HTMLFormElement>('#name-form');
const nameInput = document.querySelector<HTMLInputElement>('#player-name');
const readyButton = document.querySelector<HTMLButtonElement>('#btn-ready');
const startButton = document.querySelector<HTMLButtonElement>('#btn-start');
const rematchButton = document.querySelector<HTMLButtonElement>('#btn-rematch');
const addCpuButton = document.querySelector<HTMLButtonElement>('#btn-add-cpu');
const removeCpuButton = document.querySelector<HTMLButtonElement>('#btn-remove-cpu');
const touchStick = document.querySelector<HTMLElement>('#touch-stick');
const touchKnob = document.querySelector<HTMLElement>('#touch-stick-knob');
const touchShove = document.querySelector<HTMLElement>('#touch-shove');
const rotatePrompt = document.querySelector<HTMLElement>('#rotate-prompt');

bindTouchControls(touchStick, touchKnob, touchShove);

const portraitMql = window.matchMedia('(orientation: portrait)');
function syncRotatePrompt(): void {
  const isPortrait = portraitMql.matches;
  if (rotatePrompt) {
    rotatePrompt.style.display = isPortrait ? 'flex' : 'none';
    rotatePrompt.setAttribute('aria-hidden', isPortrait ? 'false' : 'true');
  }
}
syncRotatePrompt();
portraitMql.addEventListener('change', syncRotatePrompt);
window.addEventListener('resize', syncRotatePrompt);

const view = createScene(canvas);
const sfx = createSfxController(view.camera);
const latency = createLatencyShim(0);
const prediction = createPredictionController();
const interpolator = createRemoteInterpolator();
const bodyRenderer = createBodyRenderer(view.scene, prediction, interpolator);
const fxRenderer = createFxRenderer(view.scene);

hud.setStatus('connecting');
hud.setMuted(sfx.isMuted());
hud.bindMuteButton(() => {
  hud.setMuted(sfx.toggleMute());
});

let lastMatchStatus = 'none';
let myIdentityHex = '';
let lastLocalShoveAt = Number.NEGATIVE_INFINITY;

const activeConn = connect(
  {
    onStatus: (status) => hud.setStatus(status),
    onIdentity: (identity) => {
      myIdentityHex = identity;
      hud.setIdentity(identity);
    },
    onYou: (name, colorCss, inLobby, isHost) => {
      hud.setYou(name, colorCss, inLobby && Boolean(isHost));
      if (nameInput && document.activeElement !== nameInput) {
        nameInput.value = name;
      }
      if (nameForm) {
        nameForm.style.display = inLobby ? 'inline-flex' : 'none';
      }
    },
    onPlayers: (count, readyCount, inLobby) => hud.setPlayers(count, readyCount, inLobby),
    onMetricsUpdate: () => hud.updateMetrics(metrics),
    onSpectator: () => hud.setSpectator(),
    onArenaRadius: (radius) => view.setArenaRadius(radius),
    onGameEvent: (kind, x, z, dx, dz, actorHex, targetHex) => {
      // Our own shove already played on release; the server's copy is an echo.
      const isOwnShoveEcho =
        kind === 'shove' &&
        actorHex !== undefined &&
        actorHex === myIdentityHex &&
        performance.now() - lastLocalShoveAt < 600;
      if (isOwnShoveEcho) {
        return;
      }

      fxRenderer.trigger({ kind, x, z, dx, dz });
      bodyRenderer.onGameEvent(kind, x, z, dx, dz, actorHex, targetHex);
      if (kind === 'shove') {
        sfx.play('shove');
      } else if (kind === 'hit') {
        sfx.play('hit');
      } else if (kind === 'elim') {
        sfx.play('elim');
        hud.flashElimination();
      } else if (kind === 'round_end' || kind === 'match_end') {
        view.pulseEdge();
      }
    },
    // C: feedback on release, one RTT before the server's event can arrive.
    onLocalShove: (x, z, dx, dz) => {
      lastLocalShoveAt = performance.now();
      sfx.play('shove');
      fxRenderer.trigger({ kind: 'shove', x, z, dx, dz });
      bodyRenderer.triggerLocalShove(dx, dz);
    },
    onMatchUpdate: (
      matchCode,
      matchStatus,
      isHost,
      canStart,
      isReady,
      round,
      scoreEntries,
      bannerText,
      bannerColorCss,
      lobbyInfo
    ) => {
      if (lastMatchStatus !== 'playing' && matchStatus === 'playing') {
        sfx.play('round_start');
        bodyRenderer.resetAllPoses();
      }
      if (matchStatus === 'lobby' || matchStatus === 'none') {
        bodyRenderer.resetAllPoses();
      }
      lastMatchStatus = matchStatus;
      document.body.dataset.matchStatus = matchStatus;
      document.body.dataset.matchCode = matchCode;

      const inLobby = matchStatus === 'lobby' || matchStatus === 'none';
      const isFinished = matchStatus === 'finished';

      if (lobbyBar) {
        lobbyBar.style.display = inLobby || isFinished ? 'flex' : 'none';
      }
      if (readyButton) {
        readyButton.style.display = inLobby ? 'inline-block' : 'none';
        readyButton.textContent = isReady ? 'Ready ✓ (R)' : 'Ready (R)';
        readyButton.classList.toggle('ready-active', isReady);
      }
      if (startButton) {
        startButton.style.display = inLobby ? 'inline-block' : 'none';
        startButton.disabled = !canStart;
        startButton.classList.toggle('can-start', canStart);
        if (canStart) {
          startButton.textContent = matchCode ? `Start ${matchCode} (Enter)` : 'Start Match (Enter)';
        } else if (lobbyInfo && lobbyInfo.readyCount < lobbyInfo.minPlayers) {
          startButton.textContent = `Waiting for Players (${lobbyInfo.readyCount}/${lobbyInfo.minPlayers} ready)...`;
        } else if (lobbyInfo && !lobbyInfo.isReady) {
          startButton.textContent = 'Ready up to start';
        } else {
          startButton.textContent = 'Waiting for Players...';
        }
      }
      if (rematchButton) {
        rematchButton.style.display = isFinished ? 'inline-block' : 'none';
      }
      if (addCpuButton) {
        addCpuButton.style.display = inLobby ? 'inline-block' : 'none';
        addCpuButton.disabled = !(lobbyInfo && lobbyInfo.totalCount < lobbyInfo.maxPlayers);
      }
      if (removeCpuButton) {
        removeCpuButton.style.display = inLobby ? 'inline-block' : 'none';
        removeCpuButton.disabled = !(lobbyInfo && lobbyInfo.cpuCount > 0);
      }

      hud.setScore(!inLobby, round, scoreEntries);
      hud.setBanner(bannerText, bannerColorCss);
    },
    onEnsureBody: (id, colorIndex, name, isSelf, px, pz) => {
      return bodyRenderer.ensureBody(id, colorIndex, name, isSelf, px, pz);
    },
    onRemoveBody: (id) => {
      bodyRenderer.removeBody(id);
    },
  },
  latency,
  prediction,
  interpolator
);

hud.setLatencyMs(metrics.latencyMs);
hud.updateMetrics(metrics);
hud.bindLatencySlider((latencyMs) => {
  const previousLatency = latency.getLatencyMs();
  latency.setLatencyMs(latencyMs);
  metrics.setLatencyMs(latencyMs);
  if (latencyMs < previousLatency) {
    metrics.beginRecoveryWindow(previousLatency * 2 + 150);
  }
  metrics.refresh();
  hud.updateMetrics(metrics);
});

if (nameForm && nameInput) {
  nameForm.addEventListener('submit', (event) => {
    event.preventDefault();
    activeConn.setName(nameInput.value);
    nameInput.blur();
  });

  nameInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      if (event.isComposing || event.keyCode === 229) {
        return;
      }
      nameForm.requestSubmit();
    }
  });

  nameInput.addEventListener('blur', () => {
    if (nameInput.value.trim().length > 0) {
      activeConn.setName(nameInput.value);
    }
  });
}

if (readyButton) {
  readyButton.addEventListener('click', () => activeConn.toggleReady());
}

if (startButton) {
  startButton.addEventListener('click', () => activeConn.startMatch());
}

if (addCpuButton) {
  addCpuButton.addEventListener('click', () => activeConn.addBot());
}

if (removeCpuButton) {
  removeCpuButton.addEventListener('click', () => activeConn.removeBot());
}

if (rematchButton) {
  rematchButton.addEventListener('click', () => {
    bodyRenderer.resetAllPoses();
    activeConn.rematch();
  });
}

window.addEventListener('keydown', (event) => {
  if (nameInput && document.activeElement === nameInput) {
    return;
  }
  if (event.code === 'KeyR') {
    activeConn.toggleReady();
  } else if (event.code === 'Enter') {
    activeConn.startMatch();
  } else if (event.code === 'KeyM') {
    bodyRenderer.resetAllPoses();
    activeConn.rematch();
  } else if (event.code === 'KeyN') {
    hud.setMuted(sfx.toggleMute());
  }
});

(window as any).__ringoutPoseAssertions = () => bodyRenderer.getPoseAssertions();
(window as any).__ringoutShadowAssertions = () => bodyRenderer.getShadowAssertions();
(window as any).__ringoutChargeAssertions = () =>
  bodyRenderer.getChargeBarAssertions(view.camera, 1280, 720);
if (window.__ringout) {
  (window.__ringout as any).getPoseAssertions = () => bodyRenderer.getPoseAssertions();
  (window.__ringout as any).getShadowAssertions = () => bodyRenderer.getShadowAssertions();
  (window.__ringout as any).getChargeBarAssertions = () =>
    bodyRenderer.getChargeBarAssertions(view.camera, 1280, 720);
}

if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    latency.dispose();
    sfx.dispose();
    bodyRenderer.dispose();
    fxRenderer.dispose();
    view.dispose();
  });
}

let lastFrameAt = performance.now();
let accumulator = 0;

function frame(now: number) {
  const frameStart = performance.now();
  const rafDeltaMs = now - lastFrameAt;
  const dt = Math.min(0.25, rafDeltaMs / 1000);
  lastFrameAt = now;

  latency.pump();
  const isTypingName = Boolean(nameInput && document.activeElement === nameInput);
  activeConn.setSampledInput(
    isTypingName ? { mx: 0, mz: 0, ax: 0, az: -1, dash: false } : sampleInput()
  );

  accumulator += dt;
  while (accumulator >= CLIENT_DT) {
    accumulator -= CLIENT_DT;
    activeConn.stepFixed(CLIENT_DT);
  }

  const focus = bodyRenderer.update(dt, view.camera);
  fxRenderer.update(dt);
  view.update(dt, focus);
  view.render();

  const cpuMs = performance.now() - frameStart;
  metrics.recordFrame(
    cpuMs,
    rafDeltaMs,
    view.getDrawCalls(),
    view.isBloomEnabled(),
    bodyRenderer.getNameplateTextureCount()
  );

  requestAnimationFrame(frame);
}

requestAnimationFrame(frame);
