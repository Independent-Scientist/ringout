export type InputState = {
  mx: number;
  mz: number;
  ax: number;
  az: number;
  dash: boolean;
};

const keys = new Set<string>();
let lastFacingX = 0;
let lastFacingZ = -1;

let stickMx = 0;
let stickMz = 0;
let touchDash = false;

const STICK_MAX_RADIUS = 38;

window.addEventListener('keydown', (event) => {
  keys.add(event.code);
});

window.addEventListener('keyup', (event) => {
  keys.delete(event.code);
});

export function bindTouchControls(
  stickEl: HTMLElement | null,
  knobEl: HTMLElement | null,
  shoveEl: HTMLElement | null
): void {
  if (stickEl && knobEl) {
    let activePointerId: number | null = null;

    const updateStickFromPoint = (clientX: number, clientY: number) => {
      const rect = stickEl.getBoundingClientRect();
      const centerX = rect.left + rect.width / 2;
      const centerY = rect.top + rect.height / 2;
      const rawDx = clientX - centerX;
      const rawDy = clientY - centerY;
      const dist = Math.hypot(rawDx, rawDy);
      const scale = dist > STICK_MAX_RADIUS ? STICK_MAX_RADIUS / dist : 1;
      const clampedDx = rawDx * scale;
      const clampedDy = rawDy * scale;

      stickMx = clampedDx / STICK_MAX_RADIUS;
      stickMz = clampedDy / STICK_MAX_RADIUS;
      knobEl.style.translate = `${clampedDx.toFixed(1)}px ${clampedDy.toFixed(1)}px`;
    };

    const resetStick = () => {
      activePointerId = null;
      stickMx = 0;
      stickMz = 0;
      knobEl.style.translate = '0px 0px';
      stickEl.classList.remove('active');
    };

    stickEl.addEventListener('pointerdown', (event) => {
      event.preventDefault();
      activePointerId = event.pointerId;
      if (event.isTrusted) {
        stickEl.setPointerCapture(event.pointerId);
      }
      stickEl.classList.add('active');
      updateStickFromPoint(event.clientX, event.clientY);
    });

    stickEl.addEventListener('pointermove', (event) => {
      if (activePointerId !== event.pointerId) return;
      event.preventDefault();
      updateStickFromPoint(event.clientX, event.clientY);
    });

    stickEl.addEventListener('pointerup', (event) => {
      if (activePointerId !== event.pointerId) return;
      resetStick();
    });

    stickEl.addEventListener('pointercancel', (event) => {
      if (activePointerId !== event.pointerId) return;
      resetStick();
    });
  }

  if (shoveEl) {
    const setShoveHeld = (held: boolean) => {
      touchDash = held;
      shoveEl.classList.toggle('active', held);
    };

    shoveEl.addEventListener('pointerdown', (event) => {
      event.preventDefault();
      if (event.isTrusted) {
        shoveEl.setPointerCapture(event.pointerId);
      }
      setShoveHeld(true);
    });

    shoveEl.addEventListener('pointerup', () => setShoveHeld(false));
    shoveEl.addEventListener('pointercancel', () => setShoveHeld(false));
  }
}

/**
 * Samples current movement, aim direction, and dash state.
 * WASD or virtual stick moves; arrows, stick, or mouse aim; space or shove button charges dash.
 */
export function sampleInput(): InputState {
  let mx = stickMx;
  let mz = stickMz;

  if (keys.has('KeyW')) mz -= 1;
  if (keys.has('KeyS')) mz += 1;
  if (keys.has('KeyA')) mx -= 1;
  if (keys.has('KeyD')) mx += 1;

  const moveLen = Math.hypot(mx, mz);
  if (moveLen > 1) {
    mx /= moveLen;
    mz /= moveLen;
  }

  // Movement updates lastFacing whenever non-zero
  if (moveLen > 0.001) {
    lastFacingX = mx / moveLen;
    lastFacingZ = mz / moveLen;
  }

  let ax = 0;
  let az = 0;
  if (keys.has('ArrowUp')) az -= 1;
  if (keys.has('ArrowDown')) az += 1;
  if (keys.has('ArrowLeft')) ax -= 1;
  if (keys.has('ArrowRight')) ax += 1;

  const arrowLen = Math.hypot(ax, az);
  let aimX = lastFacingX;
  let aimZ = lastFacingZ;

  if (arrowLen > 0.001) {
    aimX = ax / arrowLen;
    aimZ = az / arrowLen;
    lastFacingX = aimX;
    lastFacingZ = aimZ;
  }

  const dash = keys.has('Space') || touchDash;

  return {
    mx,
    mz,
    ax: aimX,
    az: aimZ,
    dash,
  };
}

const AUTOPILOT_OMEGA = 0.77;
const AUTOPILOT_PHASE = 0.08;
const AUTOPILOT_SHOVE =
  typeof window !== 'undefined' &&
  new URLSearchParams(window.location.search).get('shove') === '1';

/**
 * Deterministic circular walking pattern for ?autopilot=<latency>.
 * Orbits the arena center at r ~= 8.4m so a stationary pin body at (-8.4, 0)
 * lies directly on the orbit while two orbiting bodies stay 180 deg apart.
 */
export function sampleAutopilotInput(elapsedSeconds: number, spawnAngle = 0): InputState {
  const angle = spawnAngle + AUTOPILOT_OMEGA * elapsedSeconds + AUTOPILOT_PHASE;
  const cycle = elapsedSeconds % 1.8;
  const dash = AUTOPILOT_SHOVE && cycle >= 0.4 && cycle <= 0.9;
  const aimSign = AUTOPILOT_SHOVE ? -1 : 1;
  return {
    mx: -Math.sin(angle),
    mz: Math.cos(angle),
    ax: aimSign * Math.cos(angle),
    az: aimSign * Math.sin(angle),
    dash,
  };
}
