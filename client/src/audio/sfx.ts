import * as THREE from 'three';

export type SfxKind = 'shove' | 'hit' | 'elim' | 'round_start';

export type SfxController = {
  isMuted: () => boolean;
  toggleMute: () => boolean;
  play: (kind: SfxKind) => void;
  dispose: () => void;
};

const MUTE_STORAGE_KEY = 'ringout:muted';

const BASE_VOLUMES: Record<SfxKind, number> = {
  shove: 0.16,
  hit: 0.2,
  elim: 0.24,
  round_start: 0.2,
};

const SOUND_URLS: Record<SfxKind, string> = {
  shove: `${import.meta.env.BASE_URL}audio/shove.wav`,
  hit: `${import.meta.env.BASE_URL}audio/hit.wav`,
  elim: `${import.meta.env.BASE_URL}audio/elim.wav`,
  round_start: `${import.meta.env.BASE_URL}audio/round_start.wav`,
};

function readInitialMuteState(): boolean {
  try {
    return window.localStorage.getItem(MUTE_STORAGE_KEY) === '1';
  } catch {
    return false;
  }
}

function persistMuteState(muted: boolean): void {
  try {
    window.localStorage.setItem(MUTE_STORAGE_KEY, muted ? '1' : '0');
  } catch {
    // Ignore storage quota / privacy mode errors
  }
}

export function createSfxController(camera: THREE.Camera): SfxController {
  let muted = readInitialMuteState();
  let unlocked = false;
  let listener: THREE.AudioListener | null = null;
  let duckUntilMs = 0;

  const sounds = new Map<SfxKind, THREE.Audio>();

  async function tryLockLandscape(): Promise<void> {
    const isPhoneOrTablet =
      window.matchMedia('(pointer: coarse)').matches ||
      window.matchMedia('(orientation: portrait)').matches;
    if (!isPhoneOrTablet) return;

    try {
      const element = document.documentElement;
      if (!document.fullscreenElement && typeof element.requestFullscreen === 'function') {
        await element.requestFullscreen();
      }
    } catch {
      // Fullscreen request may be rejected or unsupported (e.g. iOS Safari)
    }

    try {
      const orientation = screen.orientation as ScreenOrientation & {
        lock?: (mode: 'landscape') => Promise<void>;
      };
      if (typeof orientation?.lock === 'function') {
        await orientation.lock('landscape');
      }
    } catch {
      // iOS Safari and desktop browsers without orientation.lock reject quietly
    }
  }

  function unlockOnFirstGesture(): void {
    void tryLockLandscape();
    if (unlocked) return;
    unlocked = true;

    listener = new THREE.AudioListener();
    camera.add(listener);
    listener.setMasterVolume(muted ? 0 : 1);

    if (listener.context.state === 'suspended') {
      void listener.context.resume();
    }

    const loader = new THREE.AudioLoader();
    const kinds: SfxKind[] = ['shove', 'hit', 'elim', 'round_start'];
    for (const kind of kinds) {
      const sound = new THREE.Audio(listener);
      sound.setVolume(BASE_VOLUMES[kind]);
      sounds.set(kind, sound);
      loader.load(SOUND_URLS[kind], (buffer) => {
        sound.setBuffer(buffer);
      });
    }
  }

  function handleGesture(): void {
    unlockOnFirstGesture();
    if (listener && listener.context.state === 'suspended') {
      void listener.context.resume();
    }
  }

  window.addEventListener('pointerdown', handleGesture, { passive: true });
  window.addEventListener('keydown', handleGesture, { passive: true });

  return {
    isMuted() {
      return muted;
    },

    toggleMute() {
      muted = !muted;
      persistMuteState(muted);
      if (listener) {
        listener.setMasterVolume(muted ? 0 : 1);
      }
      return muted;
    },

    play(kind: SfxKind) {
      if (muted || !unlocked) return;
      const sound = sounds.get(kind);
      if (!sound || !sound.buffer) return;

      const nowMs = performance.now();
      if (kind === 'elim' || kind === 'round_start') {
        duckUntilMs = nowMs + 380;
      }

      const isDucked = (kind === 'shove' || kind === 'hit') && nowMs < duckUntilMs;
      const gain = isDucked ? BASE_VOLUMES[kind] * 0.45 : BASE_VOLUMES[kind];
      sound.setVolume(gain);

      if (sound.isPlaying) {
        sound.stop();
      }
      sound.play();
    },

    dispose() {
      window.removeEventListener('pointerdown', handleGesture);
      window.removeEventListener('keydown', handleGesture);
      for (const sound of sounds.values()) {
        if (sound.isPlaying) {
          sound.stop();
        }
        sound.disconnect();
      }
      sounds.clear();
      if (listener) {
        camera.remove(listener);
      }
    },
  };
}

