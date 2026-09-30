/**
 * Binary STL export, built directly from the already-tessellated
 * {@link BodyMesh} of an {@link EvaluationResult} — no extra kernel round
 * trip: the mesh millimetre coordinates are exactly what the viewport
 * already renders. STL has no units field; millimetres are the app's only
 * unit (`docs/PROJECT-FORMAT.md` conventions, `AGENTS.md`), so this is
 * always a millimetre file.
 */
import type { Body, BodyMesh } from './types.js';

const HEADER_SIZE = 80;

/** Binary STL (little-endian) of one mesh: 80-byte header, u32 triangle count, then 50 bytes/triangle. */
export function stlBufferForMesh(mesh: BodyMesh, header = 'HimmelCAD Assembler'): ArrayBuffer {
  const triangleCount = mesh.indices.length / 3;
  const byteLength = HEADER_SIZE + 4 + triangleCount * 50;
  const buffer = new ArrayBuffer(byteLength);
  const view = new DataView(buffer);
  const headerBytes = new TextEncoder().encode(header.slice(0, HEADER_SIZE));
  new Uint8Array(buffer, 0, headerBytes.length).set(headerBytes);
  view.setUint32(HEADER_SIZE, triangleCount, true);
  let offset = HEADER_SIZE + 4;
  for (let t = 0; t < triangleCount; t += 1) {
    const i0 = mesh.indices[t * 3]!;
    const i1 = mesh.indices[t * 3 + 1]!;
    const i2 = mesh.indices[t * 3 + 2]!;
    // Facet normal: average of the three vertex normals (the mesh has no
    // single face normal record; this is what most STL consumers expect and
    // slicers recompute it from winding order regardless).
    let nx = 0;
    let ny = 0;
    let nz = 0;
    for (const i of [i0, i1, i2]) {
      nx += mesh.normals[i * 3]!;
      ny += mesh.normals[i * 3 + 1]!;
      nz += mesh.normals[i * 3 + 2]!;
    }
    const len = Math.hypot(nx, ny, nz) || 1;
    view.setFloat32(offset, nx / len, true);
    view.setFloat32(offset + 4, ny / len, true);
    view.setFloat32(offset + 8, nz / len, true);
    offset += 12;
    for (const i of [i0, i1, i2]) {
      view.setFloat32(offset, mesh.positions[i * 3]!, true);
      view.setFloat32(offset + 4, mesh.positions[i * 3 + 1]!, true);
      view.setFloat32(offset + 8, mesh.positions[i * 3 + 2]!, true);
      offset += 12;
    }
    view.setUint16(offset, 0, true); // attribute byte count
    offset += 2;
  }
  return buffer;
}

/** Concatenates several meshes' triangles into one binary STL (an "all bodies" export). */
export function stlBufferForMeshes(meshes: readonly BodyMesh[], header?: string): ArrayBuffer {
  const triangleCount = meshes.reduce((sum, m) => sum + m.indices.length / 3, 0);
  const merged: BodyMesh = {
    positions: new Float32Array(0),
    normals: new Float32Array(0),
    indices: new Uint32Array(triangleCount * 3),
    triangleFaces: new Uint32Array(0),
  };
  // Build a synthetic mesh whose indices directly reference a concatenated
  // position/normal buffer, so stlBufferForMesh's single-pass writer works unchanged.
  const totalVerts = meshes.reduce((sum, m) => sum + m.positions.length / 3, 0);
  const positions = new Float32Array(totalVerts * 3);
  const normals = new Float32Array(totalVerts * 3);
  let vertOffset = 0;
  let indexOffset = 0;
  for (const m of meshes) {
    positions.set(m.positions, vertOffset * 3);
    normals.set(m.normals, vertOffset * 3);
    for (let i = 0; i < m.indices.length; i += 1) {
      merged.indices[indexOffset + i] = m.indices[i]! + vertOffset;
    }
    indexOffset += m.indices.length;
    vertOffset += m.positions.length / 3;
  }
  return stlBufferForMesh(
    { positions, normals, indices: merged.indices, triangleFaces: merged.triangleFaces },
    header,
  );
}

/** STL `solid` name: printable ASCII without whitespace runs (some readers split on spaces). */
function solidName(name: string): string {
  const cleaned = name.replace(/[^\x21-\x7e]+/g, '_').replace(/^_+|_+$/g, '');
  return cleaned || 'body';
}

/** Shortest decimal that survives a float32 round trip, in `e` notation as STL readers expect. */
function stlNumber(value: number): string {
  const v = Math.fround(value);
  return (Object.is(v, -0) ? 0 : v).toExponential(7);
}

/**
 * ASCII STL of one or more meshes: one `solid … endsolid` block per mesh
 * (named), facet normals from the triangle winding. Millimetres, like the
 * binary writer.
 */
export function stlAsciiForMeshes(meshes: readonly { name: string; mesh: BodyMesh }[]): Uint8Array {
  const lines: string[] = [];
  for (const { name, mesh } of meshes) {
    const solid = solidName(name);
    lines.push(`solid ${solid}`);
    const p = mesh.positions;
    for (let t = 0; t < mesh.indices.length; t += 3) {
      const a = mesh.indices[t]! * 3;
      const b = mesh.indices[t + 1]! * 3;
      const c = mesh.indices[t + 2]! * 3;
      const ux = p[b]! - p[a]!;
      const uy = p[b + 1]! - p[a + 1]!;
      const uz = p[b + 2]! - p[a + 2]!;
      const vx = p[c]! - p[a]!;
      const vy = p[c + 1]! - p[a + 1]!;
      const vz = p[c + 2]! - p[a + 2]!;
      let nx = uy * vz - uz * vy;
      let ny = uz * vx - ux * vz;
      let nz = ux * vy - uy * vx;
      const len = Math.hypot(nx, ny, nz) || 1;
      nx /= len;
      ny /= len;
      nz /= len;
      lines.push(`  facet normal ${stlNumber(nx)} ${stlNumber(ny)} ${stlNumber(nz)}`);
      lines.push('    outer loop');
      for (const i of [a, b, c]) {
        lines.push(
          `      vertex ${stlNumber(p[i]!)} ${stlNumber(p[i + 1]!)} ${stlNumber(p[i + 2]!)}`,
        );
      }
      lines.push('    endloop');
      lines.push('  endfacet');
    }
    lines.push(`endsolid ${solid}`);
  }
  return new TextEncoder().encode(`${lines.join('\n')}\n`);
}

export type StlFormat = 'binary' | 'ascii';

/** STL bytes of the given named meshes (merged into one file). */
export function stlBytes(
  meshes: readonly { name: string; mesh: BodyMesh }[],
  format: StlFormat,
): Uint8Array {
  if (format === 'ascii') return stlAsciiForMeshes(meshes);
  const header = meshes.length === 1 ? meshes[0]!.name : 'HimmelCAD Assembler';
  return new Uint8Array(
    meshes.length === 1
      ? stlBufferForMesh(meshes[0]!.mesh, header)
      : stlBufferForMeshes(
          meshes.map((m) => m.mesh),
          header,
        ),
  );
}

/** STL export for one body, by id. `null` if the body is not in the evaluation. */
export function exportBodyStl(bodies: readonly Body[], bodyId: string): ArrayBuffer | null {
  const body = bodies.find((b) => b.id === bodyId);
  if (!body) return null;
  return stlBufferForMesh(body.mesh, body.name);
}

/** STL export of every given body as one merged triangle soup. */
export function exportAllBodiesStl(bodies: readonly Body[]): ArrayBuffer {
  return stlBufferForMeshes(bodies.map((b) => b.mesh));
}
