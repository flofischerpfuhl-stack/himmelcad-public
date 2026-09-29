/**
 * Triangle-mesh utilities for the 3D-printing tools: vertex welding (the
 * kernel's render meshes duplicate vertices per B-rep face), edge-manifold
 * statistics, enclosed volume and a bounding-volume hierarchy for ray casts.
 * Pure TypeScript, no DOM, no OCCT: runs in the printability worker, in the
 * headless CLI and under `node:test`.
 */

export type Vec3 = [number, number, number];

export interface IndexedMesh {
  /** Flat `x, y, z` vertex coordinates, mm. */
  positions: Float32Array | Float64Array;
  /** Three vertex indices per triangle. */
  indices: Uint32Array;
}

export interface WeldedMesh {
  positions: Float64Array;
  indices: Uint32Array;
  /** Triangle index of the source mesh for every kept triangle (degenerate ones are dropped). */
  sourceTriangles: Uint32Array;
}

/**
 * Merges vertices closer than `tolerance` (mm). Adjacent B-rep faces share
 * the node positions of their common edge, so welding turns the per-face
 * render mesh into one connected surface. Triangles that collapse (two
 * corners on the same welded vertex) are dropped. Deterministic: vertices
 * keep first-seen order.
 */
export function weldMesh(mesh: IndexedMesh, tolerance = 1e-4): WeldedMesh {
  const { positions, indices } = mesh;
  const vertexCount = positions.length / 3;
  const cell = Math.max(tolerance, 1e-9);
  const grid = new Map<string, number[]>();
  const remap = new Uint32Array(vertexCount);
  const out: number[] = [];
  const tol2 = tolerance * tolerance;
  for (let v = 0; v < vertexCount; v += 1) {
    const x = positions[v * 3]!;
    const y = positions[v * 3 + 1]!;
    const z = positions[v * 3 + 2]!;
    const cx = Math.floor(x / cell);
    const cy = Math.floor(y / cell);
    const cz = Math.floor(z / cell);
    let found = -1;
    for (let dx = -1; dx <= 1 && found < 0; dx += 1) {
      for (let dy = -1; dy <= 1 && found < 0; dy += 1) {
        for (let dz = -1; dz <= 1 && found < 0; dz += 1) {
          const bucket = grid.get(`${cx + dx},${cy + dy},${cz + dz}`);
          if (!bucket) continue;
          for (const candidate of bucket) {
            const ex = out[candidate * 3]! - x;
            const ey = out[candidate * 3 + 1]! - y;
            const ez = out[candidate * 3 + 2]! - z;
            if (ex * ex + ey * ey + ez * ez <= tol2) {
              found = candidate;
              break;
            }
          }
        }
      }
    }
    if (found < 0) {
      found = out.length / 3;
      out.push(x, y, z);
      const key = `${cx},${cy},${cz}`;
      const bucket = grid.get(key);
      if (bucket) bucket.push(found);
      else grid.set(key, [found]);
    }
    remap[v] = found;
  }
  const kept: number[] = [];
  const source: number[] = [];
  const triangleCount = indices.length / 3;
  for (let t = 0; t < triangleCount; t += 1) {
    const a = remap[indices[t * 3]!]!;
    const b = remap[indices[t * 3 + 1]!]!;
    const c = remap[indices[t * 3 + 2]!]!;
    if (a === b || b === c || a === c) continue;
    kept.push(a, b, c);
    source.push(t);
  }
  return {
    positions: new Float64Array(out),
    indices: new Uint32Array(kept),
    sourceTriangles: new Uint32Array(source),
  };
}

export interface ManifoldStats {
  /** Every edge is shared by exactly two triangles with opposite winding. */
  watertight: boolean;
  /** Edges used by one triangle only (holes/gaps in the surface). */
  boundaryEdges: number;
  /** Edges used by more than two triangles. */
  nonManifoldEdges: number;
  /** Two-triangle edges whose triangles run the same way (inconsistent orientation). */
  inconsistentEdges: number;
  edges: number;
}

/** Edge-use statistics of a welded mesh (see {@link weldMesh}). */
export function manifoldStats(indices: Uint32Array): ManifoldStats {
  // Per undirected edge (lo, hi): how often it runs lo->hi and hi->lo.
  const uses = new Map<number, [number, number]>();
  const triangleCount = indices.length / 3;
  let vertexBound = 0;
  for (const index of indices) vertexBound = Math.max(vertexBound, index + 1);
  for (let t = 0; t < triangleCount; t += 1) {
    for (let k = 0; k < 3; k += 1) {
      const a = indices[t * 3 + k]!;
      const b = indices[t * 3 + ((k + 1) % 3)]!;
      const lo = Math.min(a, b);
      const hi = Math.max(a, b);
      const key = lo * vertexBound + hi;
      let entry = uses.get(key);
      if (!entry) {
        entry = [0, 0];
        uses.set(key, entry);
      }
      entry[a < b ? 0 : 1] += 1;
    }
  }
  let boundaryEdges = 0;
  let nonManifoldEdges = 0;
  let inconsistentEdges = 0;
  for (const [f, b] of uses.values()) {
    const total = f + b;
    if (total === 1) boundaryEdges += 1;
    else if (total > 2) nonManifoldEdges += 1;
    else if (f !== 1) inconsistentEdges += 1;
  }
  return {
    watertight: boundaryEdges === 0 && nonManifoldEdges === 0 && inconsistentEdges === 0,
    boundaryEdges,
    nonManifoldEdges,
    inconsistentEdges,
    edges: uses.size,
  };
}

/** Signed enclosed volume (mm³) by the divergence theorem; positive for outward winding. */
export function meshVolume(mesh: IndexedMesh): number {
  const { positions: p, indices } = mesh;
  let sum = 0;
  for (let t = 0; t < indices.length; t += 3) {
    const a = indices[t]! * 3;
    const b = indices[t + 1]! * 3;
    const c = indices[t + 2]! * 3;
    sum +=
      p[a]! * (p[b + 1]! * p[c + 2]! - p[b + 2]! * p[c + 1]!) -
      p[a + 1]! * (p[b]! * p[c + 2]! - p[b + 2]! * p[c]!) +
      p[a + 2]! * (p[b]! * p[c + 1]! - p[b + 1]! * p[c]!);
  }
  return sum / 6;
}

/** Unnormalised normal (length = 2 × area) of triangle `t`. */
export function triangleCross(mesh: IndexedMesh, t: number): Vec3 {
  const { positions: p, indices } = mesh;
  const a = indices[t * 3]! * 3;
  const b = indices[t * 3 + 1]! * 3;
  const c = indices[t * 3 + 2]! * 3;
  const ux = p[b]! - p[a]!;
  const uy = p[b + 1]! - p[a + 1]!;
  const uz = p[b + 2]! - p[a + 2]!;
  const vx = p[c]! - p[a]!;
  const vy = p[c + 1]! - p[a + 1]!;
  const vz = p[c + 2]! - p[a + 2]!;
  return [uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx];
}

// ---- BVH ray casting -------------------------------------------------------------

/**
 * Flat bounding-volume hierarchy over a mesh's triangles (median split on
 * the longest axis, leaves of up to {@link LEAF_SIZE} triangles).
 */
export interface Bvh {
  mesh: IndexedMesh;
  /** Per node: min xyz, max xyz. */
  bounds: Float64Array;
  /** Per node: left child (internal) or first triangle slot (leaf). */
  first: Int32Array;
  /** Per node: triangle count (leaf) or 0 (internal; right child = left + 1 is not assumed). */
  count: Int32Array;
  right: Int32Array;
  /** Triangle indices in leaf order. */
  triangles: Uint32Array;
}

const LEAF_SIZE = 6;

export function buildBvh(mesh: IndexedMesh): Bvh {
  const { positions: p, indices } = mesh;
  const n = indices.length / 3;
  const centroids = new Float64Array(n * 3);
  const triMin = new Float64Array(n * 3);
  const triMax = new Float64Array(n * 3);
  for (let t = 0; t < n; t += 1) {
    for (let axis = 0; axis < 3; axis += 1) {
      const a = p[indices[t * 3]! * 3 + axis]!;
      const b = p[indices[t * 3 + 1]! * 3 + axis]!;
      const c = p[indices[t * 3 + 2]! * 3 + axis]!;
      triMin[t * 3 + axis] = Math.min(a, b, c);
      triMax[t * 3 + axis] = Math.max(a, b, c);
      centroids[t * 3 + axis] = (a + b + c) / 3;
    }
  }
  const order = new Uint32Array(n);
  for (let t = 0; t < n; t += 1) order[t] = t;
  const maxNodes = 2 * n + 1;
  const bounds = new Float64Array(maxNodes * 6);
  const first = new Int32Array(maxNodes);
  const count = new Int32Array(maxNodes);
  const right = new Int32Array(maxNodes);
  let nodes = 0;

  const build = (start: number, end: number): number => {
    const node = nodes;
    nodes += 1;
    let minX = Infinity;
    let minY = Infinity;
    let minZ = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    let maxZ = -Infinity;
    let cminX = Infinity;
    let cminY = Infinity;
    let cminZ = Infinity;
    let cmaxX = -Infinity;
    let cmaxY = -Infinity;
    let cmaxZ = -Infinity;
    for (let i = start; i < end; i += 1) {
      const t = order[i]!;
      minX = Math.min(minX, triMin[t * 3]!);
      minY = Math.min(minY, triMin[t * 3 + 1]!);
      minZ = Math.min(minZ, triMin[t * 3 + 2]!);
      maxX = Math.max(maxX, triMax[t * 3]!);
      maxY = Math.max(maxY, triMax[t * 3 + 1]!);
      maxZ = Math.max(maxZ, triMax[t * 3 + 2]!);
      cminX = Math.min(cminX, centroids[t * 3]!);
      cminY = Math.min(cminY, centroids[t * 3 + 1]!);
      cminZ = Math.min(cminZ, centroids[t * 3 + 2]!);
      cmaxX = Math.max(cmaxX, centroids[t * 3]!);
      cmaxY = Math.max(cmaxY, centroids[t * 3 + 1]!);
      cmaxZ = Math.max(cmaxZ, centroids[t * 3 + 2]!);
    }
    bounds.set([minX, minY, minZ, maxX, maxY, maxZ], node * 6);
    const size = end - start;
    const ex = cmaxX - cminX;
    const ey = cmaxY - cminY;
    const ez = cmaxZ - cminZ;
    if (size <= LEAF_SIZE || Math.max(ex, ey, ez) <= 0) {
      first[node] = start;
      count[node] = size;
      return node;
    }
    const axis = ex >= ey && ex >= ez ? 0 : ey >= ez ? 1 : 2;
    const mid = start + (size >> 1);
    // Partial sort around the median (nth_element via quickselect).
    quickselect(order, start, end - 1, mid, (t) => centroids[t * 3 + axis]!);
    count[node] = 0;
    first[node] = build(start, mid);
    right[node] = build(mid, end);
    return node;
  };
  if (n > 0) build(0, n);
  else {
    nodes = 1;
    bounds.set([0, 0, 0, -1, -1, -1], 0);
    first[0] = 0;
    count[0] = 0;
  }
  return {
    mesh,
    bounds: bounds.slice(0, nodes * 6),
    first: first.slice(0, nodes),
    count: count.slice(0, nodes),
    right: right.slice(0, nodes),
    triangles: order,
  };
}

function quickselect(
  arr: Uint32Array,
  left: number,
  right: number,
  k: number,
  key: (value: number) => number,
): void {
  while (right > left) {
    const pivot = key(arr[(left + right) >> 1]!);
    let i = left;
    let j = right;
    while (i <= j) {
      while (key(arr[i]!) < pivot) i += 1;
      while (key(arr[j]!) > pivot) j -= 1;
      if (i <= j) {
        const tmp = arr[i]!;
        arr[i] = arr[j]!;
        arr[j] = tmp;
        i += 1;
        j -= 1;
      }
    }
    if (k <= j) right = j;
    else if (k >= i) left = i;
    else return;
  }
}

export interface RayHit {
  t: number;
  triangle: number;
}

/**
 * Nearest intersection of the ray `origin + t·dir` (t in `(tMin, tMax)`)
 * with the mesh, ignoring triangle `skip`. Two-sided (Möller–Trumbore).
 */
export function raycast(
  bvh: Bvh,
  origin: Vec3,
  dir: Vec3,
  tMin: number,
  tMax: number,
  skip = -1,
): RayHit | null {
  const { bounds, first, count, right, triangles, mesh } = bvh;
  const { positions: p, indices } = mesh;
  const inv: Vec3 = [1 / dir[0], 1 / dir[1], 1 / dir[2]];
  let best = tMax;
  let bestTri = -1;
  const stack: number[] = [0];
  while (stack.length > 0) {
    const node = stack.pop()!;
    const o = node * 6;
    // Slab test.
    let t0 = tMin;
    let t1 = best;
    let miss = false;
    for (let axis = 0; axis < 3; axis += 1) {
      let near = (bounds[o + axis]! - origin[axis]!) * inv[axis]!;
      let far = (bounds[o + 3 + axis]! - origin[axis]!) * inv[axis]!;
      if (near > far) {
        const tmp = near;
        near = far;
        far = tmp;
      }
      if (Number.isNaN(near) || Number.isNaN(far)) continue;
      t0 = near > t0 ? near : t0;
      t1 = far < t1 ? far : t1;
      if (t0 > t1) {
        miss = true;
        break;
      }
    }
    if (miss) continue;
    const leafCount = count[node]!;
    if (leafCount > 0) {
      const start = first[node]!;
      for (let i = start; i < start + leafCount; i += 1) {
        const tri = triangles[i]!;
        if (tri === skip) continue;
        const a = indices[tri * 3]! * 3;
        const b = indices[tri * 3 + 1]! * 3;
        const c = indices[tri * 3 + 2]! * 3;
        const e1x = p[b]! - p[a]!;
        const e1y = p[b + 1]! - p[a + 1]!;
        const e1z = p[b + 2]! - p[a + 2]!;
        const e2x = p[c]! - p[a]!;
        const e2y = p[c + 1]! - p[a + 1]!;
        const e2z = p[c + 2]! - p[a + 2]!;
        const px = dir[1] * e2z - dir[2] * e2y;
        const py = dir[2] * e2x - dir[0] * e2z;
        const pz = dir[0] * e2y - dir[1] * e2x;
        const det = e1x * px + e1y * py + e1z * pz;
        if (Math.abs(det) < 1e-18) continue;
        const invDet = 1 / det;
        const sx = origin[0] - p[a]!;
        const sy = origin[1] - p[a + 1]!;
        const sz = origin[2] - p[a + 2]!;
        const u = (sx * px + sy * py + sz * pz) * invDet;
        if (u < -1e-9 || u > 1 + 1e-9) continue;
        const qx = sy * e1z - sz * e1y;
        const qy = sz * e1x - sx * e1z;
        const qz = sx * e1y - sy * e1x;
        const v = (dir[0] * qx + dir[1] * qy + dir[2] * qz) * invDet;
        if (v < -1e-9 || u + v > 1 + 1e-9) continue;
        const t = (e2x * qx + e2y * qy + e2z * qz) * invDet;
        if (t > tMin && t < best) {
          best = t;
          bestTri = tri;
        }
      }
    } else if (count[node] === 0 && node < first.length) {
      const leftChild = first[node]!;
      const rightChild = right[node]!;
      if (leftChild > 0 || rightChild > 0) {
        stack.push(rightChild, leftChild);
      }
    }
  }
  return bestTri >= 0 ? { t: best, triangle: bestTri } : null;
}
