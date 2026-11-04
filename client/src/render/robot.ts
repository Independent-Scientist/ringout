import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

/**
 * RINGOUT Robot Model Conventions:
 * Local +Z is the forward vector of the robot (visor, chest plate, chest core, shoulder stripes face +Z).
 * Rotation about local Y by angle theta maps local +Z to world (sin theta, 0, cos theta).
 * For a normalized aim vector (aimX, aimZ), targetAngle = Math.atan2(aimX, aimZ)
 * aligns local +Z with the world aim vector.
 *
 * Node hierarchy:
 *   root (Group) -> holds position and yaw (rotation.y) ONLY. Never pitch or roll.
 *     tiltPivot (Group) -> holds fall, recoil, and torso lean (rotation.x and rotation.z). Never yaw.
 *       torsoGroup (Group) -> holds static merged body/accent/visor meshes and idle bob/coil.
 *       upperArmL / upperArmR / thighL / thighR -> articulated limb joints.
 */
export const MODEL_FORWARD = new THREE.Vector3(0, 0, 1);

export const TEAM_ACCENT_HEX = [
  0x5cbdd9, // desaturated cyan (~20% desaturated)
  0xd93e87, // desaturated magenta (~20% desaturated)
  0xa52992, // desaturated violet (~20% desaturated)
  0xebc367, // desaturated warm gold (~20% desaturated)
] as const;

export type RobotRig = {
  root: THREE.Group;
  group: THREE.Group; // alias to root for backward compatibility
  tiltPivot: THREE.Group;
  pelvis: THREE.Object3D;
  torso: THREE.Object3D;
  chestPlate: THREE.Object3D;
  head: THREE.Object3D;
  visor: THREE.Object3D;
  shoulderPads: THREE.Object3D;
  upperArmL: THREE.Group;
  lowerArmL: THREE.Group;
  upperArmR: THREE.Group;
  lowerArmR: THREE.Group;
  thighL: THREE.Group;
  shinL: THREE.Group;
  thighR: THREE.Group;
  shinR: THREE.Group;
  visorMat: THREE.MeshStandardMaterial;
  accentMat: THREE.MeshStandardMaterial;
  bodyMat: THREE.MeshStandardMaterial;
  alloyMat: THREE.MeshStandardMaterial;
  currentFacingAngle: number;
  walkPhase: number;
  shoveElapsed: number;
  hitElapsed: number;
  lastFacingDot: number;
  triggerShove: (dx: number, dz: number) => void;
  triggerHit: () => void;
  resetPose: () => void;
  updateAnimation: (
    dt: number,
    vx: number,
    vz: number,
    aimX: number,
    aimZ: number,
    charge: number,
    alive: boolean
  ) => void;
  dispose: () => void;
};

// Create a single merged geometry for a limb piece (joint + box)
function createMergedLimbGeometry(
  jointRadius: number,
  boxW: number,
  boxH: number,
  boxD: number,
  boxOffsetY: number,
  boxOffsetZ: number = 0
): THREE.BufferGeometry {
  const joint = new THREE.SphereGeometry(jointRadius, 8, 8);
  const box = new THREE.BoxGeometry(boxW, boxH, boxD);
  box.translate(0, boxOffsetY, boxOffsetZ);
  const merged = mergeGeometries([joint, box], false);
  joint.dispose();
  box.dispose();
  return merged;
}

export function buildRobot(
  colorIndex: number,
  isSelf: boolean = false,
  renderLimbsDirectly: boolean = false
): RobotRig {
  const group = new THREE.Group();
  const accentColor = TEAM_ACCENT_HEX[Math.abs(colorIndex) % TEAM_ACCENT_HEX.length] ?? 0x5cbdd9;

  const bodyMat = new THREE.MeshStandardMaterial({
    color: 0x2e353f, // dark gunmetal with clear contrast against arena floor
    metalness: 0.72,
    roughness: 0.38,
  });

  const alloyMat = new THREE.MeshStandardMaterial({
    color: 0x6e7681, // lighter alloy joints
    metalness: 0.65,
    roughness: 0.40,
  });

  const accentMat = new THREE.MeshStandardMaterial({
    color: 0x15181d,
    emissive: accentColor,
    emissiveIntensity: isSelf ? 0.35 : 0.28,
    metalness: 0.50,
    roughness: 0.35,
  });

  const visorMat = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    emissive: accentColor,
    emissiveIntensity: isSelf ? 0.38 : 0.30,
    metalness: 0.20,
    roughness: 0.20,
  });

  // 1. Static body pieces (merged into at most three geometries: body metal, accent emissive, visor)
  const staticBodyGeos: THREE.BufferGeometry[] = [];
  const staticAccentGeos: THREE.BufferGeometry[] = [];

  const pelvisGeo = new THREE.BoxGeometry(0.38, 0.12, 0.26);
  pelvisGeo.translate(0, 0.74, 0);
  staticBodyGeos.push(pelvisGeo);

  const torsoGeo = new THREE.BoxGeometry(0.44, 0.40, 0.28);
  torsoGeo.translate(0, 0.98, 0);
  staticBodyGeos.push(torsoGeo);

  const chestPlateGeo = new THREE.BoxGeometry(0.32, 0.22, 0.05);
  chestPlateGeo.translate(0, 1.02, 0.15);
  staticBodyGeos.push(chestPlateGeo);

  const chestCoreGeo = new THREE.BoxGeometry(0.12, 0.12, 0.04);
  chestCoreGeo.translate(0, 1.02, 0.18);
  staticAccentGeos.push(chestCoreGeo);

  const headGeo = new THREE.BoxGeometry(0.40, 0.38, 0.36);
  headGeo.translate(0, 1.38, 0);
  staticBodyGeos.push(headGeo);

  const shoulderPadL = new THREE.BoxGeometry(0.18, 0.14, 0.24);
  shoulderPadL.translate(-0.31, 1.16, 0);
  staticBodyGeos.push(shoulderPadL);

  const shoulderPadR = new THREE.BoxGeometry(0.18, 0.14, 0.24);
  shoulderPadR.translate(0.31, 1.16, 0);
  staticBodyGeos.push(shoulderPadR);

  const stripeL = new THREE.BoxGeometry(0.19, 0.03, 0.16);
  stripeL.translate(-0.31, 1.235, 0);
  staticAccentGeos.push(stripeL);

  const stripeR = new THREE.BoxGeometry(0.19, 0.03, 0.16);
  stripeR.translate(0.31, 1.235, 0);
  staticAccentGeos.push(stripeR);

  // Distinct silhouette geometries per robot index (0..3):
  const sIdx = Math.abs(colorIndex) % 4;
  if (sIdx === 0) {
    // Robot 0 (Cyan / Ada): Twin angled antenna fin blades
    const antennaL = new THREE.BoxGeometry(0.04, 0.16, 0.12);
    antennaL.rotateX(-0.4);
    antennaL.translate(-0.21, 1.62, -0.06);
    staticBodyGeos.push(antennaL);

    const antennaR = new THREE.BoxGeometry(0.04, 0.16, 0.12);
    antennaR.rotateX(-0.4);
    antennaR.translate(0.21, 1.62, -0.06);
    staticBodyGeos.push(antennaR);

    const tipL = new THREE.BoxGeometry(0.045, 0.04, 0.08);
    tipL.rotateX(-0.4);
    tipL.translate(-0.21, 1.69, -0.09);
    staticAccentGeos.push(tipL);

    const tipR = new THREE.BoxGeometry(0.045, 0.04, 0.08);
    tipR.rotateX(-0.4);
    tipR.translate(0.21, 1.69, -0.09);
    staticAccentGeos.push(tipR);
  } else if (sIdx === 1) {
    // Robot 1 (Magenta / Bruno): Heavy armored brow & reinforced shoulder blocks
    const browGeo = new THREE.BoxGeometry(0.44, 0.08, 0.08);
    browGeo.translate(0, 1.48, 0.19);
    staticBodyGeos.push(browGeo);

    const browStripe = new THREE.BoxGeometry(0.36, 0.025, 0.085);
    browStripe.translate(0, 1.515, 0.19);
    staticAccentGeos.push(browStripe);

    const shoulderBlockL = new THREE.BoxGeometry(0.20, 0.18, 0.26);
    shoulderBlockL.translate(-0.33, 1.17, 0);
    staticBodyGeos.push(shoulderBlockL);

    const shoulderBlockR = new THREE.BoxGeometry(0.20, 0.18, 0.26);
    shoulderBlockR.translate(0.33, 1.17, 0);
    staticBodyGeos.push(shoulderBlockR);
  } else if (sIdx === 2) {
    // Robot 2 (Violet / Cleo): Mohawk crest along top of head & swept winglets
    const mohawkGeo = new THREE.BoxGeometry(0.06, 0.12, 0.32);
    mohawkGeo.translate(0, 1.62, 0);
    staticBodyGeos.push(mohawkGeo);

    const mohawkStripe = new THREE.BoxGeometry(0.065, 0.03, 0.30);
    mohawkStripe.translate(0, 1.675, 0);
    staticAccentGeos.push(mohawkStripe);

    const wingL = new THREE.BoxGeometry(0.04, 0.12, 0.22);
    wingL.rotateZ(-0.3);
    wingL.translate(-0.39, 1.22, 0);
    staticBodyGeos.push(wingL);

    const wingR = new THREE.BoxGeometry(0.04, 0.12, 0.22);
    wingR.rotateZ(0.3);
    wingR.translate(0.39, 1.22, 0);
    staticBodyGeos.push(wingR);
  } else {
    // Robot 3 (Warm Gold / Diego): Dome head cap & cylindrical radar canisters
    const domeGeo = new THREE.CylinderGeometry(0.18, 0.21, 0.07, 16);
    domeGeo.translate(0, 1.60, 0);
    staticBodyGeos.push(domeGeo);

    const earL = new THREE.CylinderGeometry(0.06, 0.06, 0.09, 12);
    earL.rotateZ(Math.PI / 2);
    earL.translate(-0.23, 1.38, 0);
    staticBodyGeos.push(earL);

    const earR = new THREE.CylinderGeometry(0.06, 0.06, 0.09, 12);
    earR.rotateZ(Math.PI / 2);
    earR.translate(0.23, 1.38, 0);
    staticBodyGeos.push(earR);

    const earRingL = new THREE.BoxGeometry(0.03, 0.13, 0.13);
    earRingL.translate(-0.25, 1.38, 0);
    staticAccentGeos.push(earRingL);

    const earRingR = new THREE.BoxGeometry(0.03, 0.13, 0.13);
    earRingR.translate(0.25, 1.38, 0);
    staticAccentGeos.push(earRingR);
  }

  const mergedBodyGeo = mergeGeometries(staticBodyGeos, false);
  for (const g of staticBodyGeos) g.dispose();
  const bodyMesh = new THREE.Mesh(mergedBodyGeo, bodyMat);

  const mergedAccentGeo = mergeGeometries(staticAccentGeos, false);
  for (const g of staticAccentGeos) g.dispose();
  const accentMesh = new THREE.Mesh(mergedAccentGeo, accentMat);

  const visorGeo = new THREE.BoxGeometry(0.34, 0.11, 0.07);
  visorGeo.translate(0, 1.38, 0.19);
  const visorMesh = new THREE.Mesh(visorGeo, visorMat);

  const root = new THREE.Group();
  const tiltPivot = new THREE.Group();
  root.add(tiltPivot);

  const torsoGroup = new THREE.Group();
  torsoGroup.add(bodyMesh, accentMesh, visorMesh);
  tiltPivot.add(torsoGroup);

  // 2. Animated limbs: 8 articulated limb pieces
  const upperArmL = new THREE.Group();
  upperArmL.position.set(-0.30, 1.12, 0);

  const lowerArmL = new THREE.Group();
  lowerArmL.position.set(0, -0.22, 0);
  upperArmL.add(lowerArmL);

  const upperArmR = new THREE.Group();
  upperArmR.position.set(0.30, 1.12, 0);

  const lowerArmR = new THREE.Group();
  lowerArmR.position.set(0, -0.22, 0);
  upperArmR.add(lowerArmR);

  const thighL = new THREE.Group();
  thighL.position.set(-0.14, 0.68, 0);

  const shinL = new THREE.Group();
  shinL.position.set(0, -0.26, 0);
  thighL.add(shinL);

  const thighR = new THREE.Group();
  thighR.position.set(0.14, 0.68, 0);

  const shinR = new THREE.Group();
  shinR.position.set(0, -0.26, 0);
  thighR.add(shinR);

  const limbGeosToDispose: THREE.BufferGeometry[] = [];
  if (renderLimbsDirectly) {
    const upperArmLGeo = createMergedLimbGeometry(0.07, 0.13, 0.22, 0.13, -0.11);
    const upperArmLMesh = new THREE.Mesh(upperArmLGeo, bodyMat);
    upperArmL.add(upperArmLMesh);

    const lowerArmLGeo = createMergedLimbGeometry(0.06, 0.14, 0.22, 0.14, -0.11);
    const lowerArmLMesh = new THREE.Mesh(lowerArmLGeo, bodyMat);
    lowerArmL.add(lowerArmLMesh);

    const upperArmRGeo = createMergedLimbGeometry(0.07, 0.13, 0.22, 0.13, -0.11);
    const upperArmRMesh = new THREE.Mesh(upperArmRGeo, bodyMat);
    upperArmR.add(upperArmRMesh);

    const lowerArmRGeo = createMergedLimbGeometry(0.06, 0.14, 0.22, 0.14, -0.11);
    const lowerArmRMesh = new THREE.Mesh(lowerArmRGeo, bodyMat);
    lowerArmR.add(lowerArmRMesh);

    const thighLGeo = createMergedLimbGeometry(0.07, 0.15, 0.26, 0.15, -0.13);
    const thighLMesh = new THREE.Mesh(thighLGeo, bodyMat);
    thighL.add(thighLMesh);

    const shinLGeo = createMergedLimbGeometry(0.065, 0.16, 0.32, 0.18, -0.16, 0.01);
    const shinLMesh = new THREE.Mesh(shinLGeo, bodyMat);
    shinL.add(shinLMesh);

    const thighRGeo = createMergedLimbGeometry(0.07, 0.15, 0.26, 0.15, -0.13);
    const thighRMesh = new THREE.Mesh(thighRGeo, bodyMat);
    thighR.add(thighRMesh);

    const shinRGeo = createMergedLimbGeometry(0.065, 0.16, 0.32, 0.18, -0.16, 0.01);
    const shinRMesh = new THREE.Mesh(shinRGeo, bodyMat);
    shinR.add(shinRMesh);

    limbGeosToDispose.push(
      upperArmLGeo,
      lowerArmLGeo,
      upperArmRGeo,
      lowerArmRGeo,
      thighLGeo,
      shinLGeo,
      thighRGeo,
      shinRGeo
    );
  }

  tiltPivot.add(upperArmL, upperArmR, thighL, thighR);

  let currentFacingAngle = 0;
  let walkPhase = 0;
  let idleTime = Math.random() * 10;
  let shoveElapsed = 999;
  let hitElapsed = 999;
  let lastFacingDot = 1.0;
  let facingWarningLogged = false;
  const _tempForward = new THREE.Vector3();

  function resetPose() {
    tiltPivot.rotation.set(0, 0, 0);
    tiltPivot.position.set(0, 0, 0);
    root.scale.setScalar(1);
    root.rotation.x = 0;
    root.rotation.z = 0;
    shoveElapsed = 999;
    hitElapsed = 999;
    walkPhase = 0;
    torsoGroup.rotation.set(0, 0, 0);
    torsoGroup.position.set(0, 0, 0);
    upperArmL.rotation.set(0, 0, 0);
    lowerArmL.rotation.set(0, 0, 0);
    upperArmR.rotation.set(0, 0, 0);
    lowerArmR.rotation.set(0, 0, 0);
    thighL.rotation.set(0, 0, 0);
    shinL.rotation.set(0, 0, 0);
    thighR.rotation.set(0, 0, 0);
    shinR.rotation.set(0, 0, 0);
    visorMat.emissiveIntensity = isSelf ? 0.38 : 0.30;
  }

  return {
    root,
    group: root,
    tiltPivot,
    pelvis: torsoGroup,
    torso: torsoGroup,
    chestPlate: torsoGroup,
    head: torsoGroup,
    visor: visorMesh,
    shoulderPads: torsoGroup,
    upperArmL,
    lowerArmL,
    upperArmR,
    lowerArmR,
    thighL,
    shinL,
    thighR,
    shinR,
    visorMat,
    accentMat,
    bodyMat,
    alloyMat,
    get currentFacingAngle() {
      return currentFacingAngle;
    },
    set currentFacingAngle(v: number) {
      currentFacingAngle = v;
    },
    get walkPhase() {
      return walkPhase;
    },
    set walkPhase(v: number) {
      walkPhase = v;
    },
    get shoveElapsed() {
      return shoveElapsed;
    },
    set shoveElapsed(v: number) {
      shoveElapsed = v;
    },
    get hitElapsed() {
      return hitElapsed;
    },
    set hitElapsed(v: number) {
      hitElapsed = v;
    },
    get lastFacingDot() {
      return lastFacingDot;
    },

    triggerShove(_dx: number, _dz: number) {
      shoveElapsed = 0;
    },

    triggerHit() {
      hitElapsed = 0;
    },

    resetPose,

    updateAnimation(
      dt: number,
      vx: number,
      vz: number,
      aimX: number,
      aimZ: number,
      charge: number,
      alive: boolean
    ) {
      if (!alive) {
        return;
      }

      idleTime += dt;
      shoveElapsed += dt;
      hitElapsed += dt;

      // 1. Facing rotation: rotate root toward aim with a ~15°/frame cap (0.26 rad / 16ms)
      // Convention: MODEL_FORWARD = (0, 0, 1) (+Z forward). Target angle is Math.atan2(aimX, aimZ).
      const aimLen = Math.hypot(aimX, aimZ);
      if (aimLen > 0.001) {
        const targetAngle = Math.atan2(aimX, aimZ);
        let diff = targetAngle - currentFacingAngle;
        while (diff < -Math.PI) diff += Math.PI * 2;
        while (diff > Math.PI) diff -= Math.PI * 2;
        const maxStep = 0.26 * Math.max(1, dt * 60);
        const step = Math.max(-maxStep, Math.min(maxStep, diff));
        currentFacingAngle += step;
        root.rotation.y = currentFacingAngle;
        root.rotation.x = 0;
        root.rotation.z = 0;

        // Dev assertion: after facing settles (within ~3.5°), world-forward · aim must be > 0.98
        if (Math.abs(diff) < 0.06 && aimLen > 0.1) {
          _tempForward.copy(MODEL_FORWARD).applyQuaternion(root.quaternion);
          const normAimX = aimX / aimLen;
          const normAimZ = aimZ / aimLen;
          const dot = _tempForward.x * normAimX + _tempForward.z * normAimZ;
          lastFacingDot = dot;
          if (dot < 0.98) {
            if (!facingWarningLogged) {
              facingWarningLogged = true;
              console.warn(
                `[RINGOUT DEV ASSERTION FAILED] World forward does not match aim! dot=${dot.toFixed(4)} (< 0.98)`
              );
            }
          }
        }
      }

      // 2. Idle bob & sway (1.2 Hz)
      const idleBob = Math.sin(idleTime * 1.2 * Math.PI * 2) * 0.022;
      torsoGroup.position.y = idleBob;

      // 3. Walk cycle: speed / MAX_SPEED (6.5), stride frequency ≈ 1.6 * speed Hz
      const speed = Math.hypot(vx, vz);
      const speedFrac = Math.min(1, speed / 6.5);
      if (speed > 0.15) {
        const strideFreq = Math.max(1.0, 1.6 * speed);
        walkPhase += strideFreq * dt * Math.PI * 2;
      }

      const legSwingAmp = 0.65 * speedFrac;
      const legWave = Math.sin(walkPhase);

      thighL.rotation.x = legWave * legSwingAmp;
      thighR.rotation.x = -legWave * legSwingAmp;
      shinL.rotation.x = Math.max(0, -legWave * legSwingAmp * 0.85);
      shinR.rotation.x = Math.max(0, legWave * legSwingAmp * 0.85);

      const armSwingAmp = 0.60 * speedFrac;
      let armLX = -legWave * armSwingAmp + Math.sin(idleTime * 1.2 * Math.PI * 2) * 0.06;
      let armRX = legWave * armSwingAmp - Math.sin(idleTime * 1.2 * Math.PI * 2) * 0.06;
      let lowerArmLX = 0.12 + Math.max(0, legWave * 0.25 * speedFrac);
      let lowerArmRX = 0.12 + Math.max(0, -legWave * 0.25 * speedFrac);

      const torsoLean = 0.105 * speedFrac;
      tiltPivot.rotation.x = torsoLean;
      tiltPivot.rotation.y = 0;
      tiltPivot.rotation.z = 0;

      // 4. Charge state: both arms pull back, torso coils ~10°, visor brightens
      const chargeClamped = Math.max(0, Math.min(1, charge));
      if (chargeClamped > 0.01) {
        armLX = THREE.MathUtils.lerp(armLX, -0.65, chargeClamped);
        armRX = THREE.MathUtils.lerp(armRX, -0.65, chargeClamped);
        lowerArmLX = THREE.MathUtils.lerp(lowerArmLX, 0.85, chargeClamped);
        lowerArmRX = THREE.MathUtils.lerp(lowerArmRX, 0.85, chargeClamped);
        torsoGroup.rotation.y = -0.175 * chargeClamped;
        visorMat.emissiveIntensity = (isSelf ? 0.38 : 0.30) + 0.65 * chargeClamped;
      } else {
        torsoGroup.rotation.y = 0;
        visorMat.emissiveIntensity = isSelf ? 0.38 : 0.30;
      }

      // 5. Shove punch animation: 60ms anticipation then 140ms punch along facing
      if (shoveElapsed <= 0.20) {
        if (shoveElapsed < 0.06) {
          const antT = shoveElapsed / 0.06;
          armLX = -0.75 * antT;
          armRX = -0.75 * antT;
          lowerArmLX = 0.95 * antT;
          lowerArmRX = 0.95 * antT;
          torsoGroup.rotation.y = -0.22 * antT;
        } else {
          const punchT = (shoveElapsed - 0.06) / 0.14;
          const punchCurve = Math.sin(punchT * Math.PI);
          armRX = 1.45 * punchCurve;
          lowerArmRX = 0.05;
          armLX = -0.45 * punchCurve;
          lowerArmLX = 0.85 * (1 - punchCurve * 0.5);
          torsoGroup.rotation.y = 0.22 * punchCurve;
          tiltPivot.rotation.x = torsoLean + 0.16 * punchCurve;
        }
      }

      // 6. Hit recoil animation (120ms recoil away from impulse, applied to tiltPivot)
      if (hitElapsed <= 0.12) {
        const recoil = 1 - hitElapsed / 0.12;
        tiltPivot.rotation.x = torsoLean - 0.26 * recoil;
        tiltPivot.rotation.z = (Math.sin(hitElapsed * 40) > 0 ? 0.14 : -0.14) * recoil;
        upperArmL.rotation.z = -0.38 * recoil;
        upperArmR.rotation.z = 0.38 * recoil;
      } else {
        upperArmL.rotation.z = 0;
        upperArmR.rotation.z = 0;
      }

      upperArmL.rotation.x = armLX;
      lowerArmL.rotation.x = lowerArmLX;
      upperArmR.rotation.x = armRX;
      lowerArmR.rotation.x = lowerArmRX;
    },

    dispose() {
      bodyMesh.geometry.dispose();
      accentMesh.geometry.dispose();
      visorMesh.geometry.dispose();
      for (const g of limbGeosToDispose) {
        g.dispose();
      }

      bodyMat.dispose();
      alloyMat.dispose();
      accentMat.dispose();
      visorMat.dispose();
    },
  };
}

// Multi-robot instanced limbs manager: renders all 8 limb types across all 4 robots in 8 draw calls total
export type InstancedLimbsManager = {
  updateInstance: (
    slotIdx: number,
    robot: RobotRig,
    alive: boolean,
    scale: number,
    posY: number
  ) => void;
  commit: () => void;
  dispose: () => void;
};

export function createInstancedLimbsManager(scene: THREE.Scene): InstancedLimbsManager {
  const sharedBodyMat = new THREE.MeshStandardMaterial({
    color: 0x1f2329,
    metalness: 0.85,
    roughness: 0.32,
  });

  const upperArmLGeo = createMergedLimbGeometry(0.07, 0.13, 0.22, 0.13, -0.11);
  const lowerArmLGeo = createMergedLimbGeometry(0.06, 0.14, 0.22, 0.14, -0.11);
  const upperArmRGeo = createMergedLimbGeometry(0.07, 0.13, 0.22, 0.13, -0.11);
  const lowerArmRGeo = createMergedLimbGeometry(0.06, 0.14, 0.22, 0.14, -0.11);
  const thighLGeo = createMergedLimbGeometry(0.07, 0.15, 0.26, 0.15, -0.13);
  const shinLGeo = createMergedLimbGeometry(0.065, 0.16, 0.32, 0.18, -0.16, 0.01);
  const thighRGeo = createMergedLimbGeometry(0.07, 0.15, 0.26, 0.15, -0.13);
  const shinRGeo = createMergedLimbGeometry(0.065, 0.16, 0.32, 0.18, -0.16, 0.01);

  const instUpperArmL = new THREE.InstancedMesh(upperArmLGeo, sharedBodyMat, 4);
  const instLowerArmL = new THREE.InstancedMesh(lowerArmLGeo, sharedBodyMat, 4);
  const instUpperArmR = new THREE.InstancedMesh(upperArmRGeo, sharedBodyMat, 4);
  const instLowerArmR = new THREE.InstancedMesh(lowerArmRGeo, sharedBodyMat, 4);
  const instThighL = new THREE.InstancedMesh(thighLGeo, sharedBodyMat, 4);
  const instShinL = new THREE.InstancedMesh(shinLGeo, sharedBodyMat, 4);
  const instThighR = new THREE.InstancedMesh(thighRGeo, sharedBodyMat, 4);
  const instShinR = new THREE.InstancedMesh(shinRGeo, sharedBodyMat, 4);

  const instancedList = [
    instUpperArmL,
    instLowerArmL,
    instUpperArmR,
    instLowerArmR,
    instThighL,
    instShinL,
    instThighR,
    instShinR,
  ];

  for (const m of instancedList) {
    m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    scene.add(m);
  }

  const zeroMat = new THREE.Matrix4().makeScale(0, 0, 0);

  return {
    updateInstance(
      slotIdx: number,
      robot: RobotRig,
      alive: boolean,
      scale: number,
      posY: number
    ) {
      if (slotIdx < 0 || slotIdx >= 4) return;
      if (!alive || scale <= 0.001) {
        for (const m of instancedList) {
          m.setMatrixAt(slotIdx, zeroMat);
        }
        return;
      }

      robot.group.updateMatrixWorld(true);

      instUpperArmL.setMatrixAt(slotIdx, robot.upperArmL.matrixWorld);
      instLowerArmL.setMatrixAt(slotIdx, robot.lowerArmL.matrixWorld);
      instUpperArmR.setMatrixAt(slotIdx, robot.upperArmR.matrixWorld);
      instLowerArmR.setMatrixAt(slotIdx, robot.lowerArmR.matrixWorld);
      instThighL.setMatrixAt(slotIdx, robot.thighL.matrixWorld);
      instShinL.setMatrixAt(slotIdx, robot.shinL.matrixWorld);
      instThighR.setMatrixAt(slotIdx, robot.thighR.matrixWorld);
      instShinR.setMatrixAt(slotIdx, robot.shinR.matrixWorld);
    },

    commit() {
      for (const m of instancedList) {
        m.instanceMatrix.needsUpdate = true;
      }
    },

    dispose() {
      for (const m of instancedList) {
        scene.remove(m);
        m.geometry.dispose();
      }
      sharedBodyMat.dispose();
    },
  };
}
