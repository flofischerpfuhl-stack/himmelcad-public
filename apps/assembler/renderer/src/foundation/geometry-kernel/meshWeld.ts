/**
 * Vertex welding of triangle meshes: the kernel's render meshes duplicate
 * vertices per B-rep face; welding turns them into one connected surface.
 * Pure TypeScript (no OCCT), shared by the mesh writers (`threeMf.ts`) and
 * the printability analysis (`modules/print/meshTools.ts`).
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
