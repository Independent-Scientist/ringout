import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

/**
 * Voxel boost meshes, built from little boxes and merged into one geometry per kind.
 *
 * The point is recognition at a glance from across the disc: a fist for the heavy shove,
 * a bolt for speed, a shard cluster for the slow. Everything is derived from integer cell
 * lists so the shapes are cheap to tweak and identical on every client.
 */

const VOXEL = 0.15;

type Cell = [number, number, number];

/** Deterministic 0..1 from a cell, so the facets vary without a random seed. */
function shade(x: number, y: number, z: number): number {
  let h = (x * 73856093) ^ (y * 19349663) ^ (z * 83492791);
  h = (h ^ (h >>> 13)) >>> 0;
  return 0.82 + (h % 1000) / 1000 * 0.33;
}

function fistCells(): Cell[] {
  const cells: Cell[] = [];
  // Palm: 5 wide, 4 tall, 3 deep.
  for (let x = 0; x < 5; x++) for (let y = 0; y < 4; y++) for (let z = 0; z < 3; z++) cells.push([x, y, z]);
  // Curled fingers: a row protruding along the bottom front.
  for (let x = 1; x < 5; x++) cells.push([x, 0, 3]);
  // Thumb: a bar across the upper left of the front face.
  for (let y = 2; y < 4; y++) cells.push([0, y, 3]);
  cells.push([1, 3, 3]);
  // Wrist: narrower, below the palm.
  for (let x = 1; x < 4; x++) for (let y = -2; y < 0; y++) for (let z = 0; z < 3; z++) cells.push([x, y, z]);
  return cells;
}

/**
 * Lightning bolt: a bold stepped diagonal, three cells thick, wider at the kink. At the size
 * this is seen (roughly 30 px) a delicate zigzag turns to mush, so the silhouette is the
 * diagonal plus the kink, and nothing finer.
 */
function boltCells(): Cell[] {
  const cells: Cell[] = [];
  const add = (x: number, y: number) => {
    cells.push([x, y, 0], [x, y, 1]);
  };
  for (let y = 8; y <= 9; y++) for (let x = 3; x <= 5; x++) add(x, y);
  for (let y = 6; y <= 7; y++) for (let x = 2; x <= 4; x++) add(x, y);
  for (let y = 4; y <= 5; y++) for (let x = 1; x <= 4; x++) add(x, y);
  for (let y = 2; y <= 3; y++) for (let x = 1; x <= 3; x++) add(x, y);
  for (let y = 0; y <= 1; y++) for (let x = 0; x <= 2; x++) add(x, y);
  return cells;
}

function iceCells(): Cell[] {
  const cells: Cell[] = [];
  // A cluster, not a row: shards grow from one base, taper as they rise and lean into each
  // other. Thickness falls with height, which is what makes it read as ice rather than posts.
  const shard = (baseX: number, baseZ: number, height: number, drift: number, thickness: number) => {
    for (let i = 0; i < height; i++) {
      const x = baseX + Math.round(i * drift);
      const taper = Math.max(1, thickness - Math.floor(i / 2));
      for (let t = 0; t < taper; t++) cells.push([x, i, baseZ + t]);
    }
  };
  shard(-1, 0, 8, -0.18, 3);
  shard(1, 1, 10, 0.12, 3);
  shard(0, 3, 6, 0.0, 2);
  shard(-2, 2, 4, -0.25, 2);
  shard(2, 3, 5, 0.2, 2);
  // Fused base.
  for (let x = -2; x <= 2; x++) for (let z = 0; z <= 3; z++) cells.push([x, 0, z]);
  for (let x = -1; x <= 1; x++) for (let z = 1; z <= 2; z++) cells.push([x, 1, z]);
  return cells;
}

function cellsFor(kind: number): Cell[] {
  if (kind === 1) return fistCells();
  if (kind === 2) return boltCells();
  return iceCells();
}

/** One merged, vertex-coloured geometry for a boost kind, scaled to a common size. */
export function buildBoostGeometry(kind: number, color: number): THREE.BufferGeometry {
  const cells = cellsFor(kind);
  const base = new THREE.Color(color);
  const parts: THREE.BufferGeometry[] = [];

  for (const [x, y, z] of cells) {
    const box = new THREE.BoxGeometry(VOXEL * 0.96, VOXEL * 0.96, VOXEL * 0.96);
    box.translate(x * VOXEL, y * VOXEL, z * VOXEL);
    const brightness = shade(x, y, z);
    const tint = new THREE.Color(
      Math.min(1, base.r * brightness),
      Math.min(1, base.g * brightness),
      Math.min(1, base.b * brightness)
    );
    const vertexCount = box.getAttribute('position').count;
    const colors = new Float32Array(vertexCount * 3);
    for (let v = 0; v < vertexCount; v++) {
      colors[v * 3] = tint.r;
      colors[v * 3 + 1] = tint.g;
      colors[v * 3 + 2] = tint.b;
    }
    box.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    parts.push(box);
  }

  const merged = mergeGeometries(parts, false);
  for (const part of parts) part.dispose();
  if (!merged) throw new Error('voxel boost merge failed');

  // Centre on the origin and normalise the tallest dimension to ~0.95 world units, so a
  // fist, a bolt and a crystal cluster all read at the same size on the floor.
  merged.computeBoundingBox();
  const box = merged.boundingBox!;
  const centre = new THREE.Vector3();
  box.getCenter(centre);
  merged.translate(-centre.x, -box.min.y, -centre.z);
  merged.computeBoundingBox();
  const size = new THREE.Vector3();
  merged.boundingBox!.getSize(size);
  const tallest = Math.max(size.x, size.y, size.z);
  const scale = tallest > 0 ? 2.0 / tallest : 1;
  merged.scale(scale, scale, scale);
  merged.computeVertexNormals();
  return merged;
}
