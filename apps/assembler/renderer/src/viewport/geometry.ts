/**
 * CPU-side vertex-buffer builders for the viewport. Reads box-body helpers
 * from `mockDocument.ts` (faces/edges are derived from `min`/`max`, never
 * re-derived here) and turns them into flat `Float32Array`s ready for
 * `bufferData`. Kept separate from `gl.ts` so geometry shape stays easy to
 * reason about without a GL context.
 */
import {
  faceNormal,
  getEdgeEndpoints,
  getFaceCorners,
  ALL_EDGE_IDS,
  type Body,
  type EdgeId,
  type FaceSide,
} from '../model/mockDocument.js';

const FACE_SIDES: readonly FaceSide[] = ['+X', '-X', '+Y', '-Y', '+Z', '-Z'];

export interface BoxTriangles {
  /** 3 floats per vertex, 6 verts per face * 6 faces = 36 verts. */
  positions: Float32Array;
  normals: Float32Array;
  /** Which face side each vertex belongs to (length 36), for per-face picking ids and highlight masks. */
  sides: FaceSide[];
}

/** Builds a triangulated box (two triangles per face, outward winding) for shaded rendering and per-face picking. */
export function buildBoxTriangles(
  min: readonly [number, number, number],
  max: readonly [number, number, number],
): BoxTriangles {
  const positions = new Float32Array(36 * 3);
  const normals = new Float32Array(36 * 3);
  const sides: FaceSide[] = [];
  const body: Body = {
    id: '',
    name: '',
    min: [...min] as [number, number, number],
    max: [...max] as [number, number, number],
    color: '',
    createdBy: '',
  };
  let vi = 0;
  for (const side of FACE_SIDES) {
    const corners = getFaceCorners(body, side);
    const n = faceNormal(side);
    // Two triangles: 0-1-2 and 0-2-3, both consistent with outward normal
    // because getFaceCorners returns a fixed, consistent winding per axis.
    const triIndices = [0, 1, 2, 0, 2, 3];
    for (const ci of triIndices) {
      const c = corners[ci]!;
      positions[vi * 3] = c[0];
      positions[vi * 3 + 1] = c[1];
      positions[vi * 3 + 2] = c[2];
      normals[vi * 3] = n[0];
      normals[vi * 3 + 1] = n[1];
      normals[vi * 3 + 2] = n[2];
      sides.push(side);
      vi += 1;
    }
  }
  return { positions, normals, sides };
}

export interface BoxEdge {
  edge: EdgeId;
  a: readonly [number, number, number];
  b: readonly [number, number, number];
}

/** All 12 edges of a box body as world-space endpoint pairs. */
export function buildBoxEdges(
  min: readonly [number, number, number],
  max: readonly [number, number, number],
): BoxEdge[] {
  const body: Body = {
    id: '',
    name: '',
    min: [...min] as [number, number, number],
    max: [...max] as [number, number, number],
    color: '',
    createdBy: '',
  };
  return ALL_EDGE_IDS.map((edge) => {
    const [a, b] = getEdgeEndpoints(body, edge);
    return { edge, a, b };
  });
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
    // Vertical line (constant x = coord, spans y)
    target.push(coord, -extent, 0, coord, extent, 0);
    // Horizontal line (constant y = coord, spans x)
    target.push(-extent, coord, 0, extent, coord, 0);
  }
  return { minor: new Float32Array(minorSegs), major: new Float32Array(majorSegs) };
}

export interface AxisLines {
  positions: Float32Array;
  colors: Float32Array;
}

/** World X/Y/Z axis line segments from the origin to `length`, each tagged with its axis (0/1/2) via vertex color slot left to the caller. */
export function buildAxisLines(length: number): {
  x: [number, number, number][];
  y: [number, number, number][];
  z: [number, number, number][];
} {
  return {
    x: [
      [0, 0, 0],
      [length, 0, 0],
    ],
    y: [
      [0, 0, 0],
      [0, length, 0],
    ],
    z: [
      [0, 0, 0],
      [0, 0, length],
    ],
  };
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
  const dir = [b[0] - a[0], b[1] - a[1], b[2] - a[2]] as [number, number, number];
  const mid = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2] as [number, number, number];
  const toEye = [
    cameraPosition[0] - mid[0],
    cameraPosition[1] - mid[1],
    cameraPosition[2] - mid[2],
  ] as [number, number, number];
  let perp: [number, number, number] = [
    dir[1] * toEye[2] - dir[2] * toEye[1],
    dir[2] * toEye[0] - dir[0] * toEye[2],
    dir[0] * toEye[1] - dir[1] * toEye[0],
  ];
  const len = Math.hypot(perp[0], perp[1], perp[2]) || 1;
  perp = [perp[0] / len, perp[1] / len, perp[2] / len];
  const half = widthWorld / 2;
  const off: [number, number, number] = [perp[0] * half, perp[1] * half, perp[2] * half];
  const a0: [number, number, number] = [a[0] - off[0], a[1] - off[1], a[2] - off[2]];
  const a1: [number, number, number] = [a[0] + off[0], a[1] + off[1], a[2] + off[2]];
  const b0: [number, number, number] = [b[0] - off[0], b[1] - off[1], b[2] - off[2]];
  const b1: [number, number, number] = [b[0] + off[0], b[1] + off[1], b[2] + off[2]];
  const positions = new Float32Array([...a0, ...a1, ...b1, ...a0, ...b1, ...b0]);
  return { positions, triangleCount: 2 };
}
