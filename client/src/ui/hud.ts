import type { RingoutMetrics } from '../net/metrics';

const LATENCY_STEPS = [0, 100, 250] as const;

export type ScoreEntry = {
  ownerHex: string;
  name: string;
  wins: number;
  colorCss: string;
  isSelf: boolean;
  joinOrder: number;
};

function text(fieldId: string, value: string): void {
  const element = document.getElementById(fieldId);
  if (element) {
    element.textContent = value;
  }
}

export const hud = {
  setStatus(status: string): void {
    text('status', status);
  },

  setIdentity(identity: string): void {
    text('identity', identity.slice(-8));
  },

  setYou(name: string, colorCss: string, isHost = false): void {
    const label = isHost ? `${name.slice(0, 12)} (Host)` : name.slice(0, 12);
    text('you-name', label);
    const swatch = document.getElementById('you-swatch');
    if (swatch) {
      swatch.style.background = colorCss;
    }
  },

  setPlayers(count: number, readyCount?: number, inLobby?: boolean): void {
    const label =
      inLobby && readyCount !== undefined
        ? `${count} (${readyCount}/${count} ready)`
        : String(count);
    text('players', label);
  },

  updateMetrics(metrics: RingoutMetrics): void {
    text('ping', String(metrics.rttMs));
    text('corr-ack', String(Math.round(metrics.ackCorrectionsPerMin)));
    text('corr-contact', String(Math.round(metrics.contactCorrectionsPerMin)));
    text('resim', String(metrics.resimSteps));
    text('rows', String(metrics.rowsPerSec));
  },

  setSpectator(): void {
    const container = document.getElementById('hud-metrics');
    if (container) {
      container.innerHTML = '<div class="row"><b>spectator — not measured</b></div>';
    }
  },

  setScore(visible: boolean, round: number, entries: ReadonlyArray<ScoreEntry>): void {
    const bar = document.getElementById('score-bar');
    if (bar) {
      bar.style.display = visible ? 'flex' : 'none';
    }
    text('round-num', String(round));
    const container = document.getElementById('score-vals');
    if (!container) return;

    container.replaceChildren();
    const isCompact = window.innerWidth <= 420 && entries.length >= 3;
    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i]!;
      const pill = document.createElement('span');
      pill.className = entry.isSelf ? 'score-entry is-self' : 'score-entry';

      const swatch = document.createElement('span');
      swatch.className = 'swatch';
      swatch.style.background = entry.colorCss;
      pill.appendChild(swatch);

      if (!isCompact || entry.isSelf) {
        const nameSpan = document.createElement('span');
        nameSpan.className = 'score-name';
        nameSpan.textContent = entry.name.slice(0, 12);
        pill.appendChild(nameSpan);
      }

      const winsEl = document.createElement('b');
      winsEl.className = 'score-wins';
      winsEl.textContent = String(entry.wins);
      pill.appendChild(winsEl);

      container.appendChild(pill);
    }
  },

  setBanner(message: string, swatchColorCss?: string): void {
    const banner = document.getElementById('round-banner');
    if (!banner) return;
    banner.replaceChildren();
    if (message.length === 0) {
      banner.style.display = 'none';
      return;
    }
    if (swatchColorCss) {
      const swatch = document.createElement('span');
      swatch.className = 'swatch banner-swatch';
      swatch.style.background = swatchColorCss;
      banner.appendChild(swatch);
    }
    banner.appendChild(document.createTextNode(message));
    banner.style.display = 'inline-flex';
  },

  flashElimination(): void {
    const flash = document.getElementById('elim-flash');
    if (!flash) return;
    flash.style.opacity = '1';
    window.setTimeout(() => {
      flash.style.opacity = '0';
    }, 180);
  },

  setLatencyMs(latencyMs: number): void {
    text('lat-val', String(latencyMs));
    const slider = document.querySelector<HTMLInputElement>('#lat');
    if (!slider) return;
    const stepIndex = LATENCY_STEPS.indexOf(latencyMs === 250 ? 250 : latencyMs === 100 ? 100 : 0);
    slider.value = String(stepIndex >= 0 ? stepIndex : 0);
  },

  bindLatencySlider(onChange: (latencyMs: number) => void): void {
    const slider = document.querySelector<HTMLInputElement>('#lat');
    if (!slider) return;
    slider.addEventListener('input', () => {
      const idx = Number.parseInt(slider.value, 10);
      const latencyMs = LATENCY_STEPS[idx] ?? 0;
      text('lat-val', String(latencyMs));
      onChange(latencyMs);
    });
  },

  setMuted(muted: boolean): void {
    const btn = document.getElementById('btn-mute');
    if (!btn) return;
    btn.textContent = muted ? 'sound: muted' : 'sound: on';
    btn.setAttribute('aria-pressed', muted ? 'true' : 'false');
  },

  bindMuteButton(onToggle: () => void): void {
    const btn = document.getElementById('btn-mute');
    if (!btn) return;
    btn.addEventListener('click', () => {
      onToggle();
    });
  },
};
