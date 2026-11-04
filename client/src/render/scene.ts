import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { ARENA_R_START } from '../../../shared/src/constants';

export type CameraFocusInput = {
  alivePositions: ReadonlyArray<{ x: number; z: number }>;
  selfCharge: number;
};

export type View = {
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  setArenaRadius: (radius: number) => void;
  pulseEdge: () => void;
  update: (dt: number, focus: CameraFocusInput) => void;
  render: () => void;
  getDrawCalls: () => number;
  isBloomEnabled: () => boolean;
  dispose: () => void;
};

const BACKGROUND = 0x0b0d10;
const BASE_FOV = 50;
const CHARGE_FOV_KICK = 6;
const ELEVATION_RAD = (55 * Math.PI) / 180;
const SIN_55 = Math.sin(ELEVATION_RAD);
const COS_55 = Math.cos(ELEVATION_RAD);
const EDGE_THICKNESS = 0.24;

function createFloorGradientTexture(): THREE.CanvasTexture {
  const size = 512;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (ctx) {
    const half = size / 2;
    const gradient = ctx.createRadialGradient(half, half, 8, half, half, half);
    gradient.addColorStop(0, '#273140');
    gradient.addColorStop(0.55, '#171d27');
    gradient.addColorStop(1, '#0e1218');
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, size, size);

    // Polar spokes (8 radial divisions)
    ctx.strokeStyle = 'rgba(148, 163, 184, 0.16)';
    ctx.lineWidth = 1.5;
    for (let i = 0; i < 8; i++) {
      const angle = (i * Math.PI) / 4;
      const innerR = half * 0.14;
      const outerR = half * 0.96;
      ctx.beginPath();
      ctx.moveTo(half + Math.cos(angle) * innerR, half + Math.sin(angle) * innerR);
      ctx.lineTo(half + Math.cos(angle) * outerR, half + Math.sin(angle) * outerR);
      ctx.stroke();
    }

    // Concentric range rings that tighten as floor scales with arenaRadius
    const ringFractions = [0.22, 0.48, 0.74, 0.91];
    for (let i = 0; i < ringFractions.length; i++) {
      const r = half * ringFractions[i]!;
      ctx.beginPath();
      ctx.arc(half, half, r, 0, Math.PI * 2);
      ctx.strokeStyle = i === 0 ? 'rgba(255, 180, 84, 0.34)' : 'rgba(255, 180, 84, 0.22)';
      ctx.lineWidth = i === 0 ? 2.2 : 1.8;
      ctx.stroke();
    }
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

function shouldUseBloom(): boolean {
  const params = new URLSearchParams(window.location.search);
  const forced = params.get('bloom');
  if (forced === '1') return true;
  if (forced === '0') return false;
  return true;
}

export function createScene(canvas: HTMLCanvasElement): View {
  const renderer = new THREE.WebGLRenderer({
    canvas,
    antialias: true,
    powerPreference: 'high-performance',
  });
  const pixelRatio = Math.min(window.devicePixelRatio || 1, 2);
  renderer.setPixelRatio(pixelRatio);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.1;

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(BACKGROUND);
  scene.fog = new THREE.FogExp2(BACKGROUND, 0.018);

  const pmremGenerator = new THREE.PMREMGenerator(renderer);
  pmremGenerator.compileEquirectangularShader();
  const roomEnv = new RoomEnvironment();
  const envTexture = pmremGenerator.fromScene(roomEnv, 0.04).texture;
  scene.environment = envTexture;
  roomEnv.dispose();
  pmremGenerator.dispose();

  let lastSceneDrawCalls = 0;
  let loggedDrawCallsOnce = false;
  scene.onAfterRender = (r) => {
    lastSceneDrawCalls = r.info.render.calls;
    if (!loggedDrawCallsOnce && lastSceneDrawCalls >= 6) {
      loggedDrawCallsOnce = true;
      console.info(`RINGOUT_DRAW_CALLS ${lastSceneDrawCalls}`);
    }
  };

  const camera = new THREE.PerspectiveCamera(BASE_FOV, 1, 0.1, 200);
  const camPos = new THREE.Vector3(0, 16 * SIN_55, 16 * COS_55);
  const camTarget = new THREE.Vector3(0, 0, 0);
  const centroid = new THREE.Vector3();
  const desiredPos = new THREE.Vector3();
  camera.position.copy(camPos);
  camera.lookAt(camTarget);

  const keyLight = new THREE.DirectionalLight(0xfff1e0, 2.2);
  keyLight.position.set(-6, 15, 6);
  scene.add(keyLight, new THREE.HemisphereLight(0x93c5fd, BACKGROUND, 0.85));

  const floorTexture = createFloorGradientTexture();
  const floorMat = new THREE.MeshStandardMaterial({
    map: floorTexture,
    roughness: 0.88,
    metalness: 0.05,
  });
  const floor = new THREE.Mesh(new THREE.CircleGeometry(ARENA_R_START, 96), floorMat);
  floor.rotation.x = -Math.PI / 2;
  scene.add(floor);

  const edgeMat = new THREE.MeshStandardMaterial({
    color: 0xffb454,
    emissive: 0xffb454,
    emissiveIntensity: 1.55,
    roughness: 0.25,
    metalness: 0.1,
    transparent: true,
    opacity: 0.92,
    side: THREE.DoubleSide,
  });
  const edge = new THREE.Mesh(
    new THREE.RingGeometry(ARENA_R_START - EDGE_THICKNESS, ARENA_R_START, 128),
    edgeMat
  );
  edge.rotation.x = -Math.PI / 2;
  edge.position.y = 0.015;
  scene.add(edge);

  const isCoarsePointer = window.matchMedia('(pointer: coarse)').matches;
  let bloomActive = shouldUseBloom();
  let coarseRenderEmaMs = 0.8;
  let composer: EffectComposer | null = null;
  let bloomPass: UnrealBloomPass | null = null;

  if (bloomActive) {
    composer = new EffectComposer(renderer);
    composer.setPixelRatio(pixelRatio);
    composer.addPass(new RenderPass(scene, camera));
    bloomPass = new UnrealBloomPass(
      new THREE.Vector2(window.innerWidth, window.innerHeight),
      0.55,
      0.4,
      0.85
    );
    composer.addPass(bloomPass);
  }

  let targetRadius = ARENA_R_START;
  let currentRadius = ARENA_R_START;
  let lastBuiltRadius = ARENA_R_START;
  let edgePulseRemaining = 0;
  let roundEndPullback = 0;

  function resize() {
    const width = canvas.clientWidth || window.innerWidth;
    const height = Math.max(1, canvas.clientHeight || window.innerHeight);
    renderer.setSize(width, height, false);
    if (composer) {
      composer.setSize(width, height);
    }
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
  }

  resize();
  window.addEventListener('resize', resize);

  return {
    scene,
    camera,

    setArenaRadius(radius: number) {
      targetRadius = radius;
    },

    pulseEdge() {
      edgePulseRemaining = 0.6;
      roundEndPullback = 4;
    },

    update(dt: number, focus: CameraFocusInput) {
      const radiusBlend = 1 - Math.exp(-12 * dt);
      currentRadius += (targetRadius - currentRadius) * radiusBlend;
      floor.scale.setScalar(currentRadius / ARENA_R_START);

      if (Math.abs(currentRadius - lastBuiltRadius) > 0.01) {
        lastBuiltRadius = currentRadius;
        edge.geometry.dispose();
        edge.geometry = new THREE.RingGeometry(
          Math.max(0.1, currentRadius - EDGE_THICKNESS),
          currentRadius,
          128
        );
      }

      if (edgePulseRemaining > 0) {
        edgePulseRemaining = Math.max(0, edgePulseRemaining - dt);
        const phase = (1 - edgePulseRemaining / 0.6) * Math.PI * 2;
        const pulse = Math.sin(phase * 2) * 0.5 + 0.5;
        edgeMat.emissiveIntensity = 1.55 + 1.15 * pulse;
        edgeMat.opacity = 0.85 + 0.15 * pulse;
      } else {
        edgeMat.emissiveIntensity = 1.55;
        edgeMat.opacity = 0.92;
      }

      if (roundEndPullback > 0) {
        roundEndPullback = Math.max(0, roundEndPullback - dt * 1.2);
      }

      const count = focus.alivePositions.length;
      if (count > 0) {
        let sumX = 0;
        let sumZ = 0;
        for (let i = 0; i < count; i++) {
          sumX += focus.alivePositions[i]!.x;
          sumZ += focus.alivePositions[i]!.z;
        }
        centroid.set(sumX / count, 0, sumZ / count);
      } else {
        centroid.set(0, 0, 0);
      }

      let spread = 0;
      for (let i = 0; i < count; i++) {
        const pos = focus.alivePositions[i]!;
        const d = Math.hypot(pos.x - centroid.x, pos.z - centroid.z);
        if (d > spread) {
          spread = d;
        }
      }

      // Clamp follow distance by vertical extent; portrait uses an 11-unit floor (4.5 degrade path).
      // In landscape, raise the floor when four bodies are alive, when spread < 3, or on landscape phones
      // and apply perspective Z-centering so the whole circular arena disc stays inside the frustum.
      const isPortrait = camera.aspect < 1;
      const isLandscapePhone = !isPortrait && window.innerHeight <= 480;

      let minDist: number;
      let maxDist: number;
      let spreadFactor: number;

      if (isPortrait) {
        minDist = 11;
        maxDist = 17.5;
        spreadFactor = 1.0;
      } else if (isLandscapePhone) {
        minDist = 24.2;
        maxDist = 26.5;
        spreadFactor = 1.1;
      } else {
        // Desktop landscape: fit-to-group bounding sphere [12, 20]
        minDist = 12.0;
        maxDist = 20.0;
        spreadFactor = 1.35;
      }

      const baseDist = THREE.MathUtils.clamp(minDist + spread * spreadFactor, minDist, maxDist);
      const dist = baseDist + roundEndPullback;

      if (!isPortrait) {
        const trackFactor = isLandscapePhone ? 0.22 : 0.42;
        const zBias = (isLandscapePhone ? 4.2 : 2.2) * (currentRadius / ARENA_R_START);
        centroid.x *= trackFactor;
        centroid.z = centroid.z * trackFactor + zBias;
      }

      desiredPos.set(centroid.x, dist * SIN_55, centroid.z + dist * COS_55);

      camPos.lerp(desiredPos, 1 - Math.exp(-4 * dt));
      camTarget.lerp(centroid, 1 - Math.exp(-6 * dt));
      camera.position.copy(camPos);
      camera.lookAt(camTarget);

      const targetFov = BASE_FOV + Math.max(0, Math.min(1, focus.selfCharge)) * CHARGE_FOV_KICK;
      const nextFov = THREE.MathUtils.lerp(camera.fov, targetFov, 1 - Math.exp(-10 * dt));
      if (Math.abs(nextFov - camera.fov) > 0.005) {
        camera.fov = nextFov;
        camera.updateProjectionMatrix();
      }
    },

    render() {
      if (
        canvas.width !== Math.floor((canvas.clientWidth || window.innerWidth) * pixelRatio) ||
        canvas.height !== Math.floor((canvas.clientHeight || window.innerHeight) * pixelRatio)
      ) {
        resize();
      }
      renderer.info.reset();
      if (composer && bloomActive) {
        const t0 = performance.now();
        composer.render();
        if (isCoarsePointer) {
          const elapsed = performance.now() - t0;
          coarseRenderEmaMs = coarseRenderEmaMs * 0.92 + elapsed * 0.08;
          if (coarseRenderEmaMs > 2.0) {
            bloomActive = false;
          }
        }
      } else {
        renderer.render(scene, camera);
      }
    },

    getDrawCalls() {
      return lastSceneDrawCalls;
    },

    isBloomEnabled() {
      return bloomActive;
    },

    dispose() {
      window.removeEventListener('resize', resize);
      if (composer) {
        composer.dispose();
      }
      renderer.dispose();
      floor.geometry.dispose();
      floorMat.dispose();
      floorTexture.dispose();
      edge.geometry.dispose();
      edgeMat.dispose();
      envTexture.dispose();
    },
  };
}
