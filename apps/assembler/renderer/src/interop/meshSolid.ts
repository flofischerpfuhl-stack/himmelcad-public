/**
 * Mesh → solid, the pure part (no OCCT): welding a triangle soup into an
 * indexed mesh, checking that it is a closed, manifold, consistently
 * oriented surface, fixing flipped triangles and an inside-out winding,
 * grouping coplanar neighbouring triangles into planar regions with their
 * boundary loops, and the compact payload a `meshSolid` feature embeds.
 * The OCCT side (`kernel/meshSolid.ts`) turns regions into planar faces.
 *
 * Honest limits (enforced here, before any kernel work): at most
 * {@link MESH_SOLID_LIMITS}.triangles input triangles and
 * {@link MESH_SOLID_LIMITS}.faces planar faces after merging — every face
 * costs OCCT time (~0.5 ms to build plus its validity check in this wasm
 * build) and a body with tens of thousands of faces is too slow to fillet
 * or boolean anyway. Open, non-manifold or multi-part meshes are refused
 * with the reason, never "repaired" into a different shape.
 */

export const MESH_SOLID_LIMITS = {
  /** Input triangles (after welding and dropping degenerate ones). */
  triangles: 60_000,
  /** Planar faces after coplanar merging. */
  faces: 6_000,
} as const;

export class MeshSolidError extends Error {}

export interface WeldedMesh {
  /** xyz per vertex. */
  positions: Float32Array;
  /** Three vertex indices per triangle, counter-clockwise seen from outside. */
  indices: Uint32Array;
}

export interface MeshCheck {
  vertices: number;
  triangles: number;
  /** Triangles dropped because welding made them degenerate. */
  degenerate: number;
  /** Edges used by one triangle only (holes). */
  boundaryEdges: number;
  /** Edges shared by more than two triangles. */
  nonManifoldEdges: number;
  /** Connected parts. */
  components: number;
  /** Triangles whose winding was flipped to agree with their neighbours. */
  flipped: number;
  /** The whole mesh was inside out (negative volume) and was reversed. */
  inverted: boolean;
  /** Enclosed volume, mm³ (after orientation fixes). */
  volume: number;
  /** Planar faces after merging coplanar neighbours. */
  faces: number;
}

/**
 * Welds coincident vertices (within `tolerance`, default 1e-6 of the
 * bounding-box diagonal) of a triangle list and drops triangles that become
 * degenerate. `positions` are xyz triples; `indices` (optional) index them,
 * else every three consecutive vertices are a triangle.
 */
export function weldMesh(
  positions: Float32Array | Float64Array,
  indices?: Uint32Array | null,
  tolerance?: number,
): WeldedMesh & { degenerate: number } {
  const count = indices ? indices.length : positions.length / 3;
  let min = [Infinity, Infinity, Infinity];
  let max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < positions.length; i += 3) {
    for (let k = 0; k < 3; k += 1) {
      const v = positions[i + k]!;
      if (v < min[k]!) min[k] = v;
      if (v > max[k]!) max[k] = v;
    }
  }
  if (count === 0) {
    min = [0, 0, 0];
    max = [0, 0, 0];
  }
  const diagonal = Math.hypot(max[0]! - min[0]!, max[1]! - min[1]!, max[2]! - min[2]!);
  const q = tolerance ?? Math.max(1e-9, diagonal * 1e-6);
  const map = new Map<string, number>();
  const out: number[] = [];
  const remap = (source: number): number => {
    const x = positions[source * 3]!;
    const y = positions[source * 3 + 1]!;
    const z = positions[source * 3 + 2]!;
    const key = `${Math.round(x / q)},${Math.round(y / q)},${Math.round(z / q)}`;
    let id = map.get(key);
    if (id === undefined) {
      id = out.length / 3;
      map.set(key, id);
      out.push(x, y, z);
    }
    return id;
  };
  const tris: number[] = [];
  let degenerate = 0;
  for (let t = 0; t + 2 < count; t += 3) {
    const a = remap(indices ? indices[t]! : t);
    const b = remap(indices ? indices[t + 1]! : t + 1);
    const c = remap(indices ? indices[t + 2]! : t + 2);
    if (a === b || b === c || a === c) {
      degenerate += 1;
      continue;
    }
    tris.push(a, b, c);
  }
  return { positions: new Float32Array(out), indices: new Uint32Array(tris), degenerate };
}

function edgeKey(a: number, b: number, n: number): number {
  return a < b ? a * n + b : b * n + a;
}

function triangleNormal(
  p: Float32Array,
  a: number,
  b: number,
  c: number,
): [number, number, number] {
  const ax = p[a * 3]!;
  const ay = p[a * 3 + 1]!;
  const az = p[a * 3 + 2]!;
  const ux = p[b * 3]! - ax;
  const uy = p[b * 3 + 1]! - ay;
  const uz = p[b * 3 + 2]! - az;
  const vx = p[c * 3]! - ax;
  const vy = p[c * 3 + 1]! - ay;
  const vz = p[c * 3 + 2]! - az;
  return [uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx];
}

/** Signed volume (divergence theorem), mm³. */
export function signedVolume(mesh: WeldedMesh): number {
  const p = mesh.positions;
  const t = mesh.indices;
  let sum = 0;
  for (let i = 0; i < t.length; i += 3) {
    const a = t[i]! * 3;
    const b = t[i + 1]! * 3;
    const c = t[i + 2]! * 3;
    sum +=
      p[a]! * (p[b + 1]! * p[c + 2]! - p[b + 2]! * p[c + 1]!) -
      p[a + 1]! * (p[b]! * p[c + 2]! - p[b + 2]! * p[c]!) +
      p[a + 2]! * (p[b]! * p[c + 1]! - p[b + 1]! * p[c]!);
  }
  return sum / 6;
}

/**
 * Checks and orients a welded mesh for conversion. Returns the (possibly
 * re-oriented) mesh and the check, or throws {@link MeshSolidError} with the
 * reason it cannot become a solid.
 */
export function prepareSolidMesh(
  input: WeldedMesh & { degenerate?: number },
  limits: { triangles: number; faces: number } = MESH_SOLID_LIMITS,
): { mesh: WeldedMesh; check: MeshCheck } {
  const n = input.positions.length / 3;
  const tris = new Uint32Array(input.indices);
  const triCount = tris.length / 3;
  if (triCount < 4)
    throw new MeshSolidError('The mesh has fewer than 4 triangles; it cannot enclose a volume.');
  if (triCount > limits.triangles) {
    throw new MeshSolidError(
      `The mesh has ${triCount.toLocaleString('en-US')} triangles; mesh to solid supports up to ${limits.triangles.toLocaleString('en-US')} (every triangle becomes B-rep topology). Simplify it in a mesh tool first.`,
    );
  }
  // Edge → triangles using it.
  const edgeTris = new Map<number, number[]>();
  for (let t = 0; t < triCount; t += 1) {
    for (let k = 0; k < 3; k += 1) {
      const key = edgeKey(tris[t * 3 + k]!, tris[t * 3 + ((k + 1) % 3)]!, n);
      const list = edgeTris.get(key);
      if (list) list.push(t);
      else edgeTris.set(key, [t]);
    }
  }
  let boundary = 0;
  let nonManifold = 0;
  for (const list of edgeTris.values()) {
    if (list.length === 1) boundary += 1;
    else if (list.length > 2) nonManifold += 1;
  }
  if (boundary > 0 || nonManifold > 0) {
    const parts: string[] = [];
    if (boundary > 0) parts.push(`${boundary} open edge${boundary === 1 ? '' : 's'} (holes)`);
    if (nonManifold > 0) {
      parts.push(
        `${nonManifold} edge${nonManifold === 1 ? '' : 's'} shared by more than two triangles`,
      );
    }
    throw new MeshSolidError(
      `The mesh is not a closed, manifold surface: ${parts.join(' and ')}. Repair it in a mesh tool first.`,
    );
  }
  // Orientation: breadth-first over shared edges, flipping neighbours to agree.
  const state = new Int8Array(triCount); // 0 unvisited, 1 kept, 2 flipped
  let components = 0;
  let flipped = 0;
  const directedSame = (t: number, a: number, b: number): boolean => {
    for (let k = 0; k < 3; k += 1) {
      if (tris[t * 3 + k] === a && tris[t * 3 + ((k + 1) % 3)] === b) return true;
    }
    return false;
  };
  const flip = (t: number) => {
    const tmp = tris[t * 3 + 1]!;
    tris[t * 3 + 1] = tris[t * 3 + 2]!;
    tris[t * 3 + 2] = tmp;
  };
  for (let seed = 0; seed < triCount; seed += 1) {
    if (state[seed] !== 0) continue;
    components += 1;
    state[seed] = 1;
    const queue = [seed];
    while (queue.length > 0) {
      const t = queue.pop()!;
      for (let k = 0; k < 3; k += 1) {
        const a = tris[t * 3 + k]!;
        const b = tris[t * 3 + ((k + 1) % 3)]!;
        for (const other of edgeTris.get(edgeKey(a, b, n))!) {
          if (other === t) continue;
          // A consistent neighbour walks the shared edge b → a.
          const consistent = !directedSame(other, a, b);
          if (state[other] === 0) {
            if (!consistent) {
              flip(other);
              flipped += 1;
              state[other] = 2;
            } else state[other] = 1;
            queue.push(other);
          } else if (!consistent) {
            throw new MeshSolidError(
              'The mesh surface is not orientable (like a Möbius strip); it cannot bound a solid.',
            );
          }
        }
      }
    }
  }
  if (components > 1) {
    throw new MeshSolidError(
      `The mesh has ${components} separate closed parts; mesh to solid converts one closed part at a time.`,
    );
  }
  let mesh: WeldedMesh = { positions: input.positions, indices: tris };
  let volume = signedVolume(mesh);
  let inverted = false;
  if (volume < 0) {
    for (let t = 0; t < triCount; t += 1) flip(t);
    inverted = true;
    volume = -volume;
    mesh = { positions: input.positions, indices: tris };
  }
  if (!(volume > 0)) throw new MeshSolidError('The mesh encloses no volume.');
  const faces = planarRegions(mesh).length;
  if (faces > limits.faces) {
    throw new MeshSolidError(
      `The mesh would become ${faces.toLocaleString('en-US')} faces (curved surfaces stay faceted, one face per triangle); mesh to solid supports up to ${limits.faces.toLocaleString('en-US')}. Simplify it in a mesh tool first.`,
    );
  }
  return {
    mesh,
    check: {
      vertices: n,
      triangles: triCount,
      degenerate: input.degenerate ?? 0,
      boundaryEdges: 0,
      nonManifoldEdges: 0,
      components,
      flipped,
      inverted,
      volume,
      faces,
    },
  };
}

export interface PlanarRegion {
  /** Triangle indices in the region. */
  triangles: number[];
  /** Unit normal (outward). */
  normal: [number, number, number];
  /**
   * Boundary loops as vertex index sequences in triangle winding order
   * (outer loop counter-clockwise about `normal`, holes clockwise);
   * `null` when the boundary could not be chained unambiguously (the
   * kernel then uses one face per triangle).
   */
  loops: number[][] | null;
}

/**
 * Groups edge-connected coplanar triangles (normals within ~1e-4 rad,
 * vertices within 1e-6 of the diagonal from the seed plane) into planar
 * regions with their boundary loops.
 */
export function planarRegions(mesh: WeldedMesh): PlanarRegion[] {
  const p = mesh.positions;
  const t = mesh.indices;
  const n = p.length / 3;
  const triCount = t.length / 3;
  const normals = new Float64Array(triCount * 3);
  let min = [Infinity, Infinity, Infinity];
  let max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < p.length; i += 3) {
    for (let k = 0; k < 3; k += 1) {
      min[k] = Math.min(min[k]!, p[i + k]!);
      max[k] = Math.max(max[k]!, p[i + k]!);
    }
  }
  if (p.length === 0) {
    min = [0, 0, 0];
    max = [0, 0, 0];
  }
  const tol = Math.max(
    1e-9,
    Math.hypot(max[0]! - min[0]!, max[1]! - min[1]!, max[2]! - min[2]!) * 1e-6,
  );
  for (let i = 0; i < triCount; i += 1) {
    const [x, y, z] = triangleNormal(p, t[i * 3]!, t[i * 3 + 1]!, t[i * 3 + 2]!);
    const len = Math.hypot(x, y, z) || 1;
    normals[i * 3] = x / len;
    normals[i * 3 + 1] = y / len;
    normals[i * 3 + 2] = z / len;
  }
  const edgeTris = new Map<number, number[]>();
  for (let i = 0; i < triCount; i += 1) {
    for (let k = 0; k < 3; k += 1) {
      const key = edgeKey(t[i * 3 + k]!, t[i * 3 + ((k + 1) % 3)]!, n);
      const list = edgeTris.get(key);
      if (list) list.push(i);
      else edgeTris.set(key, [i]);
    }
  }
  const region = new Int32Array(triCount).fill(-1);
  const regions: PlanarRegion[] = [];
  for (let seed = 0; seed < triCount; seed += 1) {
    if (region[seed] !== -1) continue;
    const id = regions.length;
    const nx = normals[seed * 3]!;
    const ny = normals[seed * 3 + 1]!;
    const nz = normals[seed * 3 + 2]!;
    const a0 = t[seed * 3]!;
    const d = nx * p[a0 * 3]! + ny * p[a0 * 3 + 1]! + nz * p[a0 * 3 + 2]!;
    const members = [seed];
    region[seed] = id;
    const queue = [seed];
    while (queue.length > 0) {
      const tri = queue.pop()!;
      for (let k = 0; k < 3; k += 1) {
        const key = edgeKey(t[tri * 3 + k]!, t[tri * 3 + ((k + 1) % 3)]!, n);
        for (const other of edgeTris.get(key) ?? []) {
          if (region[other] !== -1) continue;
          const dot =
            normals[other * 3]! * nx + normals[other * 3 + 1]! * ny + normals[other * 3 + 2]! * nz;
          if (dot < 1 - 5e-9) continue;
          let onPlane = true;
          for (let v = 0; v < 3; v += 1) {
            const vi = t[other * 3 + v]!;
            const dist = nx * p[vi * 3]! + ny * p[vi * 3 + 1]! + nz * p[vi * 3 + 2]! - d;
            if (Math.abs(dist) > tol) {
              onPlane = false;
              break;
            }
          }
          if (!onPlane) continue;
          region[other] = id;
          members.push(other);
          queue.push(other);
        }
      }
    }
    regions.push({ triangles: members, normal: [nx, ny, nz], loops: null });
  }
  for (const r of regions) r.loops = regionLoops(t, r.triangles, n);
  return regions;
}

/** Boundary loops of a set of triangles (directed as in the triangles), or `null` if ambiguous. */
function regionLoops(t: Uint32Array, members: number[], n: number): number[][] | null {
  if (members.length === 1) {
    const m = members[0]!;
    return [[t[m * 3]!, t[m * 3 + 1]!, t[m * 3 + 2]!]];
  }
  const directed = new Set<number>();
  for (const m of members) {
    for (let k = 0; k < 3; k += 1) directed.add(t[m * 3 + k]! * n + t[m * 3 + ((k + 1) % 3)]!);
  }
  // Boundary: a directed edge whose reverse is not in the region.
  const next = new Map<number, number>();
  for (const m of members) {
    for (let k = 0; k < 3; k += 1) {
      const a = t[m * 3 + k]!;
      const b = t[m * 3 + ((k + 1) % 3)]!;
      if (directed.has(b * n + a)) continue;
      if (next.has(a)) return null; // two boundary edges leave `a`: the region pinches there
      next.set(a, b);
    }
  }
  const loops: number[][] = [];
  const done = new Set<number>();
  for (const start of next.keys()) {
    if (done.has(start)) continue;
    const loop: number[] = [];
    let v = start;
    for (let guard = 0; guard <= next.size; guard += 1) {
      if (done.has(v)) break;
      done.add(v);
      loop.push(v);
      const w = next.get(v);
      if (w === undefined) return null;
      v = w;
    }
    if (v !== start || loop.length < 3) return null;
    loops.push(loop);
  }
  return loops.length > 0 ? loops : null;
}

// ---- payload ----------------------------------------------------------------------------

const MAGIC = 0x3153_4d48; // "HMS1" little-endian

/** Compact binary payload of a welded, oriented mesh (little-endian). */
export function encodeMeshSolidPayload(mesh: WeldedMesh): Uint8Array {
  const vertexBytes = mesh.positions.length * 4;
  const out = new Uint8Array(12 + vertexBytes + mesh.indices.length * 4);
  const view = new DataView(out.buffer);
  view.setUint32(0, MAGIC, true);
  view.setUint32(4, mesh.positions.length / 3, true);
  view.setUint32(8, mesh.indices.length / 3, true);
  let o = 12;
  for (const v of mesh.positions) {
    view.setFloat32(o, v, true);
    o += 4;
  }
  for (const i of mesh.indices) {
    view.setUint32(o, i, true);
    o += 4;
  }
  return out;
}

export function decodeMeshSolidPayload(bytes: Uint8Array): WeldedMesh {
  if (bytes.length < 12) throw new MeshSolidError('Mesh payload is truncated');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(0, true) !== MAGIC) throw new MeshSolidError('Unknown mesh payload');
  const vertices = view.getUint32(4, true);
  const triangles = view.getUint32(8, true);
  if (bytes.length !== 12 + vertices * 12 + triangles * 12) {
    throw new MeshSolidError('Mesh payload has the wrong size');
  }
  const positions = new Float32Array(vertices * 3);
  let o = 12;
  for (let i = 0; i < positions.length; i += 1, o += 4) positions[i] = view.getFloat32(o, true);
  const indices = new Uint32Array(triangles * 3);
  for (let i = 0; i < indices.length; i += 1, o += 4) {
    const v = view.getUint32(o, true);
    if (v >= vertices) throw new MeshSolidError('Mesh payload has an invalid vertex index');
    indices[i] = v;
  }
  return { positions, indices };
}
