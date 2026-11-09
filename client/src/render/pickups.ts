import * as THREE from 'three';
import { PICKUP_ARM_S } from '../../../shared/src/constants';

/**
 * Pickups on the floor: a glowing core, a ring and a beam tall enough to see from across the
 * arena. The beam is the point — a contested resource is only a race if both players can see
 * it coming, so nothing here is subtle or occluded.
 */

export type PickupRow = {
  id: bigint;
  kind: number;
  px: number;
  pz: number;
};

const COLORS: Record<number, number> = {
  1: 0xffb020, // POWER — amber
  2: 0x35e6c4, // HASTE — teal
  3: 0xff3b5c, // HEAVY — red
};

const NAMES: Record<number, string> = { 1: 'POWER', 2: 'HASTE', 3: 'SLOWED' };

export function pickupColor(kind: number): number {
  return COLORS[kind] ?? 0xffffff;
}

export function boostName(kind: number): string {
  return NAMES[kind] ?? '';
}

export function boostColorCss(kind: number): string {
  return `#${pickupColor(kind).toString(16).padStart(6, '0')}`;
}

type PickupVisual = {
  group: THREE.Group;
  core: THREE.Mesh;
  coreMaterial: THREE.MeshStandardMaterial;
  ring: THREE.Mesh;
  ringMaterial: THREE.MeshBasicMaterial;
  /** Flat marker on the floor: the camera looks down, so a vertical beam is invisible. */
  halo: THREE.Mesh;
  haloMaterial: THREE.MeshBasicMaterial;
  kind: number;
  appearedAt: number;
};

type Burst = {
  mesh: THREE.Mesh;
  material: THREE.MeshBasicMaterial;
  elapsed: number;
  duration: number;
  maxScale: number;
};

export type PickupRenderer = {
  sync: (rows: PickupRow[], nowMs: number) => void;
  update: (dt: number, nowMs: number) => void;
  burst: (x: number, z: number, kind: number) => void;
  dispose: () => void;
};

export function createPickupRenderer(scene: THREE.Scene): PickupRenderer {
  const visuals = new Map<string, PickupVisual>();
  const bursts: Burst[] = [];

  // One shared geometry set; the material is per pickup because the colour is per kind.
  const coreGeometry = new THREE.OctahedronGeometry(0.3, 0);
  const ringGeometry = new THREE.TorusGeometry(0.46, 0.035, 8, 28);
  const haloGeometry = new THREE.RingGeometry(0.62, 0.82, 36);
  const burstGeometry = new THREE.RingGeometry(0.2, 0.3, 24);

  function createVisual(kind: number, nowMs: number): PickupVisual {
    const color = pickupColor(kind);
    const group = new THREE.Group();

    const coreMaterial = new THREE.MeshStandardMaterial({
      color,
      emissive: color,
      emissiveIntensity: 1.6,
      metalness: 0.3,
      roughness: 0.25,
    });
    const core = new THREE.Mesh(coreGeometry, coreMaterial);
    core.position.y = 0.6;

    const ringMaterial = new THREE.MeshBasicMaterial({
      color,
      transparent: true,
      opacity: 0.85,
      side: THREE.DoubleSide,
    });
    const ring = new THREE.Mesh(ringGeometry, ringMaterial);
    ring.rotation.x = Math.PI / 2;
    ring.position.y = 0.6;

    const haloMaterial = new THREE.MeshBasicMaterial({
      color,
      transparent: true,
      opacity: 0.35,
      depthWrite: false,
      side: THREE.DoubleSide,
      blending: THREE.AdditiveBlending,
    });
    const halo = new THREE.Mesh(haloGeometry, haloMaterial);
    halo.rotation.x = -Math.PI / 2;
    halo.position.y = 0.03;

    group.add(core, ring, halo);
    scene.add(group);
    return { group, core, coreMaterial, ring, ringMaterial, halo, haloMaterial, kind, appearedAt: nowMs };
  }

  return {
    sync(rows, nowMs) {
      const seen = new Set<string>();
      for (const row of rows) {
        const key = row.id.toString();
        seen.add(key);
        let visual = visuals.get(key);
        if (!visual || visual.kind !== row.kind) {
          if (visual) {
            scene.remove(visual.group);
            visual.coreMaterial.dispose();
            visual.ringMaterial.dispose();
            visual.haloMaterial.dispose();
          }
          visual = createVisual(row.kind, nowMs);
          visuals.set(key, visual);
        }
        visual.group.position.set(row.px, 0, row.pz);
      }
      for (const [key, visual] of visuals) {
        if (seen.has(key)) continue;
        scene.remove(visual.group);
        visual.coreMaterial.dispose();
        visual.ringMaterial.dispose();
        visual.haloMaterial.dispose();
        visuals.delete(key);
      }
    },

    update(dt) {
      const now = performance.now();
      for (const visual of visuals.values()) {
        const age = (now - visual.appearedAt) / 1000;
        const armed = age >= PICKUP_ARM_S;
        visual.core.rotation.y += dt * 1.8;
        visual.core.rotation.x += dt * 0.6;
        visual.ring.rotation.z += dt * 1.2;
        const bob = Math.sin(now / 320 + visual.group.position.x) * 0.08;
        visual.core.position.y = 0.6 + bob;
        visual.ring.position.y = 0.6 + bob;
        // Unarmed pickups read as "still charging": small, dim, no beam.
        const targetScale = armed ? 1 : 0.55;
        visual.group.scale.lerp(new THREE.Vector3(targetScale, targetScale, targetScale), 0.15);
        const pulse = armed ? 0.4 + Math.sin(now / 240) * 0.18 : 0.12;
        visual.haloMaterial.opacity = pulse;
        const haloScale = 1 + (armed ? Math.sin(now / 300) * 0.06 : 0);
        visual.halo.scale.setScalar(haloScale);
        visual.coreMaterial.emissiveIntensity = armed ? 1.6 : 0.7;
        visual.ringMaterial.opacity = armed ? 0.85 : 0.3;
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
        const scale = 1 + t * burst.maxScale;
        burst.mesh.scale.setScalar(scale);
        burst.material.opacity = 0.9 * (1 - t);
      }
    },

    burst(x, z, kind) {
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
    },

    dispose() {
      for (const visual of visuals.values()) {
        scene.remove(visual.group);
        visual.coreMaterial.dispose();
        visual.ringMaterial.dispose();
        visual.haloMaterial.dispose();
      }
      visuals.clear();
      for (const burst of bursts) {
        scene.remove(burst.mesh);
        burst.material.dispose();
      }
      bursts.length = 0;
      coreGeometry.dispose();
      ringGeometry.dispose();
      haloGeometry.dispose();
      burstGeometry.dispose();
    },
  };
}
