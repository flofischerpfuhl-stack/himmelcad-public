/**
 * Common result of the mesh importers (STL, 3MF, OBJ): named triangle
 * soups in millimetres with an optional colour and an Items folder, ready
 * to become reference meshes (`model/referenceMesh.ts`) — the same path the
 * STL import already uses (a reference mesh is shown, measured and
 * exported, never a kernel input; "Mesh to Solid" converts one on request).
 */
import type { ParsedStl } from '../kernel/stlImport.js';

export interface ImportedMeshObject {
  name: string;
  /** `#RRGGBB` from the file (3MF material/colour, OBJ vertex colours), else `null`. */
  color: string | null;
  /** Items folder (file name, OBJ object for its groups), empty for none. */
  folder: string[];
  mesh: ParsedStl;
}

export interface MeshImportResult {
  format: 'stl' | '3mf' | 'obj';
  objects: ImportedMeshObject[];
  /** Unit declared by the file (`3mf`), `null` for unitless formats (STL, OBJ). */
  declaredUnit: string | null;
  /** Scale applied to reach millimetres because the file declared its unit (1 = none). */
  unitScale: number;
  warnings: string[];
}

export class MeshImportError extends Error {}

/** Thrown (by a progress callback) to abort a parse. */
export class ImportCancelledError extends Error {
  constructor() {
    super('Import cancelled');
  }
}

/**
 * Accumulates triangles into a {@link ParsedStl}: per-triangle normals
 * (flat shading, like STL import), bounding box, degenerate triangles
 * (zero area, non-finite) dropped and counted.
 */
export class MeshBuilder {
  private positions: number[] = [];
  private normals: number[] = [];
  private min: [number, number, number] = [Infinity, Infinity, Infinity];
  private max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  triangles = 0;
  degenerate = 0;

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
    if (!Number.isFinite(ax + ay + az + bx + by + bz + cx + cy + cz)) {
      this.degenerate += 1;
      return;
    }
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
    if (len < 1e-12) {
      this.degenerate += 1;
      return;
    }
    const inv = 1 / len;
    this.positions.push(ax, ay, az, bx, by, bz, cx, cy, cz);
    for (let k = 0; k < 3; k += 1) this.normals.push(nx * inv, ny * inv, nz * inv);
    const xs = [ax, bx, cx];
    const ys = [ay, by, cy];
    const zs = [az, bz, cz];
    for (let k = 0; k < 3; k += 1) {
      if (xs[k]! < this.min[0]) this.min[0] = xs[k]!;
      if (ys[k]! < this.min[1]) this.min[1] = ys[k]!;
      if (zs[k]! < this.min[2]) this.min[2] = zs[k]!;
      if (xs[k]! > this.max[0]) this.max[0] = xs[k]!;
      if (ys[k]! > this.max[1]) this.max[1] = ys[k]!;
      if (zs[k]! > this.max[2]) this.max[2] = zs[k]!;
    }
    this.triangles += 1;
  }

  finish(): ParsedStl {
    const positions = new Float32Array(this.positions);
    const indices = new Uint32Array(positions.length / 3);
    for (let i = 0; i < indices.length; i += 1) indices[i] = i;
    const empty = this.triangles === 0;
    return {
      positions,
      normals: new Float32Array(this.normals),
      indices,
      min: empty ? [0, 0, 0] : this.min,
      max: empty ? [0, 0, 0] : this.max,
      triangleCount: this.triangles,
      degenerateCount: this.degenerate,
    };
  }
}

/** `#RRGGBB` (alpha dropped) from `#RGB`, `#RRGGBB` or `#RRGGBBAA`, else `null`. */
export function normalizeHexColor(value: string | undefined): string | null {
  if (!value) return null;
  const v = value.trim();
  const long = /^#([0-9a-fA-F]{6})([0-9a-fA-F]{2})?$/.exec(v);
  if (long) return `#${long[1]!.toUpperCase()}`;
  const short = /^#([0-9a-fA-F])([0-9a-fA-F])([0-9a-fA-F])$/.exec(v);
  if (short)
    return `#${short[1]}${short[1]}${short[2]}${short[2]}${short[3]}${short[3]}`.toUpperCase();
  return null;
}

export function hexFromRgb01(r: number, g: number, b: number): string {
  const to = (c: number) =>
    Math.round(Math.max(0, Math.min(1, c)) * 255)
      .toString(16)
      .padStart(2, '0')
      .toUpperCase();
  return `#${to(r)}${to(g)}${to(b)}`;
}
