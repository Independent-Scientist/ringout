import * as THREE from 'three';
import { PLAYER_R } from '../../../shared/src/constants';
import type { RemoteInterpolator } from '../net/interpolation';
import type { PredictionController } from '../net/prediction';
import type { CameraFocusInput } from './scene';
import { buildRobot, createInstancedLimbsManager, type RobotRig } from './robot';
import { boostColorHex } from './boost-visuals';

export const TEAM_COLORS_HEX = [
  0x4cc9f0, // cyan
  0xf72585, // magenta
  0xb5179e, // violet
  0xffd166, // warm gold
] as const;

export const TEAM_COLORS_CSS = [
  '#4cc9f0', // cyan
  '#f72585', // magenta
  '#b5179e', // violet
  '#ffd166', // warm gold
] as const;

export function colorCssForIndex(colorIndex: number): string {
  const idx = Math.abs(colorIndex) % TEAM_COLORS_CSS.length;
  return TEAM_COLORS_CSS[idx] ?? '#4cc9f0';
}

const CHARGE_BAR_VERTEX_SHADER = `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

const CHARGE_BAR_FRAGMENT_SHADER = `
uniform float uCharge;
uniform vec3 uColor;
varying vec2 vUv;

void main() {
  // 1px frame highlight
  bool isBorder = (vUv.y < 0.08 || vUv.y > 0.92 || vUv.x < 0.015 || vUv.x > 0.985);
  vec4 bg = vec4(0.043, 0.051, 0.063, 0.70); // dark plate at ~70% opacity
  vec4 fill = vec4(uColor, 0.95);             // player-tinted accent color
  vec4 border = vec4(0.24, 0.28, 0.36, 0.75);
  vec4 track = vec4(mix(bg.rgb, uColor, 0.12), 0.70); // faint track (~12% alpha player color)

  if (vUv.x <= uCharge && uCharge >= 0.02) {
    gl_FragColor = isBorder ? mix(fill, vec4(1.0), 0.22) : fill;
  } else if (isBorder) {
    gl_FragColor = border;
  } else {
    gl_FragColor = track;
  }
}
`;

const NAMEPLATE_BASE_Y = 2.48;

export type BodyPoseAssertion = {
  bodyId: string;
  name: string;
  isSelf: boolean;
  alive: boolean;
  facingDot: number;
  rootRotX: number;
  rootRotY: number;
  rootRotZ: number;
  tiltRotX: number;
  tiltRotY: number;
  tiltRotZ: number;
};

export type ShadowAssertion = {
  slot: number;
  bodyId: string;
  name: string;
  px: number;
  pz: number;
  targetY: number;
  matX: number;
  matY: number;
  matZ: number;
  delta: number;
  matches: boolean;
};

export type ChargeBarAssertion = {
  bodyId: string;
  name: string;
  isSelf: boolean;
  charge: number;
  barWorldY: number;
  spriteBottomY: number;
  gap: number;
  scaleFactor: number;
  barPxHeight: number;
};

type BodyVisual = {
  id: bigint;
  colorIndex: number;
  name: string;
  isSelf: boolean;
  mesh: THREE.Group;
  robot: RobotRig;
  chargeBar: THREE.Mesh;
  chargeBarMat: THREE.ShaderMaterial;
  selfRing: THREE.Mesh;
  selfRingMat: THREE.MeshBasicMaterial;
  nameSprite: THREE.Sprite;
  nameSpriteMat: THREE.SpriteMaterial;
  dotMesh: THREE.Mesh;
  dotMat: THREE.MeshBasicMaterial;
  /** Boost aura: a floor ring plus three orbiting voxel chips, visible only while boosted. */
  auraGroup: THREE.Group;
  auraRing: THREE.Mesh;
  auraRingMat: THREE.MeshBasicMaterial;
  auraChips: THREE.Mesh[];
  auraChipMat: THREE.MeshBasicMaterial;
  auraPhase: number;
  wasAlive: boolean;
  elimElapsed: number;
  lastX: number;
  lastZ: number;
  slotIndex: number;
};

export type BodyRenderer = {
  ensureBody: (
    id: bigint,
    colorIndex: number,
    name: string,
    isSelf: boolean,
    initialX: number,
    initialZ: number
  ) => number;
  removeBody: (id: bigint) => void;
  onGameEvent: (
    kind: string,
    x: number,
    z: number,
    dx: number,
    dz: number,
    actorHex?: string,
    targetHex?: string
  ) => void;
  update: (dt: number, camera: THREE.PerspectiveCamera) => CameraFocusInput;
  getNameplateTextureCount: () => number;
  resetAllPoses: () => void;
  triggerLocalShove: (dx: number, dz: number) => void;
  getPoseAssertions: () => BodyPoseAssertion[];
  getShadowAssertions: () => ShadowAssertion[];
  getChargeBarAssertions: (
    camera?: THREE.PerspectiveCamera,
    viewportW?: number,
    viewportH?: number
  ) => ChargeBarAssertion[];
  dispose: () => void;
};

function createBlobShadowTexture(): THREE.CanvasTexture {
  const size = 64;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (ctx) {
    const half = size / 2;
    const grad = ctx.createRadialGradient(half, half, 2, half, half, half);
    grad.addColorStop(0, 'rgba(0, 0, 0, 0.62)');
    grad.addColorStop(0.6, 'rgba(0, 0, 0, 0.28)');
    grad.addColorStop(1, 'rgba(0, 0, 0, 0)');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, size, size);
  }
  return new THREE.CanvasTexture(canvas);
}

function normalizeName(rawName: string): string {
  const trimmed = rawName.trim().slice(0, 12);
  return trimmed.length > 0 ? trimmed : 'Player';
}

export function createBodyRenderer(
  scene: THREE.Scene,
  prediction: PredictionController,
  interpolator: RemoteInterpolator
): BodyRenderer {
  const visuals = new Map<string, BodyVisual>();
  const nameplateCache = new Map<string, THREE.CanvasTexture>();
  let nameplateTexturesCreated = 0;

  const limbsManager = createInstancedLimbsManager(scene);

  const sharedShadowGeo = new THREE.CircleGeometry(0.72, 24);
  sharedShadowGeo.rotateX(-Math.PI / 2);
  const sharedSelfRingGeo = new THREE.RingGeometry(PLAYER_R * 1.34, PLAYER_R * 1.56, 36);
  const sharedDotGeo = new THREE.CircleGeometry(0.22, 16);
  const sharedChargeBarGeo = new THREE.PlaneGeometry(1.6, 0.24);
  const sharedAuraRingGeo = new THREE.RingGeometry(PLAYER_R * 1.5, PLAYER_R * 1.85, 40);
  const sharedAuraChipGeo = new THREE.BoxGeometry(0.16, 0.16, 0.16);
  const shadowTexture = createBlobShadowTexture();
  const sharedShadowMat = new THREE.MeshBasicMaterial({
    map: shadowTexture,
    transparent: true,
    depthWrite: false,
  });

  const instancedShadow = new THREE.InstancedMesh(sharedShadowGeo, sharedShadowMat, 4);
  instancedShadow.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  scene.add(instancedShadow);

  const focusPositions: Array<{ x: number; z: number }> = [];
  for (let i = 0; i < 8; i++) {
    focusPositions.push({ x: 0, z: 0 });
  }
  const activePositionsView: Array<{ x: number; z: number }> = [];

  function getOrCreateNameplateTexture(name: string, colorIndex: number): THREE.CanvasTexture {
    const cleanName = normalizeName(name);
    const cssColor = colorCssForIndex(colorIndex);
    const cacheKey = `${cleanName}|${cssColor}`;
    const existing = nameplateCache.get(cacheKey);
    if (existing) {
      return existing;
    }

    const width = 256;
    const height = 64;
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    if (ctx) {
      ctx.clearRect(0, 0, width, height);
      const padX = 14;
      const padY = 10;
      const boxW = width - padX * 2;
      const boxH = height - padY * 2;
      const radius = 12;

      ctx.beginPath();
      ctx.roundRect(padX, padY, boxW, boxH, radius);
      ctx.fillStyle = 'rgba(11, 13, 16, 0.86)';
      ctx.fill();
      ctx.lineWidth = 3;
      ctx.strokeStyle = cssColor;
      ctx.stroke();

      ctx.font = '700 26px ui-monospace, SFMono-Regular, Menlo, monospace';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillStyle = cssColor;
      ctx.fillText(cleanName, width / 2, height / 2 + 1);
    }

    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    nameplateCache.set(cacheKey, texture);
    nameplateTexturesCreated += 1;
    return texture;
  }

  function createMesh(colorIndex: number, name: string, isSelf: boolean) {
    const group = new THREE.Group();
    const hexColor = TEAM_COLORS_HEX[colorIndex % TEAM_COLORS_HEX.length] ?? 0x4cc9f0;

    const selfRingMat = new THREE.MeshBasicMaterial({
      color: 0xffffff,
      transparent: true,
      opacity: 0.85,
      side: THREE.DoubleSide,
      depthWrite: false,
    });
    const selfRing = new THREE.Mesh(sharedSelfRingGeo, selfRingMat);
    selfRing.rotation.x = -Math.PI / 2;
    selfRing.position.y = 0.035;
    selfRing.visible = isSelf;
    group.add(selfRing);

    // Procedural robot rig (chunky Roblox proportions inside 0.55 envelope)
    const robot = buildRobot(colorIndex, isSelf, false);
    group.add(robot.root);

    // Billboarded charge bar under the nameplate (1.6 x 0.24, outside yaw node)
    const chargeBarMat = new THREE.ShaderMaterial({
      vertexShader: CHARGE_BAR_VERTEX_SHADER,
      fragmentShader: CHARGE_BAR_FRAGMENT_SHADER,
      uniforms: {
        uCharge: { value: 0 },
        uColor: { value: new THREE.Color(hexColor) },
      },
      transparent: true,
      depthTest: false,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
    const chargeBar = new THREE.Mesh(sharedChargeBarGeo, chargeBarMat);
    chargeBar.renderOrder = 20;
    chargeBar.position.set(0, NAMEPLATE_BASE_Y - 0.47, 0);
    chargeBar.visible = false;
    group.add(chargeBar);

    const nameplateTex = getOrCreateNameplateTexture(name, colorIndex);
    const nameSpriteMat = new THREE.SpriteMaterial({
      map: nameplateTex,
      transparent: true,
      depthTest: true,
      depthWrite: false,
    });
    const nameSprite = new THREE.Sprite(nameSpriteMat);
    nameSprite.position.set(0, NAMEPLATE_BASE_Y, 0);
    nameSprite.scale.set(2.9, 0.72, 1);
    group.add(nameSprite);

    const dotMat = new THREE.MeshBasicMaterial({
      color: hexColor,
      side: THREE.DoubleSide,
      depthTest: true,
      depthWrite: false,
    });
    const dotMesh = new THREE.Mesh(sharedDotGeo, dotMat);
    dotMesh.position.set(0, NAMEPLATE_BASE_Y - 0.10, 0);
    dotMesh.visible = false;
    group.add(dotMesh);

    // Boost aura. Three orbiting voxel chips carry the "I am carrying something" read from
    // across the arena; the floor ring says which, and both thin out as the timer runs down.
    const auraGroup = new THREE.Group();
    auraGroup.visible = false;
    const auraRingMat = new THREE.MeshBasicMaterial({
      color: 0xffffff,
      transparent: true,
      opacity: 0.5,
      depthWrite: false,
      side: THREE.DoubleSide,
      // Normal blending keeps the ring's colour; additive over this floor saturates to white.
    });
    const auraRing = new THREE.Mesh(sharedAuraRingGeo, auraRingMat);
    auraRing.rotation.x = -Math.PI / 2;
    auraRing.position.y = 0.045;
    auraGroup.add(auraRing);

    const auraChipMat = new THREE.MeshBasicMaterial({ color: 0xffffff });
    const auraChips: THREE.Mesh[] = [];
    for (let chip = 0; chip < 3; chip++) {
      const mesh = new THREE.Mesh(sharedAuraChipGeo, auraChipMat);
      auraChips.push(mesh);
      auraGroup.add(mesh);
    }
    group.add(auraGroup);

    scene.add(group);
    return {
      group,
      robot,
      chargeBar,
      chargeBarMat,
      selfRing,
      selfRingMat,
      nameSprite,
      nameSpriteMat,
      dotMesh,
      dotMat,
      auraGroup,
      auraRing,
      auraRingMat,
      auraChips,
      auraChipMat,
      auraPhase: 0,
    };
  }

  function removeBody(rowId: bigint) {
    const key = rowId.toString();
    const visual = visuals.get(key);
    if (!visual) return;

    scene.remove(visual.mesh);
    visual.robot.dispose();
    visual.chargeBarMat.dispose();
    visual.selfRingMat.dispose();
    visual.nameSpriteMat.dispose();
    visual.dotMat.dispose();
    visual.auraRingMat.dispose();
    visual.auraChipMat.dispose();
    visuals.delete(key);
  }

  const shadowDummy = new THREE.Object3D();
  const zeroMatrix = new THREE.Matrix4().makeScale(0, 0, 0);

  return {
    ensureBody(
      id: bigint,
      colorIndex: number,
      name: string,
      isSelf: boolean,
      initialX: number,
      initialZ: number
    ): number {
      const key = id.toString();
      const cleanName = normalizeName(name);
      let visual = visuals.get(key);
      if (!visual) {
        const usedColors = new Set<number>();
        for (const existing of visuals.values()) {
          usedColors.add(existing.colorIndex);
        }
        let assignedColor = Math.abs(colorIndex) % TEAM_COLORS_HEX.length;
        if (usedColors.has(assignedColor)) {
          for (let candidate = 0; candidate < TEAM_COLORS_HEX.length; candidate++) {
            if (!usedColors.has(candidate)) {
              assignedColor = candidate;
              break;
            }
          }
        }
        const created = createMesh(assignedColor, cleanName, isSelf);
        created.group.position.set(initialX, 0, initialZ);
        visual = {
          id,
          colorIndex: assignedColor,
          name: cleanName,
          isSelf,
          mesh: created.group,
          robot: created.robot,
          chargeBar: created.chargeBar,
          chargeBarMat: created.chargeBarMat,
          selfRing: created.selfRing,
          selfRingMat: created.selfRingMat,
          nameSprite: created.nameSprite,
          nameSpriteMat: created.nameSpriteMat,
          dotMesh: created.dotMesh,
          dotMat: created.dotMat,
          auraGroup: created.auraGroup,
          auraRing: created.auraRing,
          auraRingMat: created.auraRingMat,
          auraChips: created.auraChips,
          auraChipMat: created.auraChipMat,
          auraPhase: 0,
          wasAlive: true,
          elimElapsed: 0,
          lastX: initialX,
          lastZ: initialZ,
          slotIndex: visuals.size % 4,
        };
        visuals.set(key, visual);
      } else {
        visual.isSelf = isSelf;
        visual.selfRing.visible = isSelf;
        if (visual.name !== cleanName) {
          visual.name = cleanName;
          visual.nameSpriteMat.map = getOrCreateNameplateTexture(cleanName, visual.colorIndex);
          visual.nameSpriteMat.needsUpdate = true;
        }
      }
      return visual.colorIndex;
    },

    removeBody,

    onGameEvent(
      kind: string,
      x: number,
      z: number,
      dx: number,
      dz: number,
      _actorHex?: string,
      _targetHex?: string
    ) {
      if (kind === 'shove') {
        let bestDist = Infinity;
        let bestVisual: BodyVisual | null = null;
        for (const v of visuals.values()) {
          const d = Math.hypot(v.lastX - x, v.lastZ - z);
          if (d < bestDist) {
            bestDist = d;
            bestVisual = v;
          }
        }
        if (bestVisual && bestDist < 1.8) {
          bestVisual.robot.triggerShove(dx, dz);
        }
      } else if (kind === 'hit') {
        for (const v of visuals.values()) {
          const d = Math.hypot(v.lastX - x, v.lastZ - z);
          if (d < 1.8) {
            v.robot.triggerHit();
          }
        }
      }
    },

    update(dt: number, camera: THREE.PerspectiveCamera): CameraFocusInput {
      prediction.decayOffset(dt);
      const nowMs = performance.now();
      const cameraPos = camera.position;
      const viewportW = Math.max(1, window.innerWidth);
      const viewportH = Math.max(1, window.innerHeight);
      const isNarrowViewport = viewportW <= 420;
      activePositionsView.length = 0;
      let selfCharge = 0;

      const labelCandidates: Array<{
        visual: BodyVisual;
        x: number;
        z: number;
        camDist: number;
        dxCam: number;
        dyCam: number;
        dzCam: number;
        nudge: number;
      }> = [];

      let robotSlot = 0;
      for (const visual of visuals.values()) {
        const slotIdx = robotSlot++;
        visual.slotIndex = slotIdx;
        const transform = visual.isSelf
          ? prediction.getRenderTransform()
          : interpolator.sample(visual.id, nowMs, dt);

        if (!transform) {
          limbsManager.updateInstance(slotIdx, visual.robot, false, 0, 0);
          instancedShadow.setMatrixAt(slotIdx, zeroMatrix);
          continue;
        }

        const vx = dt > 0 ? (transform.x - visual.lastX) / dt : 0;
        const vz = dt > 0 ? (transform.z - visual.lastZ) / dt : 0;
        visual.lastX = transform.x;
        visual.lastZ = transform.z;

        if (!transform.alive) {
          if (visual.wasAlive) {
            visual.wasAlive = false;
            visual.elimElapsed = 0;
          }
          visual.elimElapsed += dt;
          const t = Math.min(1, visual.elimElapsed / 0.4);
          visual.chargeBar.visible = false;
          visual.selfRing.visible = false;
          visual.nameSprite.visible = false;
          visual.dotMesh.visible = false;
          visual.auraGroup.visible = false;
          if (t < 1) {
            visual.mesh.visible = true;
            const curScale = 1 - t;
            const curY = -1.2 * t;
            visual.mesh.position.set(transform.x, curY, transform.z);
            visual.robot.tiltPivot.rotation.x = (-Math.PI / 2) * t;
            visual.robot.root.scale.setScalar(curScale);
            visual.robot.root.rotation.x = 0;
            visual.robot.root.rotation.z = 0;
            limbsManager.updateInstance(slotIdx, visual.robot, true, curScale, curY);

            shadowDummy.position.set(transform.x, 0.02, transform.z);
            shadowDummy.scale.setScalar(curScale);
            shadowDummy.updateMatrix();
            instancedShadow.setMatrixAt(slotIdx, shadowDummy.matrix);
          } else {
            visual.mesh.visible = false;
            limbsManager.updateInstance(slotIdx, visual.robot, false, 0, 0);
            instancedShadow.setMatrixAt(slotIdx, zeroMatrix);
          }
          continue;
        }

        if (!visual.wasAlive) {
          visual.wasAlive = true;
          visual.robot.resetPose();
        }
        visual.elimElapsed = 0;
        visual.mesh.visible = true;
        visual.mesh.position.set(transform.x, 0, transform.z);
        visual.robot.root.position.set(0, 0, 0);
        visual.robot.root.scale.setScalar(1);
        visual.robot.root.rotation.x = 0;
        visual.robot.root.rotation.z = 0;

        // Update blob shadow instance
        shadowDummy.position.set(transform.x, 0.02, transform.z);
        shadowDummy.scale.setScalar(1);
        shadowDummy.updateMatrix();
        instancedShadow.setMatrixAt(slotIdx, shadowDummy.matrix);

        // Update robot procedural animation
        visual.robot.updateAnimation(
          dt,
          vx,
          vz,
          transform.aimX,
          transform.aimZ,
          transform.charge,
          transform.alive
        );

        limbsManager.updateInstance(slotIdx, visual.robot, true, 1, 0);

        // Boost aura: colour is the boost's, chips orbit faster for the buffs and sink for the
        // slow, and everything fades as the timer runs out so you can read the clock off it.
        const boostKind = transform.boostKind ?? 0;
        const boostSeconds = transform.boostSeconds ?? 0;
        if (boostKind > 0 && boostSeconds > 0) {
          visual.auraGroup.visible = true;
          const color = boostColorHex(boostKind);
          visual.auraRingMat.color.setHex(color);
          visual.auraChipMat.color.setHex(color);
          const spin = boostKind === 2 ? 3.6 : boostKind === 3 ? 0.9 : 2.0;
          visual.auraPhase += dt * spin;
          const lifeFade = Math.min(1, boostSeconds / 0.7);
          const blink = boostSeconds < 2 ? 0.55 + 0.45 * Math.sin(nowMs * 0.022) : 1;
          const breathe = 0.5 + 0.5 * Math.sin(visual.auraPhase * 1.6);
          visual.auraRing.scale.setScalar(1 + 0.05 * breathe);
          visual.auraRingMat.opacity = (0.42 + 0.22 * breathe) * lifeFade * blink;
          const orbitRadius = 0.62;
          const chipY = boostKind === 3 ? 0.28 : 0.85;
          for (let chip = 0; chip < visual.auraChips.length; chip++) {
            const mesh = visual.auraChips[chip]!;
            const angle = visual.auraPhase + (chip * Math.PI * 2) / visual.auraChips.length;
            const bob = Math.sin(visual.auraPhase * 2 + chip) * 0.05;
            mesh.position.set(
              Math.cos(angle) * orbitRadius,
              chipY + bob * (boostKind === 3 ? 0.4 : 1),
              Math.sin(angle) * orbitRadius
            );
            mesh.rotation.set(visual.auraPhase * 0.7, angle, 0);
          }
        } else {
          visual.auraGroup.visible = false;
        }

        const posSlotIdx = activePositionsView.length;
        if (posSlotIdx < focusPositions.length) {
          const slot = focusPositions[posSlotIdx]!;
          slot.x = transform.x;
          slot.z = transform.z;
          activePositionsView.push(slot);
        }

        const charge = Math.max(0, Math.min(1, transform.charge));
        if (visual.isSelf) {
          selfCharge = charge;
          visual.selfRing.visible = true;
          const pulse = Math.sin(nowMs * 0.007) * 0.5 + 0.5;
          visual.selfRing.scale.setScalar(1 + 0.1 * pulse);
          visual.selfRingMat.opacity = 0.65 + 0.35 * pulse;
        } else {
          visual.selfRing.visible = false;
        }

        // Show billboarded charge bar for EVERY alive player (shows empty track when charge = 0)
        visual.chargeBar.visible = true;
        if (visual.chargeBarMat.uniforms.uCharge) {
          visual.chargeBarMat.uniforms.uCharge.value = charge;
        }
        visual.chargeBar.quaternion.copy(camera.quaternion);

        const dxCam = cameraPos.x - transform.x;
        const dyCam = cameraPos.y - NAMEPLATE_BASE_Y;
        const dzCam = cameraPos.z - transform.z;
        const camDist = Math.max(1, Math.hypot(dxCam, dyCam, dzCam));
        const nudge = 0.38 / camDist;

        if (isNarrowViewport && !visual.isSelf) {
          visual.nameSprite.visible = false;
          visual.dotMesh.visible = true;
          visual.dotMesh.position.set(dxCam * nudge, (NAMEPLATE_BASE_Y - 0.03) + dyCam * nudge, dzCam * nudge);
          visual.dotMesh.lookAt(cameraPos);
          const scaleFactor = THREE.MathUtils.clamp(camDist / 16, 0.85, 1.45);
          const worldH = 0.7 * scaleFactor;
          visual.chargeBar.scale.set(scaleFactor, scaleFactor, 1);
          const barLocalY = (NAMEPLATE_BASE_Y - 0.03) + dyCam * nudge - worldH * 0.5 - 0.12 * scaleFactor;
          visual.chargeBar.position.set(dxCam * nudge, barLocalY, dzCam * nudge);
        } else {
          visual.dotMesh.visible = false;
          labelCandidates.push({
            visual,
            x: transform.x,
            z: transform.z,
            camDist,
            dxCam,
            dyCam,
            dzCam,
            nudge,
          });
        }
      }

      // Hide remaining unused shadow instances
      for (let s = robotSlot; s < 4; s++) {
        limbsManager.updateInstance(s, null as any, false, 0, 0);
        instancedShadow.setMatrixAt(s, zeroMatrix);
      }
      limbsManager.commit();
      instancedShadow.instanceMatrix.needsUpdate = true;

      // Sort labels by camera distance ascending
      labelCandidates.sort((a, b) => {
        const distA = a.visual.isSelf ? a.camDist - 0.5 : a.camDist;
        const distB = b.visual.isSelf ? b.camDist - 0.5 : b.camDist;
        return distA - distB;
      });

      const projVec = new THREE.Vector3();
      const placedRects: Array<{ sx: number; sy: number; w: number; h: number }> = [];
      const fovRad = THREE.MathUtils.degToRad(camera.fov);
      const focalPx = (viewportH * 0.5) / Math.tan(fovRad * 0.5);

      for (let i = 0; i < labelCandidates.length; i++) {
        const item = labelCandidates[i]!;
        const { visual, x, z, camDist, dxCam, dyCam, dzCam, nudge } = item;
        const scaleFactor = THREE.MathUtils.clamp(camDist / 16, 0.85, 1.45);
        const worldW = 2.85 * scaleFactor;
        const worldH = 0.7 * scaleFactor;
        visual.nameSprite.scale.set(worldW, worldH, 1);
        visual.chargeBar.scale.set(scaleFactor, scaleFactor, 1);

        const rectW = Math.max(48, (worldW / camDist) * focalPx * 0.78);
        const rectH = Math.max(16, (worldH / camDist) * focalPx * 0.82);

        const idOrder = Number(visual.id % 4n);
        const baseLocalY = NAMEPLATE_BASE_Y + dyCam * nudge;
        let chosenLocalY = baseLocalY;
        let chosenLocalX = dxCam * nudge;
        let chosenScreenX = 0;
        let chosenScreenY = 0;
        let nonOverlapping = false;

        for (let step = 0; step <= 6; step++) {
          const staggerY =
            step === 0 ? 0 : 0.65 * step + idOrder * 0.14;
          const staggerX =
            step === 0 ? 0 : (idOrder % 2 === 0 ? -0.26 : 0.26) * Math.min(2, step);
          const candidateY = baseLocalY + staggerY;
          const candidateX = dxCam * nudge + staggerX;

          projVec.set(x + candidateX, candidateY, z + dzCam * nudge).project(camera);
          const sx = (projVec.x * 0.5 + 0.5) * viewportW;
          const sy = (-projVec.y * 0.5 + 0.5) * viewportH;

          let collides = false;
          for (let rIdx = 0; rIdx < placedRects.length; rIdx++) {
            const r = placedRects[rIdx]!;
            const padPx = step === 0 ? 6 : 1;
            if (
              Math.abs(sx - r.sx) < (rectW + r.w) * 0.5 + padPx &&
              Math.abs(sy - r.sy) < (rectH + r.h) * 0.5 + padPx
            ) {
              collides = true;
              break;
            }
          }

          if (!collides) {
            chosenLocalY = candidateY;
            chosenLocalX = candidateX;
            chosenScreenX = sx;
            chosenScreenY = sy;
            nonOverlapping = true;
            break;
          }
        }

        const barLocalY = chosenLocalY - worldH * 0.5 - 0.12 * scaleFactor;
        if (nonOverlapping || visual.isSelf) {
          visual.nameSprite.visible = true;
          visual.nameSprite.position.set(chosenLocalX, chosenLocalY, dzCam * nudge);
          visual.chargeBar.position.set(chosenLocalX, barLocalY, dzCam * nudge);
          placedRects.push({ sx: chosenScreenX, sy: chosenScreenY, w: rectW, h: rectH });
        } else {
          visual.nameSprite.visible = false;
          visual.nameSprite.position.set(dxCam * nudge, chosenLocalY, dzCam * nudge);
          visual.chargeBar.position.set(dxCam * nudge, barLocalY, dzCam * nudge);
        }
      }

      return {
        alivePositions: activePositionsView,
        selfCharge,
      };
    },

    getNameplateTextureCount() {
      return nameplateTexturesCreated;
    },

    resetAllPoses() {
      for (const visual of visuals.values()) {
        visual.robot.resetPose();
        if (visual.chargeBarMat.uniforms.uCharge) {
          visual.chargeBarMat.uniforms.uCharge.value = 0;
        }
        visual.chargeBar.visible = false;
      }
    },

    /** Plays the punch locally the moment the button is released, before the server confirms. */
    triggerLocalShove(dx: number, dz: number) {
      for (const visual of visuals.values()) {
        if (visual.isSelf) {
          visual.robot.triggerShove(dx, dz);
          return;
        }
      }
    },

    getPoseAssertions(): BodyPoseAssertion[] {
      const list: BodyPoseAssertion[] = [];
      for (const v of visuals.values()) {
        list.push({
          bodyId: v.id.toString(),
          name: v.name,
          isSelf: v.isSelf,
          alive: v.wasAlive,
          facingDot: v.robot.lastFacingDot,
          rootRotX: v.robot.root.rotation.x,
          rootRotY: v.robot.root.rotation.y,
          rootRotZ: v.robot.root.rotation.z,
          tiltRotX: v.robot.tiltPivot.rotation.x,
          tiltRotY: v.robot.tiltPivot.rotation.y,
          tiltRotZ: v.robot.tiltPivot.rotation.z,
        });
      }
      return list;
    },

    getShadowAssertions(): ShadowAssertion[] {
      const assertions: ShadowAssertion[] = [];
      const m = new THREE.Matrix4();
      const pos = new THREE.Vector3();
      const rot = new THREE.Quaternion();
      const scl = new THREE.Vector3();

      for (const v of visuals.values()) {
        instancedShadow.getMatrixAt(v.slotIndex, m);
        m.decompose(pos, rot, scl);
        const px = v.lastX;
        const pz = v.lastZ;
        const targetY = 0.02;
        const delta = Math.hypot(pos.x - px, pos.y - targetY, pos.z - pz);
        assertions.push({
          slot: v.slotIndex,
          bodyId: v.id.toString(),
          name: v.name,
          px,
          pz,
          targetY,
          matX: pos.x,
          matY: pos.y,
          matZ: pos.z,
          delta,
          matches: delta < 1e-3,
        });
      }
      return assertions;
    },

    getChargeBarAssertions(
      cam?: THREE.PerspectiveCamera,
      _viewportW: number = 1280,
      viewportH: number = 720
    ): ChargeBarAssertion[] {
      const assertions: ChargeBarAssertion[] = [];
      const fov = cam?.fov ?? 55;
      const fovRad = THREE.MathUtils.degToRad(fov);
      const focalPx = (viewportH * 0.5) / Math.tan(fovRad * 0.5);

      for (const visual of visuals.values()) {
        const camPos = cam
          ? cam.position
          : new THREE.Vector3(0, 16 * Math.sin((55 * Math.PI) / 180), 16 * Math.cos((55 * Math.PI) / 180));
        const dxCam = camPos.x - visual.mesh.position.x;
        const dyCam = camPos.y - (visual.mesh.position.y + NAMEPLATE_BASE_Y);
        const dzCam = camPos.z - visual.mesh.position.z;
        const camDist = Math.max(1, Math.hypot(dxCam, dyCam, dzCam));
        const scaleFactor = THREE.MathUtils.clamp(camDist / 16, 0.85, 1.45);
        const worldH = 0.7 * scaleFactor;

        const spriteWorldY = visual.mesh.position.y + visual.nameSprite.position.y;
        const spriteBottomY = spriteWorldY - worldH * 0.5;
        const barWorldY = visual.mesh.position.y + visual.chargeBar.position.y;
        const gap = spriteBottomY - barWorldY;
        const barWorldH = 0.24 * scaleFactor;
        const barPxHeight = (barWorldH / camDist) * focalPx;

        const charge = visual.chargeBarMat.uniforms.uCharge?.value ?? 0;

        assertions.push({
          bodyId: visual.id.toString(),
          name: visual.name,
          isSelf: visual.isSelf,
          charge,
          barWorldY,
          spriteBottomY,
          gap,
          scaleFactor,
          barPxHeight,
        });
      }
      return assertions;
    },

    dispose() {
      for (const visual of visuals.values()) {
        removeBody(visual.id);
      }
      visuals.clear();
      limbsManager.dispose();
      instancedShadow.geometry.dispose();
      sharedShadowMat.dispose();
      shadowTexture.dispose();
      for (const tex of nameplateCache.values()) {
        tex.dispose();
      }
      nameplateCache.clear();
      sharedSelfRingGeo.dispose();
      sharedDotGeo.dispose();
      sharedChargeBarGeo.dispose();
    },
  };
}
