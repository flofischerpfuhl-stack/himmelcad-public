/**
 * Parametric feature document of HimmelCAD Assembler (Phase 1 kernel spike).
 *
 * A document is an ordered list of {@link Feature}s. Evaluation — replaying
 * the list into real B-rep bodies — happens in the CAD kernel (OCCT via
 * replicad, see `../kernel/`), never here. This module holds only the
 * serializable feature data, the stable-reference types and the pure
 * sketch-frame math that both the kernel and the viewport need, so that the
 * UI can draw a sketch plane without asking the kernel.
 *
 * Units are millimetres. Z is up; the construction grid is the XY plane at
 * z = 0. Everything here is plain data (structured-clone safe) so a feature
 * list can be posted to the kernel worker unchanged.
 */

/** A length or coordinate in millimetres. */
export type Millimeters = number;

export type Vec3 = [number, number, number];

/** One of the three canonical construction planes. */
export type Plane = 'XY' | 'XZ' | 'YZ';

/** Surface class of a B-rep face as reported by the kernel. */
export type SurfaceKind = 'plane' | 'cylinder' | 'cone' | 'sphere' | 'torus' | 'other';

/** Curve class of a B-rep edge as reported by the kernel. */
export type CurveKind = 'line' | 'circle' | 'ellipse' | 'other';

/**
 * Geometric fingerprint of a face at the time a reference was taken. Used
 * only to disambiguate or, with a strict confidence threshold, to re-bind a
 * reference whose naming key no longer exists (see `kernel/naming.ts`).
 */
export interface FaceSignature {
  surface: SurfaceKind;
  /** Outward unit normal for planar faces, else `null`. */
  normal: Vec3 | null;
  centroid: Vec3;
  area: number;
  adjacentFaces: number;
}

/**
 * Stable reference to a face of a body. `key` is the kernel's naming key
 * (generating feature + role, e.g. `"feature-extrude-1:end"`); `signature`
 * is the geometric fallback. Never a mesh or explorer index.
 */
export interface FaceRef {
  bodyId: string;
  key: string;
  signature: FaceSignature;
}

export interface EdgeSignature {
  curve: CurveKind;
  midpoint: Vec3;
  length: number;
  /** Unit direction for straight edges, else `null`. */
  direction: Vec3 | null;
}

/**
 * Stable reference to an edge: `key` is `"<faceKeyA>|<faceKeyB>"` (sorted),
 * optionally suffixed `~n` when several edges separate the same two faces.
 */
export interface EdgeRef {
  bodyId: string;
  key: string;
  signature: EdgeSignature;
}

/** Fields every feature has, regardless of kind. */
export interface FeatureBase {
  /** Stable, unique identifier. Never reused, never derived from position. */
  id: string;
  /** History-card display name, e.g. `"Sketch 1"`, `"Extrude 2"`. */
  name: string;
  /** When `true`, evaluation skips this feature as if it were absent. */
  suppressed: boolean;
}

/** Where a sketch lies: a canonical plane with offset, or a planar body face. */
export type SketchPlaneRef =
  | { kind: 'plane'; plane: Plane; offset: Millimeters }
  | { kind: 'face'; face: FaceRef };

/**
 * One closed profile of a sketch, in the sketch frame's (u, v) coordinates.
 * Data-driven so polylines/arcs/constraints can be added as new kinds later.
 * A rectangle may have negative width/height (a drag towards -u/-v); it is
 * normalized during evaluation.
 */
export type SketchProfile =
  | { kind: 'rectangle'; x: Millimeters; y: Millimeters; width: Millimeters; height: Millimeters }
  | { kind: 'circle'; cx: Millimeters; cy: Millimeters; radius: Millimeters };

export interface SketchFeature extends FeatureBase {
  kind: 'sketch';
  plane: SketchPlaneRef;
  profiles: SketchProfile[];
}

/** What an extrude reads its profile from. */
export type ExtrudeProfileRef =
  | { kind: 'sketch'; featureId: string; profileIndex?: number }
  | { kind: 'face'; face: FaceRef };

export type ExtrudeOperation = 'new' | 'join' | 'cut';

/**
 * Extrudes a sketch profile along its sketch normal (or a planar face along
 * its outward normal — Shapr3D-style push/pull, which always joins for a
 * positive and cuts for a negative distance).
 */
export interface ExtrudeFeature extends FeatureBase {
  kind: 'extrude';
  profile: ExtrudeProfileRef;
  distance: Millimeters;
  /** Extrude `distance` to both sides of the sketch plane. */
  symmetric: boolean;
  operation: ExtrudeOperation;
  /** Body to join into / cut from. Defaults to the most recently changed body. */
  targetBodyId?: string;
  /** Display name for a newly created body. Defaults to `"Body {n}"`. */
  resultBodyName?: string;
}

export interface FilletFeature extends FeatureBase {
  kind: 'fillet';
  edges: EdgeRef[];
  radius: Millimeters;
}

export interface ChamferFeature extends FeatureBase {
  kind: 'chamfer';
  edges: EdgeRef[];
  distance: Millimeters;
}

/** Hollows a body, opening the given faces, keeping walls of `thickness`. */
export interface ShellFeature extends FeatureBase {
  kind: 'shell';
  bodyId: string;
  faces: FaceRef[];
  thickness: Millimeters;
}

/** Body boolean; tool bodies are consumed. */
export interface BooleanFeature extends FeatureBase {
  kind: 'boolean';
  operation: 'union' | 'subtract' | 'intersect';
  targetBodyId: string;
  toolBodyIds: string[];
}

/** Translates a body by a fixed delta, in millimetres. */
export interface MoveFeature extends FeatureBase {
  kind: 'move';
  bodyId: string;
  dx: Millimeters;
  dy: Millimeters;
  dz: Millimeters;
}

/** Sets a body's display color. */
export interface SetAppearanceFeature extends FeatureBase {
  kind: 'setAppearance';
  bodyId: string;
  /** sRGB hex color, e.g. `"#5B8DEF"`. */
  color: string;
}

export type Feature =
  | SketchFeature
  | ExtrudeFeature
  | FilletFeature
  | ChamferFeature
  | ShellFeature
  | BooleanFeature
  | MoveFeature
  | SetAppearanceFeature;

/** Minimum size, in millimetres, of sketch dimensions and extrude distances. */
export const MIN_FEATURE_SIZE_MM: Millimeters = 0.1;

/** Body id for the body created by a feature: derived from the feature id, never from position. */
export function bodyIdFor(featureId: string): string {
  return `body:${featureId}`;
}

// ---- Sketch frames ----------------------------------------------------------

/** Orthonormal sketch frame: profile (u, v) coordinates map to `origin + u*U + v*V`. */
export interface SketchFrame {
  origin: Vec3;
  u: Vec3;
  v: Vec3;
  /** Extrude direction for a positive distance. */
  normal: Vec3;
}

/** Canonical frame of a construction plane (u/v match the viewport's plane embedding). */
export function frameForPlane(plane: Plane, offset: Millimeters): SketchFrame {
  if (plane === 'XY')
    return { origin: [0, 0, offset], u: [1, 0, 0], v: [0, 1, 0], normal: [0, 0, 1] };
  if (plane === 'XZ')
    return { origin: [0, offset, 0], u: [1, 0, 0], v: [0, 0, 1], normal: [0, 1, 0] };
  return { origin: [offset, 0, 0], u: [0, 1, 0], v: [0, 0, 1], normal: [1, 0, 0] };
}

const AXIS_PLANE: readonly Plane[] = ['YZ', 'XZ', 'XY'];

/**
 * Deterministic frame for a planar face with outward normal `normal`
 * through `pointOnPlane`. Axis-aligned faces use the canonical plane axes
 * (so sketch coordinates stay world coordinates, e.g. a sketch on a top
 * face at z = 6 uses world X/Y); other faces project world axes. The
 * frame's `normal` is the face's outward normal, so a positive extrude
 * distance always grows away from the material.
 */
export function frameForFace(
  normal: readonly [number, number, number],
  pointOnPlane: readonly [number, number, number],
): SketchFrame {
  const n = normalize(normal);
  for (let axis = 0; axis < 3; axis += 1) {
    if (Math.abs(n[axis]!) > 1 - 1e-9) {
      const canonical = frameForPlane(AXIS_PLANE[axis]!, pointOnPlane[axis]!);
      return { ...canonical, normal: n };
    }
  }
  const d = dot(n, pointOnPlane);
  const origin: Vec3 = [n[0] * d, n[1] * d, n[2] * d];
  // Project the world axis least aligned with the normal.
  const abs = n.map(Math.abs);
  const axisIndex = abs.indexOf(Math.min(...abs));
  const ref: Vec3 = [0, 0, 0];
  ref[axisIndex] = 1;
  const k = dot(ref, n);
  const u = normalize([ref[0] - n[0] * k, ref[1] - n[1] * k, ref[2] - n[2] * k]);
  const v = cross(n, u);
  return { origin, u, v, normal: n };
}

/** World point of sketch coordinates `(u, v)`. */
export function framePoint(frame: SketchFrame, u: number, v: number): Vec3 {
  return [
    frame.origin[0] + frame.u[0] * u + frame.v[0] * v,
    frame.origin[1] + frame.u[1] * u + frame.v[1] * v,
    frame.origin[2] + frame.u[2] * u + frame.v[2] * v,
  ];
}

/** Sketch coordinates of a world point (projected onto the frame plane). */
export function frameUv(
  frame: SketchFrame,
  point: readonly [number, number, number],
): { u: number; v: number } {
  const rel: Vec3 = [
    point[0] - frame.origin[0],
    point[1] - frame.origin[1],
    point[2] - frame.origin[2],
  ];
  return { u: dot(rel, frame.u), v: dot(rel, frame.v) };
}

/** Normalized rectangle (non-negative size). */
export function normalizeRect(p: { x: number; y: number; width: number; height: number }): {
  x0: number;
  y0: number;
  w: number;
  h: number;
} {
  const x0 = p.width >= 0 ? p.x : p.x + p.width;
  const y0 = p.height >= 0 ? p.y : p.y + p.height;
  return { x0, y0, w: Math.abs(p.width), h: Math.abs(p.height) };
}

/**
 * Closed outline of a profile in sketch (u, v) coordinates, counter-
 * clockwise, without repeating the first point. Rectangles give their four
 * corners in segment order (segment i runs from point i to point i+1:
 * 0 = bottom (-v), 1 = right (+u), 2 = top (+v), 3 = left (-u)); circles
 * give `segments` samples.
 */
export function profileOutlineUv(profile: SketchProfile, segments = 64): [number, number][] {
  if (profile.kind === 'rectangle') {
    const { x0, y0, w, h } = normalizeRect(profile);
    return [
      [x0, y0],
      [x0 + w, y0],
      [x0 + w, y0 + h],
      [x0, y0 + h],
    ];
  }
  const points: [number, number][] = [];
  for (let i = 0; i < segments; i += 1) {
    const a = (i / segments) * Math.PI * 2;
    points.push([
      profile.cx + Math.cos(a) * profile.radius,
      profile.cy + Math.sin(a) * profile.radius,
    ]);
  }
  return points;
}

/** Centre of a profile in sketch coordinates. */
export function profileCenterUv(profile: SketchProfile): [number, number] {
  if (profile.kind === 'circle') return [profile.cx, profile.cy];
  const { x0, y0, w, h } = normalizeRect(profile);
  return [x0 + w / 2, y0 + h / 2];
}

/** Error message for a profile below the minimum size, or `null` when valid. */
export function profileSizeError(profile: SketchProfile): string | null {
  if (profile.kind === 'rectangle') {
    const { w, h } = normalizeRect(profile);
    if (w < MIN_FEATURE_SIZE_MM || h < MIN_FEATURE_SIZE_MM) {
      return `Sketch rectangle is too small (${w.toFixed(3)} x ${h.toFixed(3)} mm)`;
    }
    return null;
  }
  if (profile.radius < MIN_FEATURE_SIZE_MM / 2) {
    return `Sketch circle is too small (radius ${profile.radius.toFixed(3)} mm)`;
  }
  return null;
}

function dot(a: readonly [number, number, number], b: readonly [number, number, number]): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

function cross(a: Vec3, b: Vec3): Vec3 {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}

function normalize(v: readonly [number, number, number]): Vec3 {
  const len = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / len, v[1] / len, v[2] / len];
}

// ---- Demo document ------------------------------------------------------------

/**
 * Printable demo bracket, as real B-rep: an 80 x 50 x 6 mm base plate, an
 * 80 x 8 x 40 mm upright joined onto its back edge (y = 42..50), a 4 mm fillet on the
 * inner edge between plate top and upright front, and a 6 mm through-hole
 * sketched on the plate's top face and cut through the plate.
 *
 * Hand calculation (used by the kernel tests): volume
 * `80*50*6 + 80*8*40 + (4^2 - pi*4^2/4)*80 - pi*3^2*6 = 49 705.04 mm^3`,
 * bounding box `[0, 0, 0]..[80, 50, 46]`.
 *
 * The references below carry naming keys the kernel derives on its own
 * (`kernel/naming.ts`); their signatures are hand-computed and only serve
 * as a fallback.
 */
export function createDemoDocument(): Feature[] {
  const plateBody = bodyIdFor('feature-extrude-1');
  const sketch1: SketchFeature = {
    id: 'feature-sketch-1',
    name: 'Sketch 1',
    suppressed: false,
    kind: 'sketch',
    plane: { kind: 'plane', plane: 'XY', offset: 0 },
    profiles: [{ kind: 'rectangle', x: 0, y: 0, width: 80, height: 50 }],
  };
  const extrude1: ExtrudeFeature = {
    id: 'feature-extrude-1',
    name: 'Extrude 1',
    suppressed: false,
    kind: 'extrude',
    profile: { kind: 'sketch', featureId: sketch1.id },
    distance: 6,
    symmetric: false,
    operation: 'new',
    resultBodyName: 'Bracket',
  };
  const sketch2: SketchFeature = {
    id: 'feature-sketch-2',
    name: 'Sketch 2',
    suppressed: false,
    kind: 'sketch',
    plane: { kind: 'plane', plane: 'XY', offset: 6 },
    profiles: [{ kind: 'rectangle', x: 0, y: 42, width: 80, height: 8 }],
  };
  const extrude2: ExtrudeFeature = {
    id: 'feature-extrude-2',
    name: 'Extrude 2',
    suppressed: false,
    kind: 'extrude',
    profile: { kind: 'sketch', featureId: sketch2.id },
    distance: 40,
    symmetric: false,
    operation: 'join',
    targetBodyId: plateBody,
  };
  const fillet1: FilletFeature = {
    id: 'feature-fillet-3',
    name: 'Fillet 1',
    suppressed: false,
    kind: 'fillet',
    radius: 4,
    edges: [
      {
        bodyId: plateBody,
        // Plate top face | upright front face (rectangle segment 0 = -v side, y = 42).
        key: 'feature-extrude-1:end:0|feature-extrude-2:side:0:0',
        signature: { curve: 'line', midpoint: [40, 42, 6], length: 80, direction: [1, 0, 0] },
      },
    ],
  };
  const sketch3: SketchFeature = {
    id: 'feature-sketch-4',
    name: 'Sketch 3',
    suppressed: false,
    kind: 'sketch',
    plane: {
      kind: 'face',
      face: {
        bodyId: plateBody,
        key: 'feature-extrude-1:end:0',
        signature: {
          surface: 'plane',
          normal: [0, 0, 1],
          centroid: [40, 20, 6],
          area: 3360,
          adjacentFaces: 5,
        },
      },
    },
    profiles: [{ kind: 'circle', cx: 40, cy: 20, radius: 3 }],
  };
  const extrude3: ExtrudeFeature = {
    id: 'feature-extrude-5',
    name: 'Extrude 3',
    suppressed: false,
    kind: 'extrude',
    profile: { kind: 'sketch', featureId: sketch3.id },
    distance: -8,
    symmetric: false,
    operation: 'cut',
    targetBodyId: plateBody,
  };
  return [sketch1, extrude1, sketch2, extrude2, fillet1, sketch3, extrude3];
}
