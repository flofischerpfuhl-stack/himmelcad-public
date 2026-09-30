/**
 * Per-mesh data the renderer derives once from a kernel body and keeps as
 * long as the tessellation is unchanged (cached by `BodyMesh` identity,
 * which the worker adapter keeps stable across evaluations for unchanged
 * bodies): per-vertex face index (GPU picking), all edges concatenated with
 * their per-segment edge index, silhouette candidates of curved faces, the
 * per-vertex curvature estimate and section contours. Pure data-in/data-out
 * (no GL), unit tested in `test/viewport/bodyGeometry.test.ts`.
 *
 * Arrays created here never change after creation; they are registered as
 * "stable" so `gl.ts` uploads them once and keeps the GPU buffer until the
 * array is no longer drawn.
 */
import type { Body, BodyMesh } from '../../foundation/geometry-kernel/types.js';
import type { Vec3 } from './math.js';

const stableArrays = new WeakSet<ArrayBufferView>();

/** Marks a typed array as immutable: the renderer may cache its GPU copy by identity. */
export function markStable<T extends ArrayBufferView>(array: T): T {
  stableArrays.add(array);
  return array;
}

export function isStable(array: ArrayBufferView): boolean {
  return stableArrays.has(array);
}

export interface BodyGeometry {
  /** Face index (into `Body.faces`) of every mesh vertex, as float (GPU attribute). */
  faceIndex: Float32Array;
  /** Every edge's segments concatenated (`x,y,z,x,y,z` per segment). */
  edgeSegments: Float32Array;
  /** Edge index (into `Body.edges`) of every segment in {@link edgeSegments}. */
  edgeIndex: Float32Array;
  /** Segment range of each edge in {@link edgeSegments}. */
  edgeRanges: { first: number; count: number }[];
}

const geometryCache = new WeakMap<BodyMesh, BodyGeometry>();

/** The body's derived GPU data (computed once per tessellation). */
export function bodyGeometry(body: Body): BodyGeometry {
  const cached = geometryCache.get(body.mesh);
  if (cached && cached.edgeRanges.length === body.edges.length) return cached;
  const { mesh } = body;
  markStable(mesh.positions);
  markStable(mesh.normals);
  markStable(mesh.indices);
  const vertexCount = mesh.positions.length / 3;
  const faceIndex = new Float32Array(vertexCount);
  const triangles = mesh.indices.length / 3;
  for (let t = 0; t < triangles; t += 1) {
    const face = mesh.triangleFaces[t] ?? 0;
    faceIndex[mesh.indices[t * 3]!] = face;
    faceIndex[mesh.indices[t * 3 + 1]!] = face;
    faceIndex[mesh.indices[t * 3 + 2]!] = face;
  }
  let floats = 0;
  for (const edge of body.edges) floats += edge.segments.length - (edge.segments.length % 6);
  const edgeSegments = new Float32Array(floats);
  const edgeIndex = new Float32Array(floats / 6);
  const edgeRanges: { first: number; count: number }[] = [];
  let at = 0;
  body.edges.forEach((edge, i) => {
    const count = Math.floor(edge.segments.length / 6);
    edgeRanges.push({ first: at, count });
    edgeSegments.set(edge.segments.subarray(0, count * 6), at * 6);
    edgeIndex.fill(i, at, at + count);
    at += count;
  });
  const geometry: BodyGeometry = {
    faceIndex: markStable(faceIndex),
    edgeSegments: markStable(edgeSegments),
    edgeIndex: markStable(edgeIndex),
    edgeRanges,
  };
  geometryCache.set(body.mesh, geometry);
  return geometry;
}

// ---- silhouettes ---------------------------------------------------------------------------

const silhouetteCache = new WeakMap<BodyMesh, Float32Array>();
/** Meshes above this triangle count get no silhouette candidates (large STL scans). */
export const MAX_SILHOUETTE_TRIANGLES = 400_000;

/**
 * Silhouette candidates: every interior mesh edge of a curved face (and of
 * reference meshes, which have no B-rep edges), as `a, b, n1, n2` (12 floats
 * per candidate), `n1`/`n2` the normals of the two triangles sharing the
 * edge. The GPU keeps a candidate where one triangle faces the viewer and
 * the other faces away — the outline of cylinders, fillets and spheres that
 * no B-rep edge describes. Planar faces are skipped (their outline is a
 * B-rep edge).
 */
export function silhouetteCandidates(body: Body): Float32Array {
  const cached = silhouetteCache.get(body.mesh);
  if (cached) return cached;
  const { positions, normals, indices, triangleFaces } = body.mesh;
  if (indices.length / 3 > MAX_SILHOUETTE_TRIANGLES) {
    // Huge scanned meshes: the candidate list would cost more memory than it is worth.
    const none = markStable(new Float32Array(0));
    silhouetteCache.set(body.mesh, none);
    return none;
  }
  const curved = body.faces.map((f) => f.surface !== 'plane');
  const triangles = indices.length / 3;
  const triNormal = new Float32Array(triangles * 3);
  for (let t = 0; t < triangles; t += 1) {
    // Average of the (smooth) vertex normals: robust against winding surprises.
    let x = 0;
    let y = 0;
    let z = 0;
    for (let k = 0; k < 3; k += 1) {
      const v = indices[t * 3 + k]! * 3;
      x += normals[v]!;
      y += normals[v + 1]!;
      z += normals[v + 2]!;
    }
    const len = Math.hypot(x, y, z) || 1;
    triNormal[t * 3] = x / len;
    triNormal[t * 3 + 1] = y / len;
    triNormal[t * 3 + 2] = z / len;
  }
  const firstTriangle = new Map<number, number>();
  const out: number[] = [];
  const vertexCount = positions.length / 3;
  for (let t = 0; t < triangles; t += 1) {
    const face = triangleFaces[t] ?? 0;
    if (!(curved[face] ?? true)) continue;
    for (let k = 0; k < 3; k += 1) {
      const a = indices[t * 3 + k]!;
      const b = indices[t * 3 + ((k + 1) % 3)]!;
      const lo = Math.min(a, b);
      const hi = Math.max(a, b);
      const key = lo * vertexCount + hi;
      const other = firstTriangle.get(key);
      if (other === undefined) {
        firstTriangle.set(key, t);
        continue;
      }
      firstTriangle.delete(key);
      if ((triangleFaces[other] ?? 0) !== face) continue;
      out.push(
        positions[lo * 3]!,
        positions[lo * 3 + 1]!,
        positions[lo * 3 + 2]!,
        positions[hi * 3]!,
        positions[hi * 3 + 1]!,
        positions[hi * 3 + 2]!,
        triNormal[other * 3]!,
        triNormal[other * 3 + 1]!,
        triNormal[other * 3 + 2]!,
        triNormal[t * 3]!,
        triNormal[t * 3 + 1]!,
        triNormal[t * 3 + 2]!,
      );
    }
  }
  const result = markStable(new Float32Array(out));
  silhouetteCache.set(body.mesh, result);
  return result;
}

// ---- curvature ------------------------------------------------------------------------------

const curvatureCache = new WeakMap<BodyMesh, Float32Array>();

/**
 * Per-vertex curvature estimate (1/mm) for the curvature map. For every
 * mesh edge `(i, j)` inside a face the normal curvature along the edge is
 * estimated from the kernel's vertex normals as
 * `k = (n_i − n_j)·(p_i − p_j) / |p_i − p_j|²` (exact for a circle through
 * both points); each vertex keeps the value of largest magnitude — the
 * maximum normal curvature, positive where the surface is convex, negative
 * where it is concave. Planar faces are 0. An approximation: it depends on
 * the tessellation and ignores the kernel's exact surface.
 */
export function vertexCurvature(body: Body): Float32Array {
  const cached = curvatureCache.get(body.mesh);
  if (cached) return cached;
  const { positions, normals, indices, triangleFaces } = body.mesh;
  const planar = body.faces.map((f) => f.surface === 'plane');
  const out = new Float32Array(positions.length / 3);
  const triangles = indices.length / 3;
  const visit = (i: number, j: number) => {
    const dx = positions[i * 3]! - positions[j * 3]!;
    const dy = positions[i * 3 + 1]! - positions[j * 3 + 1]!;
    const dz = positions[i * 3 + 2]! - positions[j * 3 + 2]!;
    const len2 = dx * dx + dy * dy + dz * dz;
    if (len2 < 1e-18) return;
    const k =
      ((normals[i * 3]! - normals[j * 3]!) * dx +
        (normals[i * 3 + 1]! - normals[j * 3 + 1]!) * dy +
        (normals[i * 3 + 2]! - normals[j * 3 + 2]!) * dz) /
      len2;
    if (Math.abs(k) > Math.abs(out[i]!)) out[i] = k;
    if (Math.abs(k) > Math.abs(out[j]!)) out[j] = k;
  };
  for (let t = 0; t < triangles; t += 1) {
    if (planar[triangleFaces[t] ?? 0]) continue;
    const a = indices[t * 3]!;
    const b = indices[t * 3 + 1]!;
    const c = indices[t * 3 + 2]!;
    visit(a, b);
    visit(b, c);
    visit(c, a);
  }
  markStable(out);
  curvatureCache.set(body.mesh, out);
  return out;
}

// ---- section contour ------------------------------------------------------------------------

const contourCache = new WeakMap<BodyMesh, { key: string; segments: Float32Array }>();

/**
 * Where the plane `dot(p, normal) = offset` cuts the body's mesh: one line
 * segment per crossed triangle (`x,y,z,x,y,z`). Drawn as the crisp outline
 * of section caps and in the 2D "section only" view. Cached for the last
 * plane per mesh.
 */
export function sectionContour(body: Body, normal: Vec3, offset: number): Float32Array {
  const key = `${normal[0]},${normal[1]},${normal[2]},${offset}`;
  const cached = contourCache.get(body.mesh);
  if (cached && cached.key === key) return cached.segments;
  const { positions, indices } = body.mesh;
  const vertexCount = positions.length / 3;
  const side = new Float64Array(vertexCount);
  for (let v = 0; v < vertexCount; v += 1) {
    side[v] =
      positions[v * 3]! * normal[0] +
      positions[v * 3 + 1]! * normal[1] +
      positions[v * 3 + 2]! * normal[2] -
      offset;
  }
  const out: number[] = [];
  const point = (i: number, j: number) => {
    const si = side[i]!;
    const sj = side[j]!;
    const t = si / (si - sj);
    out.push(
      positions[i * 3]! + (positions[j * 3]! - positions[i * 3]!) * t,
      positions[i * 3 + 1]! + (positions[j * 3 + 1]! - positions[i * 3 + 1]!) * t,
      positions[i * 3 + 2]! + (positions[j * 3 + 2]! - positions[i * 3 + 2]!) * t,
    );
  };
  for (let t = 0; t < indices.length; t += 3) {
    const tri = [indices[t]!, indices[t + 1]!, indices[t + 2]!];
    const crossings: [number, number][] = [];
    for (let k = 0; k < 3; k += 1) {
      const i = tri[k]!;
      const j = tri[(k + 1) % 3]!;
      // Half-open test (>= 0 vs < 0): a vertex exactly on the plane counts once.
      if (side[i]! >= 0 !== side[j]! >= 0) crossings.push([i, j]);
    }
    if (crossings.length !== 2) continue;
    point(crossings[0]![0], crossings[0]![1]);
    point(crossings[1]![0], crossings[1]![1]);
  }
  const segments = markStable(new Float32Array(out));
  contourCache.set(body.mesh, { key, segments });
  return segments;
}
