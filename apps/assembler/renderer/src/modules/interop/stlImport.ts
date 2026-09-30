/**
 * STL parsing for reference-mesh import (`apps/assembler/README.md`
 * "STL import" — a non-editable reference mesh, never an OCCT/kernel input).
 * Parses both binary and ASCII STL robustly: a binary file is detected by
 * its declared triangle count matching the file's byte length (the only
 * reliable binary/ASCII discriminator — many binary STL writers still start
 * their 80-byte header with the bytes "solid", so header sniffing alone is
 * unsafe). Degenerate (zero-area) triangles are dropped rather than
 * crashing or poisoning the bounding box/normal computation.
 */

export interface ParsedStl {
  /** Flat xyz per vertex, 3 vertices per surviving (non-degenerate) triangle — no shared-vertex indexing, so every triangle keeps its own face normal (flat shading). */
  positions: Float32Array;
  /** Flat xyz per vertex, one (repeated) face normal per triangle vertex. */
  normals: Float32Array;
  /** `0..positions.length/3-1`, i.e. `[0, 1, 2, 3, 4, 5, ...]` — kept for API symmetry with {@link BodyMesh}. */
  indices: Uint32Array;
  min: [number, number, number];
  max: [number, number, number];
  /** Triangles kept. */
  triangleCount: number;
  /** Zero-area or non-finite triangles dropped during parsing. */
  degenerateCount: number;
}

const BINARY_HEADER_SIZE = 80;

function isLikelyBinary(bytes: Uint8Array): boolean {
  if (bytes.length < BINARY_HEADER_SIZE + 4) return false;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const triangleCount = view.getUint32(BINARY_HEADER_SIZE, true);
  const expectedLength = BINARY_HEADER_SIZE + 4 + triangleCount * 50;
  return expectedLength === bytes.length;
}

function computeFaceNormal(
  ax: number,
  ay: number,
  az: number,
  bx: number,
  by: number,
  bz: number,
  cx: number,
  cy: number,
  cz: number,
): [number, number, number, number] {
  const ux = bx - ax;
  const uy = by - ay;
  const uz = bz - az;
  const vx = cx - ax;
  const vy = cy - ay;
  const vz = cz - az;
  const nx = uy * vz - uz * vy;
  const ny = uz * vx - ux * vz;
  const nz = ux * vy - uy * vx;
  const len = Math.hypot(nx, ny, nz);
  return [nx, ny, nz, len];
}

class TriangleAccumulator {
  private posOut: number[] = [];
  private normOut: number[] = [];
  min: [number, number, number] = [Infinity, Infinity, Infinity];
  max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  triangleCount = 0;
  degenerateCount = 0;

  add(
    ax: number,
    ay: number,
    az: number,
    bx: number,
    by: number,
    bz: number,
    cx: number,
    cy: number,
    cz: number,
  ): void {
    const finite =
      Number.isFinite(ax) &&
      Number.isFinite(ay) &&
      Number.isFinite(az) &&
      Number.isFinite(bx) &&
      Number.isFinite(by) &&
      Number.isFinite(bz) &&
      Number.isFinite(cx) &&
      Number.isFinite(cy) &&
      Number.isFinite(cz);
    if (!finite) {
      this.degenerateCount += 1;
      return;
    }
    const [nx, ny, nz, len] = computeFaceNormal(ax, ay, az, bx, by, bz, cx, cy, cz);
    // Zero-area (collinear or duplicate-vertex) triangle: no well-defined
    // normal, and it contributes nothing visually — drop it rather than
    // emitting a NaN normal that would crash normalization downstream.
    if (len < 1e-12) {
      this.degenerateCount += 1;
      return;
    }
    const invLen = 1 / len;
    const n: [number, number, number] = [nx * invLen, ny * invLen, nz * invLen];
    for (const [x, y, z] of [
      [ax, ay, az],
      [bx, by, bz],
      [cx, cy, cz],
    ] as const) {
      this.posOut.push(x, y, z);
      this.normOut.push(n[0], n[1], n[2]);
      this.min[0] = Math.min(this.min[0], x);
      this.min[1] = Math.min(this.min[1], y);
      this.min[2] = Math.min(this.min[2], z);
      this.max[0] = Math.max(this.max[0], x);
      this.max[1] = Math.max(this.max[1], y);
      this.max[2] = Math.max(this.max[2], z);
    }
    this.triangleCount += 1;
  }

  finish(): ParsedStl {
    const positions = new Float32Array(this.posOut);
    const normals = new Float32Array(this.normOut);
    const indices = new Uint32Array(positions.length / 3);
    for (let i = 0; i < indices.length; i += 1) indices[i] = i;
    const empty = this.triangleCount === 0;
    return {
      positions,
      normals,
      indices,
      min: empty ? [0, 0, 0] : this.min,
      max: empty ? [0, 0, 0] : this.max,
      triangleCount: this.triangleCount,
      degenerateCount: this.degenerateCount,
    };
  }
}

function parseBinaryStl(bytes: Uint8Array): ParsedStl {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const declaredCount = view.getUint32(BINARY_HEADER_SIZE, true);
  const acc = new TriangleAccumulator();
  let offset = BINARY_HEADER_SIZE + 4;
  for (let t = 0; t < declaredCount; t += 1) {
    if (offset + 50 > bytes.length) break; // truncated file: stop rather than read out of bounds
    // Skip the stored facet normal (offset..offset+12): recomputed from the
    // vertices so a zero/garbage normal in the file can't propagate.
    const vOff = offset + 12;
    const ax = view.getFloat32(vOff, true);
    const ay = view.getFloat32(vOff + 4, true);
    const az = view.getFloat32(vOff + 8, true);
    const bx = view.getFloat32(vOff + 12, true);
    const by = view.getFloat32(vOff + 16, true);
    const bz = view.getFloat32(vOff + 20, true);
    const cx = view.getFloat32(vOff + 24, true);
    const cy = view.getFloat32(vOff + 28, true);
    const cz = view.getFloat32(vOff + 32, true);
    acc.add(ax, ay, az, bx, by, bz, cx, cy, cz);
    offset += 50;
  }
  return acc.finish();
}

function parseAsciiStl(text: string): ParsedStl {
  const acc = new TriangleAccumulator();
  const vertexRe = /vertex\s+([^\s]+)\s+([^\s]+)\s+([^\s]+)/g;
  let match: RegExpExecArray | null;
  let verts: number[] = [];
  while ((match = vertexRe.exec(text)) !== null) {
    const x = Number(match[1]);
    const y = Number(match[2]);
    const z = Number(match[3]);
    verts.push(x, y, z);
    if (verts.length === 9) {
      acc.add(
        verts[0]!,
        verts[1]!,
        verts[2]!,
        verts[3]!,
        verts[4]!,
        verts[5]!,
        verts[6]!,
        verts[7]!,
        verts[8]!,
      );
      verts = [];
    }
  }
  return acc.finish();
}

/**
 * Parses an STL file's bytes, binary or ASCII, auto-detected. Never throws
 * on malformed/degenerate triangle data (they are dropped, see
 * {@link ParsedStl.degenerateCount}); throws only if the input is too short
 * to be any STL file.
 */
export function parseStl(input: ArrayBuffer | Uint8Array): ParsedStl {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  if (bytes.length < 5) throw new Error('File is too small to be an STL file.');
  if (isLikelyBinary(bytes)) return parseBinaryStl(bytes);
  // Not binary-shaped: decode as text. A binary file that also happens to
  // fail the length check (truncated/corrupt) still gets a best-effort
  // ASCII parse rather than an outright crash; a file with no "vertex"
  // tokens simply yields zero triangles.
  const text = new TextDecoder('utf-8', { fatal: false }).decode(bytes);
  return parseAsciiStl(text);
}

export type StlUnitHint = 'm' | 'in';

/**
 * Heuristic-only unit hint from the imported mesh's bounding box, never
 * applied automatically (`apps/assembler/README.md` deliverable: "NEVER
 * silently rescale"). 3D-printed parts modelled correctly in millimetres
 * are almost always larger than 1 unit across; a bounding box under 1 unit
 * strongly suggests the file was authored in metres, and one in the low
 * tens suggests inches (a part exported in inches at typical print scale
 * lands in that band once misread as millimetres).
 */
export function suggestStlUnitHint(
  min: readonly [number, number, number],
  max: readonly [number, number, number],
): { hint: StlUnitHint; scaleToMm: number } | null {
  const dx = max[0] - min[0];
  const dy = max[1] - min[1];
  const dz = max[2] - min[2];
  const maxDim = Math.max(dx, dy, dz);
  if (!Number.isFinite(maxDim) || maxDim <= 0) return null;
  if (maxDim < 1) return { hint: 'm', scaleToMm: 1000 };
  if (maxDim < 20) return { hint: 'in', scaleToMm: 25.4 };
  return null;
}
