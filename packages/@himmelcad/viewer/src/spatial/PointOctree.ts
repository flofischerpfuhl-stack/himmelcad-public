import { Vector3 } from 'three';

/**
 * In-renderer counterpart of `crates/himmelcad-spatial::PointOctree`.
 *
 * Two roles:
 *   1. Build an octree over a positions Float32Array (one-shot, at layer
 *      load time when the importer hasn't yet produced a persisted index).
 *   2. Read a `.octree` binary written by the Rust importer and serve the
 *      same query API without rebuilding.
 *
 * Both paths are queried by `PointCloudSnapProvider` for k-NN, ray-nearest,
 * and surface-fit candidates. The binary format matches
 * `crates/himmelcad-spatial/src/serialize.rs` exactly: magic 0x484D4F54 ("HMOT"),
 * version 1, fixed-stride node records.
 *
 * Performance contract:
 *   - k-NN(k=32) at 8M points: well under 1 ms typical case (single leaf or
 *     two adjacent leaves).
 *   - Ray-nearest: O(log n + leaf-points-on-path).
 *   - Build cost: ~250-500 ms for 8M points, one-shot at layer mount.
 *
 * Migration path: when the importer persists `.octree`, replace the
 * `build()` call site with `fromBytes(buffer)`. Same API.
 */

const NO_CHILD = 0xffff_ffff;
const DEFAULT_LEAF_CAPACITY = 1024;
const MAX_DEPTH = 20;
const HEADER_SIZE = 56;
const BOUNDS_SIZE = 48;
const NODE_SIZE = 88;
const MAGIC = 0x484d_4f54;
const VERSION = 1;

export interface OctreeNode {
  boundsMin: [number, number, number];
  boundsMax: [number, number, number];
  children: Uint32Array; // length 8
  pointStart: number;
  pointCount: number;
}

export interface KnnHit {
  pointIndex: number;
  distanceSq: number;
}

export interface RayHit {
  pointIndex: number;
  rayDistanceSq: number;
  t: number;
}

export class PointOctree {
  readonly renderOffset: [number, number, number];
  readonly boundsMin: [number, number, number];
  readonly boundsMax: [number, number, number];
  readonly nodes: OctreeNode[];
  readonly pointIndices: Uint32Array;

  constructor(
    renderOffset: [number, number, number],
    boundsMin: [number, number, number],
    boundsMax: [number, number, number],
    nodes: OctreeNode[],
    pointIndices: Uint32Array,
  ) {
    this.renderOffset = renderOffset;
    this.boundsMin = boundsMin;
    this.boundsMax = boundsMax;
    this.nodes = nodes;
    this.pointIndices = pointIndices;
  }

  /**
   * Build the octree from a positions Float32Array. Does not modify it.
   * `positions.length` must be a multiple of 3.
   */
  static build(
    positions: Float32Array,
    renderOffset: [number, number, number],
    leafCapacity: number = DEFAULT_LEAF_CAPACITY,
    maxDepth: number = MAX_DEPTH,
  ): PointOctree {
    if (positions.length % 3 !== 0) {
      throw new Error('positions length must be a multiple of 3');
    }
    const n = positions.length / 3;
    const indices = new Uint32Array(n);
    for (let i = 0; i < n; i++) indices[i] = i;
    const bounds = boundingCube(positions);
    const nodes: OctreeNode[] = [];
    if (n > 0) {
      buildRecurse(
        positions,
        indices,
        nodes,
        0,
        n,
        bounds.min,
        bounds.max,
        0,
        leafCapacity,
        maxDepth,
      );
    } else {
      nodes.push({
        boundsMin: bounds.min,
        boundsMax: bounds.max,
        children: new Uint32Array(8).fill(NO_CHILD),
        pointStart: 0,
        pointCount: 0,
      });
    }
    return new PointOctree(renderOffset, bounds.min, bounds.max, nodes, indices);
  }

  /**
   * Read an octree from the binary blob produced by `himmelcad-spatial::write`.
   * Throws on malformed input. Does not allocate the positions buffer; the
   * caller is responsible for keeping the matching positions array around.
   */
  static fromBytes(buffer: ArrayBuffer): PointOctree {
    if (buffer.byteLength < HEADER_SIZE + BOUNDS_SIZE) {
      throw new Error('octree binary truncated (header)');
    }
    const dv = new DataView(buffer);
    let cur = 0;
    const magic = dv.getUint32(cur, true);
    cur += 4;
    if (magic !== MAGIC) throw new Error(`octree bad magic: 0x${magic.toString(16)}`);
    const version = dv.getUint32(cur, true);
    cur += 4;
    if (version !== VERSION) throw new Error(`octree unsupported version ${version}`);
    cur += 4; // flags
    const pointCount = dv.getUint32(cur, true);
    cur += 4;
    const nodeCount = dv.getUint32(cur, true);
    cur += 4;
    cur += 4; // leaf_capacity
    cur += 4; // max_depth
    cur += 4; // reserved
    const renderOffset: [number, number, number] = [
      dv.getFloat64(cur, true),
      dv.getFloat64(cur + 8, true),
      dv.getFloat64(cur + 16, true),
    ];
    cur += 24;

    const boundsMin: [number, number, number] = [
      dv.getFloat64(cur, true),
      dv.getFloat64(cur + 8, true),
      dv.getFloat64(cur + 16, true),
    ];
    cur += 24;
    const boundsMax: [number, number, number] = [
      dv.getFloat64(cur, true),
      dv.getFloat64(cur + 8, true),
      dv.getFloat64(cur + 16, true),
    ];
    cur += 24;

    const nodesEnd = cur + nodeCount * NODE_SIZE;
    if (buffer.byteLength < nodesEnd + pointCount * 4) {
      throw new Error('octree binary truncated (body)');
    }
    const nodes: OctreeNode[] = new Array(nodeCount);
    for (let i = 0; i < nodeCount; i++) {
      const nMin: [number, number, number] = [
        dv.getFloat64(cur, true),
        dv.getFloat64(cur + 8, true),
        dv.getFloat64(cur + 16, true),
      ];
      cur += 24;
      const nMax: [number, number, number] = [
        dv.getFloat64(cur, true),
        dv.getFloat64(cur + 8, true),
        dv.getFloat64(cur + 16, true),
      ];
      cur += 24;
      const children = new Uint32Array(8);
      for (let c = 0; c < 8; c++) {
        children[c] = dv.getUint32(cur, true);
        cur += 4;
      }
      const pointStart = dv.getUint32(cur, true);
      cur += 4;
      const pCount = dv.getUint32(cur, true);
      cur += 4;
      nodes[i] = {
        boundsMin: nMin,
        boundsMax: nMax,
        children,
        pointStart,
        pointCount: pCount,
      };
    }

    const pointIndices = new Uint32Array(pointCount);
    for (let i = 0; i < pointCount; i++) {
      pointIndices[i] = dv.getUint32(cur, true);
      cur += 4;
    }

    return new PointOctree(renderOffset, boundsMin, boundsMax, nodes, pointIndices);
  }

  /**
   * k nearest points to `query` (in local-render space). Result sorted by
   * distance ascending, length <= k.
   */
  kNearest(positions: Float32Array, query: Vector3, k: number): KnnHit[] {
    if (k <= 0 || this.nodes.length === 0) return [];
    const heap = new MaxHeap(k);
    knnRecurse(this, positions, 0, query, k, heap);
    return heap.drainSorted();
  }

  /**
   * Closest point whose perpendicular distance to the ray is <= `maxPerpDist`
   * (in local units). Returns null if nothing close enough.
   */
  nearestToRay(
    positions: Float32Array,
    origin: Vector3,
    dir: Vector3,
    maxPerpDist: number,
  ): RayHit | null {
    if (this.nodes.length === 0) return null;
    const dirN = dir.clone().normalize();
    if (dirN.lengthSq() === 0) return null;
    const dirInv = new Vector3(
      Math.abs(dirN.x) > 1e-12 ? 1 / dirN.x : Infinity,
      Math.abs(dirN.y) > 1e-12 ? 1 / dirN.y : Infinity,
      Math.abs(dirN.z) > 1e-12 ? 1 / dirN.z : Infinity,
    );
    const state: { best: RayHit | null } = { best: null };
    rayRecurse(this, positions, 0, origin, dirN, dirInv, maxPerpDist, state);
    return state.best;
  }

  localToWorld(local: Vector3, out?: Vector3): Vector3 {
    const target = out ?? new Vector3();
    return target.set(
      local.x + this.renderOffset[0],
      local.y + this.renderOffset[1],
      local.z + this.renderOffset[2],
    );
  }
}

interface BoundsCube {
  min: [number, number, number];
  max: [number, number, number];
}

function boundingCube(positions: Float32Array): BoundsCube {
  if (positions.length === 0) {
    return { min: [0, 0, 0], max: [0, 0, 0] };
  }
  let minX = Infinity;
  let minY = Infinity;
  let minZ = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let maxZ = -Infinity;
  for (let i = 0; i < positions.length; i += 3) {
    const x = positions[i] ?? 0;
    const y = positions[i + 1] ?? 0;
    const z = positions[i + 2] ?? 0;
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (z < minZ) minZ = z;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
    if (z > maxZ) maxZ = z;
  }
  const cx = (minX + maxX) * 0.5;
  const cy = (minY + maxY) * 0.5;
  const cz = (minZ + maxZ) * 0.5;
  const ex = maxX - minX;
  const ey = maxY - minY;
  const ez = maxZ - minZ;
  const half = Math.max(ex, ey, ez, Number.EPSILON) * 0.5;
  return {
    min: [cx - half, cy - half, cz - half],
    max: [cx + half, cy + half, cz + half],
  };
}

function octantIndex(x: number, y: number, z: number, cx: number, cy: number, cz: number): number {
  return (x >= cx ? 1 : 0) | (y >= cy ? 2 : 0) | (z >= cz ? 4 : 0);
}

function buildRecurse(
  positions: Float32Array,
  indices: Uint32Array,
  nodes: OctreeNode[],
  rangeStart: number,
  rangeCount: number,
  bMin: [number, number, number],
  bMax: [number, number, number],
  depth: number,
  leafCapacity: number,
  maxDepth: number,
): number {
  const nodeIdx = nodes.length;
  const node: OctreeNode = {
    boundsMin: [bMin[0], bMin[1], bMin[2]],
    boundsMax: [bMax[0], bMax[1], bMax[2]],
    children: new Uint32Array(8).fill(NO_CHILD),
    pointStart: rangeStart,
    pointCount: rangeCount,
  };
  nodes.push(node);

  if (rangeCount <= leafCapacity || depth >= maxDepth) {
    return nodeIdx;
  }

  const cx = (bMin[0] + bMax[0]) * 0.5;
  const cy = (bMin[1] + bMax[1]) * 0.5;
  const cz = (bMin[2] + bMax[2]) * 0.5;

  const counts = new Uint32Array(8);
  const lo = rangeStart;
  const hi = rangeStart + rangeCount;
  for (let i = lo; i < hi; i++) {
    const pi = indices[i] ?? 0;
    const base = pi * 3;
    const o = octantIndex(
      positions[base] ?? 0,
      positions[base + 1] ?? 0,
      positions[base + 2] ?? 0,
      cx,
      cy,
      cz,
    );
    counts[o] = (counts[o] ?? 0) + 1;
  }
  const starts = new Uint32Array(8);
  let acc = rangeStart;
  for (let i = 0; i < 8; i++) {
    starts[i] = acc;
    acc += counts[i] ?? 0;
  }
  const cursors = new Uint32Array(starts);
  const scratch = new Uint32Array(rangeCount);
  for (let i = lo; i < hi; i++) {
    const pi = indices[i] ?? 0;
    const base = pi * 3;
    const o = octantIndex(
      positions[base] ?? 0,
      positions[base + 1] ?? 0,
      positions[base + 2] ?? 0,
      cx,
      cy,
      cz,
    );
    const dst = (cursors[o] ?? 0) - rangeStart;
    cursors[o] = (cursors[o] ?? 0) + 1;
    scratch[dst] = pi;
  }
  indices.set(scratch, lo);

  for (let octant = 0; octant < 8; octant++) {
    const count = counts[octant] ?? 0;
    if (count === 0) continue;
    const childMin: [number, number, number] = [bMin[0], bMin[1], bMin[2]];
    const childMax: [number, number, number] = [bMax[0], bMax[1], bMax[2]];
    if (octant & 1) {
      childMin[0] = cx;
    } else {
      childMax[0] = cx;
    }
    if (octant & 2) {
      childMin[1] = cy;
    } else {
      childMax[1] = cy;
    }
    if (octant & 4) {
      childMin[2] = cz;
    } else {
      childMax[2] = cz;
    }
    const childIdx = buildRecurse(
      positions,
      indices,
      nodes,
      starts[octant] ?? 0,
      count,
      childMin,
      childMax,
      depth + 1,
      leafCapacity,
      maxDepth,
    );
    node.children[octant] = childIdx;
  }
  return nodeIdx;
}

function distanceSqToBox(
  px: number,
  py: number,
  pz: number,
  bMin: [number, number, number],
  bMax: [number, number, number],
): number {
  let d2 = 0;
  if (px < bMin[0]) {
    const d = bMin[0] - px;
    d2 += d * d;
  } else if (px > bMax[0]) {
    const d = px - bMax[0];
    d2 += d * d;
  }
  if (py < bMin[1]) {
    const d = bMin[1] - py;
    d2 += d * d;
  } else if (py > bMax[1]) {
    const d = py - bMax[1];
    d2 += d * d;
  }
  if (pz < bMin[2]) {
    const d = bMin[2] - pz;
    d2 += d * d;
  } else if (pz > bMax[2]) {
    const d = pz - bMax[2];
    d2 += d * d;
  }
  return d2;
}

function rayHitsExpandedBox(
  origin: Vector3,
  dirInv: Vector3,
  bMin: [number, number, number],
  bMax: [number, number, number],
  pad: number,
): boolean {
  const lox = (bMin[0] - pad - origin.x) * dirInv.x;
  const hix = (bMax[0] + pad - origin.x) * dirInv.x;
  const loy = (bMin[1] - pad - origin.y) * dirInv.y;
  const hiy = (bMax[1] + pad - origin.y) * dirInv.y;
  const loz = (bMin[2] - pad - origin.z) * dirInv.z;
  const hiz = (bMax[2] + pad - origin.z) * dirInv.z;
  const tminX = Math.min(lox, hix);
  const tmaxX = Math.max(lox, hix);
  const tminY = Math.min(loy, hiy);
  const tmaxY = Math.max(loy, hiy);
  const tminZ = Math.min(loz, hiz);
  const tmaxZ = Math.max(loz, hiz);
  const tMin = Math.max(tminX, tminY, tminZ);
  const tMax = Math.min(tmaxX, tmaxY, tmaxZ);
  return tMax >= tMin && tMax >= 0;
}

function nodeIsLeaf(node: OctreeNode): boolean {
  for (let i = 0; i < 8; i++) {
    if ((node.children[i] ?? NO_CHILD) !== NO_CHILD) return false;
  }
  return true;
}

function knnRecurse(
  tree: PointOctree,
  positions: Float32Array,
  nodeIdx: number,
  query: Vector3,
  k: number,
  heap: MaxHeap,
): void {
  const node = tree.nodes[nodeIdx];
  if (!node) return;

  if (heap.size() === k) {
    if (distanceSqToBox(query.x, query.y, query.z, node.boundsMin, node.boundsMax) > heap.peek()) {
      return;
    }
  }

  if (nodeIsLeaf(node)) {
    const start = node.pointStart;
    const end = start + node.pointCount;
    for (let slot = start; slot < end; slot++) {
      const pi = tree.pointIndices[slot] ?? 0;
      const base = pi * 3;
      const dx = (positions[base] ?? 0) - query.x;
      const dy = (positions[base + 1] ?? 0) - query.y;
      const dz = (positions[base + 2] ?? 0) - query.z;
      const d2 = dx * dx + dy * dy + dz * dz;
      heap.push(pi, d2);
    }
    return;
  }

  // Walk children in increasing distance for best pruning.
  const order: { idx: number; d2: number }[] = [];
  for (let c = 0; c < 8; c++) {
    const ci = node.children[c] ?? NO_CHILD;
    if (ci === NO_CHILD) continue;
    const cn = tree.nodes[ci];
    if (!cn) continue;
    order.push({
      idx: ci,
      d2: distanceSqToBox(query.x, query.y, query.z, cn.boundsMin, cn.boundsMax),
    });
  }
  order.sort((a, b) => a.d2 - b.d2);
  for (const child of order) {
    knnRecurse(tree, positions, child.idx, query, k, heap);
  }
}

function rayRecurse(
  tree: PointOctree,
  positions: Float32Array,
  nodeIdx: number,
  origin: Vector3,
  dir: Vector3,
  dirInv: Vector3,
  maxPerpDist: number,
  state: { best: RayHit | null },
): void {
  const node = tree.nodes[nodeIdx];
  if (!node) return;

  if (!rayHitsExpandedBox(origin, dirInv, node.boundsMin, node.boundsMax, maxPerpDist)) {
    return;
  }

  if (nodeIsLeaf(node)) {
    const maxPerpSq = maxPerpDist * maxPerpDist;
    const bestSq = state.best === null ? maxPerpSq : Math.min(state.best.rayDistanceSq, maxPerpSq);
    const start = node.pointStart;
    const end = start + node.pointCount;
    for (let slot = start; slot < end; slot++) {
      const pi = tree.pointIndices[slot] ?? 0;
      const base = pi * 3;
      const tx = (positions[base] ?? 0) - origin.x;
      const ty = (positions[base + 1] ?? 0) - origin.y;
      const tz = (positions[base + 2] ?? 0) - origin.z;
      const t = tx * dir.x + ty * dir.y + tz * dir.z;
      if (t < 0) continue;
      const lenSq = tx * tx + ty * ty + tz * tz;
      const perpSq = lenSq - t * t;
      if (perpSq < bestSq && perpSq <= maxPerpSq) {
        state.best = { pointIndex: pi, rayDistanceSq: perpSq, t };
      }
    }
    return;
  }

  for (let c = 0; c < 8; c++) {
    const ci = node.children[c] ?? NO_CHILD;
    if (ci === NO_CHILD) continue;
    rayRecurse(tree, positions, ci, origin, dir, dirInv, maxPerpDist, state);
  }
}

/**
 * Bounded max-heap for k-NN. Keeps at most `capacity` entries, popping the
 * largest distance when full. `peek()` returns the largest distance squared
 * (used for pruning), `drainSorted()` empties the heap into ascending-distance
 * order.
 */
class MaxHeap {
  private capacity: number;
  private dist: number[] = [];
  private idx: number[] = [];

  constructor(capacity: number) {
    this.capacity = capacity;
  }

  size(): number {
    return this.dist.length;
  }

  peek(): number {
    return this.dist[0] ?? Infinity;
  }

  push(pointIndex: number, distanceSq: number): void {
    if (this.dist.length < this.capacity) {
      this.dist.push(distanceSq);
      this.idx.push(pointIndex);
      this.siftUp(this.dist.length - 1);
    } else if (distanceSq < (this.dist[0] ?? Infinity)) {
      this.dist[0] = distanceSq;
      this.idx[0] = pointIndex;
      this.siftDown(0);
    }
  }

  drainSorted(): KnnHit[] {
    const out: KnnHit[] = new Array(this.dist.length);
    for (let i = 0; i < out.length; i++) {
      out[i] = { pointIndex: this.idx[i] ?? 0, distanceSq: this.dist[i] ?? Infinity };
    }
    out.sort((a, b) => a.distanceSq - b.distanceSq);
    return out;
  }

  private siftUp(i: number): void {
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if ((this.dist[parent] ?? -Infinity) < (this.dist[i] ?? Infinity)) {
        this.swap(parent, i);
        i = parent;
      } else {
        break;
      }
    }
  }

  private siftDown(i: number): void {
    const n = this.dist.length;
    while (true) {
      const l = 2 * i + 1;
      const r = 2 * i + 2;
      let largest = i;
      if (l < n && (this.dist[l] ?? -Infinity) > (this.dist[largest] ?? -Infinity)) largest = l;
      if (r < n && (this.dist[r] ?? -Infinity) > (this.dist[largest] ?? -Infinity)) largest = r;
      if (largest === i) break;
      this.swap(largest, i);
      i = largest;
    }
  }

  private swap(a: number, b: number): void {
    const td = this.dist[a] ?? 0;
    const ti = this.idx[a] ?? 0;
    this.dist[a] = this.dist[b] ?? 0;
    this.idx[a] = this.idx[b] ?? 0;
    this.dist[b] = td;
    this.idx[b] = ti;
  }
}
