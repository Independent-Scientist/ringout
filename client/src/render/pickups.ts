import * as THREE from 'three';
import { PICKUP_ARM_S } from '../../../shared/src/constants';
import { buildBoostGeometry } from './voxel-boosts';

/**
 * Pickups on the floor: a voxel object you can name from across the arena (a fist, a bolt,
 * a crystal cluster), floating over a flat halo. The camera looks down, so the readable cue
 * is the floor marker plus the silhouette, never a vertical beam.
 */

export type PickupRow = {
  id: bigint;
  kind: number;
  px: number;
  pz: number;
};

export { boostColorCss, boostName } from './boost-visuals';
import { boostColorHex } from './boost-visuals';

export function pickupColor(kind: number): number {
  return boostColorHex(kind);
}

type PickupVisual = {
  group: THREE.Group;
  mesh: THREE.Mesh;
  halo: THREE.Mesh;
  haloMaterial: THREE.MeshBasicMaterial;
  kind: number;
  appearedAt: number;
  spin: number;
};

type Burst = {
  mesh: THREE.Mesh;
  material: THREE.MeshBasicMaterial;
  elapsed: number;
  duration: number;
  maxScale: number;
};

export type PickupRenderer = {
  count: () => number;
  sync: (rows: PickupRow[], nowMs: number) => void;
  update: (dt: number, nowMs: number) => void;
  burst: (x: number, z: number, kind: number) => void;
  dispose: () => void;
};

export function createPickupRenderer(scene: THREE.Scene): PickupRenderer {
  const visuals = new Map<string, PickupVisual>();
  const bursts: Burst[] = [];
  const shared = new Map<number, { geometry: THREE.BufferGeometry; material: THREE.MeshStandardMaterial }>();

  const haloGeometry = new THREE.RingGeometry(0.62, 0.82, 36);
  const burstGeometry = new THREE.RingGeometry(0.2, 0.3, 24);

  /** Geometry and material are shared per kind: two pickups of one kind are one upload. */
  function assetsFor(kind: number) {
    let assets = shared.get(kind);
    if (!assets) {
      const color = pickupColor(kind);
      // POWER already sits on the brightest hue of the three; it needs the least glow.
      const glow = kind === 1 ? 0.1 : 0.14;
      assets = {
        geometry: buildBoostGeometry(kind, color),
        material: new THREE.MeshStandardMaterial({
          vertexColors: true,
          emissive: new THREE.Color(color).multiplyScalar(glow),
          metalness: 0.15,
          roughness: 0.4,
          emissiveIntensity: 1.0,
        }),
      };
      shared.set(kind, assets);
    }
    return assets;
  }

  function createVisual(kind: number, nowMs: number): PickupVisual {
    const group = new THREE.Group();
    const assets = assetsFor(kind);

    // Tilt the object toward the camera: from a 55-degree overhead view an upright voxel shape
    // is mostly silhouette-ed away, and the point is to name it without reading a caption.
    const tilt = new THREE.Group();
    tilt.rotation.x = -0.3;
    const mesh = new THREE.Mesh(assets.geometry, assets.material);
    tilt.add(mesh);

    const haloMaterial = new THREE.MeshBasicMaterial({
      color: pickupColor(kind),
      transparent: true,
      opacity: 0.35,
      depthWrite: false,
      side: THREE.DoubleSide,
      blending: THREE.AdditiveBlending,
    });
    const halo = new THREE.Mesh(haloGeometry, haloMaterial);
    halo.rotation.x = -Math.PI / 2;
    halo.position.y = 0.03;

    group.add(tilt, halo);
    scene.add(group);
    return {
      group,
      mesh,
      halo,
      haloMaterial,
      kind,
      appearedAt: nowMs,
      spin: kind === 2 ? 0.6 : 0.9,
    };
  }

  function ringBurst(x: number, z: number, kind: number): void {
    const material = new THREE.MeshBasicMaterial({
      color: pickupColor(kind),
      transparent: true,
      opacity: 0.9,
      side: THREE.DoubleSide,
      depthWrite: false,
    });
    const mesh = new THREE.Mesh(burstGeometry, material);
    mesh.rotation.x = -Math.PI / 2;
    mesh.position.set(x, 0.08, z);
    scene.add(mesh);
    bursts.push({ mesh, material, elapsed: 0, duration: 0.45, maxScale: 3.2 });
  }

  return {
    count: () => visuals.size,

    sync(rows, nowMs) {
      const seen = new Set<string>();
      for (const row of rows) {
        const key = row.id.toString();
        seen.add(key);
        let visual = visuals.get(key);
        if (!visual || visual.kind !== row.kind) {
          if (visual) {
            scene.remove(visual.group);
            visual.haloMaterial.dispose();
          }
          visual = createVisual(row.kind, nowMs);
          visuals.set(key, visual);
          // A spawn ring, so a boost landing across the arena still catches the eye.
          ringBurst(row.px, row.pz, row.kind);
        }
        visual.group.position.x = row.px;
        visual.group.position.z = row.pz;
      }
      for (const [key, visual] of visuals) {
        if (seen.has(key)) continue;
        scene.remove(visual.group);
        visual.haloMaterial.dispose();
        visuals.delete(key);
      }
    },

    update(dt) {
      const now = performance.now();
      for (const visual of visuals.values()) {
        const age = (now - visual.appearedAt) / 1000;
        const armed = age >= PICKUP_ARM_S;
        visual.mesh.rotation.y += dt * visual.spin;
        visual.group.position.y = 1.0 + Math.sin(now / 320 + visual.group.position.x) * 0.12;
        // Unarmed pickups read as "still charging": a little smaller and dimmer until the
        // arming tick, but never invisible — you have to be able to plan the race.
        const targetScale = armed ? 1 : 0.85;
        visual.group.scale.lerp(new THREE.Vector3(targetScale, targetScale, targetScale), 0.15);
        visual.haloMaterial.opacity = armed ? 0.4 + Math.sin(now / 240) * 0.18 : 0.26;
        visual.halo.scale.setScalar(1 + (armed ? Math.sin(now / 300) * 0.06 : 0));
      }

      for (let i = bursts.length - 1; i >= 0; i--) {
        const burst = bursts[i]!;
        burst.elapsed += dt;
        const t = burst.elapsed / burst.duration;
        if (t >= 1) {
          scene.remove(burst.mesh);
          burst.material.dispose();
          bursts.splice(i, 1);
          continue;
        }
        burst.mesh.scale.setScalar(1 + t * burst.maxScale);
        burst.material.opacity = 0.9 * (1 - t);
      }
    },

    burst: ringBurst,

    dispose() {
      for (const visual of visuals.values()) {
        scene.remove(visual.group);
        visual.haloMaterial.dispose();
      }
      visuals.clear();
      for (const burst of bursts) {
        scene.remove(burst.mesh);
        burst.material.dispose();
      }
      bursts.length = 0;
      for (const assets of shared.values()) {
        assets.geometry.dispose();
        assets.material.dispose();
      }
      shared.clear();
      haloGeometry.dispose();
      burstGeometry.dispose();
    },
  };
}
