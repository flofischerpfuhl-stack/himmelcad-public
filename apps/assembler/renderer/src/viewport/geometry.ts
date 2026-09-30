/**
 * CPU-side vertex-buffer builders for the viewport. Turns the kernel's
 * indexed body meshes (`kernel/types.ts`) into the flat, non-indexed
 * `Float32Array`s `gl.ts` draws, with per-face sub-ranges for picking and
 * highlighting. Kept separate from `gl.ts` so geometry shape stays easy to
 * reason about without a GL context.
 */
import type { Body, BodyMesh } from '../foundation/geometry-kernel/types.js';

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

/**
 * Camera-facing ribbons of a constant **screen** width for a line-segment
 * list (selection/hover edges drawn ≈3 px wide — WebGL line width is
 * clamped to 1 px on most drivers). `worldPerPixel(distance)` converts a
 * pixel width at an eye distance into world units. Every vertex is pulled
 * `nudgePx` pixels' worth towards the eye along its view ray: the ribbon
 * keeps its screen position but wins the depth test against the two faces
 * that meet at the edge.
 */
export function buildScreenRibbon(
  segments: Float32Array,
  eye: readonly [number, number, number],
  widthPx: number,
  worldPerPixel: (distance: number) => number,
  nudgePx = 3,
): Float32Array {
  const count = Math.floor(segments.length / 6);
  const out = new Float32Array(count * 18);
  const a = [0, 0, 0];
  const b = [0, 0, 0];
  for (let s = 0; s < count; s += 1) {
    const o = s * 6;
    for (let k = 0; k < 3; k += 1) {
      a[k] = segments[o + k]!;
      b[k] = segments[o + 3 + k]!;
    }
    const mid = [(a[0]! + b[0]!) / 2, (a[1]! + b[1]!) / 2, (a[2]! + b[2]!) / 2];
    const distance = Math.hypot(eye[0] - mid[0]!, eye[1] - mid[1]!, eye[2] - mid[2]!) || 1;
    const perPx = worldPerPixel(distance);
    // Pull both ends towards the eye (along their own view rays).
    for (const p of [a, b]) {
      const dx = eye[0] - p[0]!;
      const dy = eye[1] - p[1]!;
      const dz = eye[2] - p[2]!;
      const len = Math.hypot(dx, dy, dz) || 1;
      const pull = Math.min(len * 0.5, perPx * nudgePx);
      p[0] = p[0]! + (dx / len) * pull;
      p[1] = p[1]! + (dy / len) * pull;
      p[2] = p[2]! + (dz / len) * pull;
    }
    // Extend each end by half a width so consecutive segments overlap at joints.
    const sx = b[0]! - a[0]!;
    const sy = b[1]! - a[1]!;
    const sz = b[2]! - a[2]!;
    const sl = Math.hypot(sx, sy, sz) || 1;
    const ext = (perPx * widthPx) / 2;
    const ax = a[0]! - (sx / sl) * ext;
    const ay = a[1]! - (sy / sl) * ext;
    const az = a[2]! - (sz / sl) * ext;
    const bx = b[0]! + (sx / sl) * ext;
    const by = b[1]! + (sy / sl) * ext;
    const bz = b[2]! + (sz / sl) * ext;
    writeRibbon(out, s * 18, ax, ay, az, bx, by, bz, eye, perPx * widthPx);
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
