import * as THREE from 'three';

export type FxEventPayload = {
  kind: string;
  x: number;
  z: number;
  dx?: number;
  dz?: number;
};

export type FxRenderer = {
  trigger: (event: FxEventPayload) => void;
  update: (dt: number) => void;
  dispose: () => void;
};

type ShoveArcInstance = {
  group: THREE.Group;
  mesh: THREE.Mesh;
  material: THREE.MeshBasicMaterial;
  active: boolean;
  elapsed: number;
  duration: number;
  maxScale: number;
};

type RingInstance = {
  mesh: THREE.Mesh;
  material: THREE.MeshBasicMaterial;
  active: boolean;
  elapsed: number;
  duration: number;
  maxScale: number;
};

type SparkBurstInstance = {
  group: THREE.Group;
  sparks: THREE.Mesh[];
  material: THREE.MeshBasicMaterial;
  active: boolean;
  elapsed: number;
  duration: number;
};

type DustPuffInstance = {
  group: THREE.Group;
  puffs: THREE.Mesh[];
  material: THREE.MeshBasicMaterial;
  active: boolean;
  elapsed: number;
  duration: number;
  dirX: number;
  dirZ: number;
  directional: boolean;
};

const POOL_SIZE = 8;
const SPARK_COUNT = 6;
const PUFF_COUNT = 5;
const SHOVE_ARC_THETA = (110 * Math.PI) / 180;

export function createFxRenderer(scene: THREE.Scene): FxRenderer {
  const shoveArcGeometry = new THREE.RingGeometry(
    0.50,
    0.78,
    24,
    1,
    -SHOVE_ARC_THETA / 2,
    SHOVE_ARC_THETA
  );
  const ringGeometry = new THREE.RingGeometry(0.45, 0.65, 32);
  const sparkGeometry = new THREE.BoxGeometry(0.12, 0.12, 0.38);
  const puffGeometry = new THREE.CircleGeometry(0.28, 12);

  const shoveArcs: ShoveArcInstance[] = [];
  const elimRings: RingInstance[] = [];
  const sparkBursts: SparkBurstInstance[] = [];
  const dustPuffs: DustPuffInstance[] = [];

  for (let i = 0; i < POOL_SIZE; i++) {
    const shoveMat = new THREE.MeshBasicMaterial({
      color: 0xffd18a,
      transparent: true,
      opacity: 0,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
      depthWrite: false,
    });
    const shoveMesh = new THREE.Mesh(shoveArcGeometry, shoveMat);
    shoveMesh.rotation.x = -Math.PI / 2;
    const shoveGroup = new THREE.Group();
    shoveGroup.add(shoveMesh);
    shoveGroup.position.y = 0.08;
    shoveGroup.visible = false;
    scene.add(shoveGroup);
    shoveArcs.push({
      group: shoveGroup,
      mesh: shoveMesh,
      material: shoveMat,
      active: false,
      elapsed: 0,
      duration: 0.25,
      maxScale: 3.8,
    });

    const elimMat = new THREE.MeshBasicMaterial({
      color: 0xf72585,
      transparent: true,
      opacity: 0,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
      depthWrite: false,
    });
    const elimMesh = new THREE.Mesh(ringGeometry, elimMat);
    elimMesh.rotation.x = -Math.PI / 2;
    elimMesh.position.y = 0.1;
    elimMesh.visible = false;
    scene.add(elimMesh);
    elimRings.push({
      mesh: elimMesh,
      material: elimMat,
      active: false,
      elapsed: 0,
      duration: 0.4,
      maxScale: 3.4,
    });

    const sparkMat = new THREE.MeshBasicMaterial({
      color: 0xffe49e,
      transparent: true,
      opacity: 0,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });
    const sparkGroup = new THREE.Group();
    sparkGroup.visible = false;
    const sparks: THREE.Mesh[] = [];
    for (let s = 0; s < SPARK_COUNT; s++) {
      const spark = new THREE.Mesh(sparkGeometry, sparkMat);
      const angle = (2 * Math.PI * s) / SPARK_COUNT;
      spark.rotation.y = angle;
      sparkGroup.add(spark);
      sparks.push(spark);
    }
    scene.add(sparkGroup);
    sparkBursts.push({
      group: sparkGroup,
      sparks,
      material: sparkMat,
      active: false,
      elapsed: 0,
      duration: 0.15,
    });

    const puffMat = new THREE.MeshBasicMaterial({
      color: 0xffb454,
      transparent: true,
      opacity: 0,
      side: THREE.DoubleSide,
      depthWrite: false,
    });
    const puffGroup = new THREE.Group();
    puffGroup.visible = false;
    const puffs: THREE.Mesh[] = [];
    for (let p = 0; p < PUFF_COUNT; p++) {
      const puff = new THREE.Mesh(puffGeometry, puffMat);
      puff.rotation.x = -Math.PI / 2;
      puffGroup.add(puff);
      puffs.push(puff);
    }
    scene.add(puffGroup);
    dustPuffs.push({
      group: puffGroup,
      puffs,
      material: puffMat,
      active: false,
      elapsed: 0,
      duration: 0.35,
      dirX: 0,
      dirZ: -1,
      directional: false,
    });
  }

  function spawnShoveArc(x: number, z: number, dx: number, dz: number) {
    const slot = shoveArcs.find((a) => !a.active) ?? shoveArcs[0]!;
    const len = Math.hypot(dx, dz);
    const ndx = len > 0.001 ? dx / len : 0;
    const ndz = len > 0.001 ? dz / len : -1;
    slot.active = true;
    slot.elapsed = 0;
    slot.group.position.set(x, 0.08, z);
    slot.group.rotation.y = -Math.atan2(ndz, ndx);
    slot.mesh.scale.setScalar(1);
    slot.material.opacity = 0.85;
    slot.group.visible = true;
  }

  function spawnRing(pool: RingInstance[], x: number, z: number) {
    const slot = pool.find((r) => !r.active) ?? pool[0]!;
    slot.active = true;
    slot.elapsed = 0;
    slot.mesh.position.set(x, slot.mesh.position.y, z);
    slot.mesh.scale.setScalar(1);
    slot.material.opacity = 0.8;
    slot.mesh.visible = true;
  }

  function spawnSparkBurst(x: number, z: number) {
    const slot = sparkBursts.find((b) => !b.active) ?? sparkBursts[0]!;
    slot.active = true;
    slot.elapsed = 0;
    slot.group.position.set(x, 0.95, z);
    slot.material.opacity = 1;
    slot.group.visible = true;
    for (let s = 0; s < slot.sparks.length; s++) {
      slot.sparks[s]!.position.set(0, 0, 0);
    }
  }

  function spawnDirectionalDustPuff(x: number, z: number, dx: number, dz: number) {
    const slot = dustPuffs.find((d) => !d.active) ?? dustPuffs[0]!;
    const len = Math.hypot(dx, dz);
    slot.active = true;
    slot.elapsed = 0;
    slot.duration = 0.25;
    slot.dirX = len > 0.001 ? dx / len : 0;
    slot.dirZ = len > 0.001 ? dz / len : -1;
    slot.directional = true;
    slot.group.position.set(x, 0.05, z);
    slot.material.opacity = 0.65;
    slot.group.visible = true;
    for (let p = 0; p < slot.puffs.length; p++) {
      slot.puffs[p]!.position.set(0, 0, 0);
      slot.puffs[p]!.scale.setScalar(0.4);
    }
  }

  function spawnDustPuff(x: number, z: number) {
    const slot = dustPuffs.find((d) => !d.active) ?? dustPuffs[0]!;
    slot.active = true;
    slot.elapsed = 0;
    slot.duration = 0.35;
    slot.directional = false;
    slot.group.position.set(x, 0.05, z);
    slot.material.opacity = 0.55;
    slot.group.visible = true;
    for (let p = 0; p < slot.puffs.length; p++) {
      slot.puffs[p]!.position.set(0, 0, 0);
      slot.puffs[p]!.scale.setScalar(0.5);
    }
  }

  function updateShoveArcPool(dt: number) {
    for (const item of shoveArcs) {
      if (!item.active) continue;
      item.elapsed += dt;
      const t = Math.min(1, item.elapsed / item.duration);
      const scale = 1 + (item.maxScale - 1) * t;
      item.mesh.scale.setScalar(scale);
      item.material.opacity = 0.85 * (1 - t);
      if (t >= 1) {
        item.active = false;
        item.group.visible = false;
      }
    }
  }

  function updateRingPool(pool: RingInstance[], dt: number) {
    for (const item of pool) {
      if (!item.active) continue;
      item.elapsed += dt;
      const t = Math.min(1, item.elapsed / item.duration);
      const scale = 1 + (item.maxScale - 1) * t;
      item.mesh.scale.setScalar(scale);
      item.material.opacity = 0.8 * (1 - t);
      if (t >= 1) {
        item.active = false;
        item.mesh.visible = false;
      }
    }
  }

  return {
    trigger(event: FxEventPayload) {
      if (event.kind === 'shove') {
        const dx = event.dx ?? 0;
        const dz = event.dz ?? -1;
        spawnShoveArc(event.x, event.z, dx, dz);
        spawnDirectionalDustPuff(event.x, event.z, dx, dz);
      } else if (event.kind === 'hit') {
        spawnSparkBurst(event.x, event.z);
      } else if (event.kind === 'elim') {
        spawnRing(elimRings, event.x, event.z);
        spawnDustPuff(event.x, event.z);
      }
    },

    update(dt: number) {
      updateShoveArcPool(dt);
      updateRingPool(elimRings, dt);

      for (const burst of sparkBursts) {
        if (!burst.active) continue;
        burst.elapsed += dt;
        const t = Math.min(1, burst.elapsed / burst.duration);
        const radius = 0.25 + 1.35 * t;
        for (let s = 0; s < burst.sparks.length; s++) {
          const angle = (2 * Math.PI * s) / SPARK_COUNT;
          burst.sparks[s]!.position.set(Math.sin(angle) * radius, 0, Math.cos(angle) * radius);
        }
        burst.material.opacity = 1 - t;
        if (t >= 1) {
          burst.active = false;
          burst.group.visible = false;
        }
      }

      for (const dust of dustPuffs) {
        if (!dust.active) continue;
        dust.elapsed += dt;
        const t = Math.min(1, dust.elapsed / dust.duration);
        if (dust.directional) {
          const perpX = -dust.dirZ;
          const perpZ = dust.dirX;
          for (let p = 0; p < dust.puffs.length; p++) {
            const spreadFrac = (p - (PUFF_COUNT - 1) / 2) / ((PUFF_COUNT - 1) / 2 || 1);
            const push = (0.35 + 1.2 * (p / (PUFF_COUNT - 1))) * t;
            const spread = spreadFrac * 0.26 * (0.6 + 0.6 * t);
            const mesh = dust.puffs[p]!;
            mesh.position.set(
              dust.dirX * push + perpX * spread,
              0.06 + 0.12 * t,
              dust.dirZ * push + perpZ * spread
            );
            mesh.scale.setScalar(0.4 + 0.85 * t);
          }
          dust.material.opacity = 0.65 * (1 - t);
        } else {
          const radius = 0.2 + 0.95 * t;
          for (let p = 0; p < dust.puffs.length; p++) {
            const angle = (2 * Math.PI * p) / PUFF_COUNT + 0.3;
            const mesh = dust.puffs[p]!;
            mesh.position.set(Math.cos(angle) * radius, 0.25 * t, Math.sin(angle) * radius);
            mesh.scale.setScalar(0.5 + 1.1 * t);
          }
          dust.material.opacity = 0.55 * (1 - t);
        }
        if (t >= 1) {
          dust.active = false;
          dust.group.visible = false;
        }
      }
    },

    dispose() {
      for (const a of shoveArcs) {
        scene.remove(a.group);
        a.material.dispose();
      }
      for (const r of elimRings) {
        scene.remove(r.mesh);
        r.material.dispose();
      }
      for (const b of sparkBursts) {
        scene.remove(b.group);
        b.material.dispose();
      }
      for (const d of dustPuffs) {
        scene.remove(d.group);
        d.material.dispose();
      }
      shoveArcGeometry.dispose();
      ringGeometry.dispose();
      sparkGeometry.dispose();
      puffGeometry.dispose();
    },
  };
}
