/**
 * CPU-side vertex-buffer builders for the viewport. Turns the kernel's
 * indexed body meshes (`kernel/types.ts`) into the flat, non-indexed
 * `Float32Array`s `gl.ts` draws, with per-face sub-ranges for picking and
 * highlighting. Kept separate from `gl.ts` so geometry shape stays easy to
 * reason about without a GL context.
 */
import type { Body, BodyMesh } from '../kernel/types.js';

/** A body's triangles, expanded to 3 vertices per triangle, faces contiguous. */
export interface ExpandedBody {
  positions: Float32Array;
  normals: Float32Array;
  /** Per face (same order as `Body.faces`): a view into `positions`. */
  facePositions: Float32Array[];
}

const expandedCache = new WeakMap<BodyMesh, ExpandedBody>();

/**
 * Expands a body mesh once per evaluation result (cached by mesh identity).
 * Normals stay per face: planar faces render crisp, curved faces smooth.
 */
export function expandBody(body: Body): ExpandedBody {
  const cached = expandedCache.get(body.mesh);
  if (cached) return cached;
  const { positions: src, normals: srcNormals, indices } = body.mesh;
  const positions = new Float32Array(indices.length * 3);
  const normals = new Float32Array(indices.length * 3);
  for (let i = 0; i < indices.length; i += 1) {
    const v = indices[i]! * 3;
    positions[i * 3] = src[v]!;
    positions[i * 3 + 1] = src[v + 1]!;
    positions[i * 3 + 2] = src[v + 2]!;
    normals[i * 3] = srcNormals[v]!;
    normals[i * 3 + 1] = srcNormals[v + 1]!;
    normals[i * 3 + 2] = srcNormals[v + 2]!;
  }
  const facePositions = body.faces.map((face) =>
    positions.subarray(face.triangleStart * 9, (face.triangleStart + face.triangleCount) * 9),
  );
  const expanded = { positions, normals, facePositions };
  expandedCache.set(body.mesh, expanded);
  return expanded;
}

/** Copy of a flat xyz array translated by `delta` (move-tool preview). */
export function translatePositions(
  positions: Float32Array,
  delta: readonly [number, number, number],
): Float32Array {
  const out = new Float32Array(positions.length);
  for (let i = 0; i < positions.length; i += 3) {
    out[i] = positions[i]! + delta[0];
    out[i + 1] = positions[i + 1]! + delta[1];
    out[i + 2] = positions[i + 2]! + delta[2];
  }
  return out;
}

export interface GridLines {
  /** Minor grid line segments, 2 endpoints * 3 floats per segment. */
  minor: Float32Array;
  /** Major grid line segments (every `majorEvery`th line). */
  major: Float32Array;
}

/**
 * Builds an XY-plane grid centered on the origin, covering `[-extent, extent]`
 * on both axes. Distance-based fading is done in the vertex shader (it needs
 * the live camera position), not here.
 */
export function buildGridLines(step: number, majorEvery: number, extent: number): GridLines {
  const minorSegs: number[] = [];
  const majorSegs: number[] = [];
  const count = Math.max(1, Math.ceil(extent / step));
  for (let i = -count; i <= count; i += 1) {
    const coord = i * step;
    if (Math.abs(coord) > extent) continue;
    const isMajor = i % majorEvery === 0;
    const target = isMajor ? majorSegs : minorSegs;
    target.push(coord, -extent, 0, coord, extent, 0);
    target.push(-extent, coord, 0, extent, coord, 0);
  }
  return { minor: new Float32Array(minorSegs), major: new Float32Array(majorSegs) };
}

export interface Ribbon {
  positions: Float32Array;
  triangleCount: number;
}

/**
 * Builds a camera-facing ribbon quad (two triangles) along `a`→`b`, roughly
 * `widthWorld` wide, used to give thin edges/wireframe lines a wider hit
 * target in the picking buffer than a 1px `LINES` draw would give on
 * platforms that clamp line width to 1 (most ANGLE/Windows GL drivers).
 */
export function buildEdgeRibbon(
  a: readonly [number, number, number],
  b: readonly [number, number, number],
  cameraPosition: readonly [number, number, number],
  widthWorld: number,
): Ribbon {
  const positions = new Float32Array(18);
  writeRibbon(positions, 0, a[0], a[1], a[2], b[0], b[1], b[2], cameraPosition, widthWorld);
  return { positions, triangleCount: 2 };
}

/**
 * Ribbons for every segment of a line-segment list (`x,y,z,x,y,z` pairs),
 * concatenated into one triangle list (18 floats per segment).
 */
export function buildPolylineRibbon(
  segments: Float32Array,
  cameraPosition: readonly [number, number, number],
  widthWorld: number,
): Float32Array {
  const count = Math.floor(segments.length / 6);
  const out = new Float32Array(count * 18);
  for (let s = 0; s < count; s += 1) {
    const o = s * 6;
    writeRibbon(
      out,
      s * 18,
      segments[o]!,
      segments[o + 1]!,
      segments[o + 2]!,
      segments[o + 3]!,
      segments[o + 4]!,
      segments[o + 5]!,
      cameraPosition,
      widthWorld,
    );
  }
  return out;
}

function writeRibbon(
  out: Float32Array,
  offset: number,
  ax: number,
  ay: number,
  az: number,
  bx: number,
  by: number,
  bz: number,
  eye: readonly [number, number, number],
  widthWorld: number,
): void {
  const dx = bx - ax;
  const dy = by - ay;
  const dz = bz - az;
  const ex = eye[0] - (ax + bx) / 2;
  const ey = eye[1] - (ay + by) / 2;
  const ez = eye[2] - (az + bz) / 2;
  let px = dy * ez - dz * ey;
  let py = dz * ex - dx * ez;
  let pz = dx * ey - dy * ex;
  const len = Math.hypot(px, py, pz) || 1;
  const half = widthWorld / 2;
  px = (px / len) * half;
  py = (py / len) * half;
  pz = (pz / len) * half;
  // a0, a1, b1, a0, b1, b0
  out.set(
    [
      ax - px,
      ay - py,
      az - pz,
      ax + px,
      ay + py,
      az + pz,
      bx + px,
      by + py,
      bz + pz,
      ax - px,
      ay - py,
      az - pz,
      bx + px,
      by + py,
      bz + pz,
      bx - px,
      by - py,
      bz - pz,
    ],
    offset,
  );
}
