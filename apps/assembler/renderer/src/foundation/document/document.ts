/**
 * Parametric feature document of HimmelCAD Assembler (Phase 1 kernel spike).
 *
 * A document is an ordered list of {@link Feature}s. Evaluation — replaying
 * the list into real B-rep bodies — happens in the CAD kernel (OCCT via
 * replicad, see `../geometry-kernel/`), never here. This module holds only
 * the serializable feature data of the **core kinds** (the ones the
 * evaluator implements itself), the stable-reference types and the pure
 * sketch-frame math that both the kernel and the viewport need, so that the
 * UI can draw a sketch plane without asking the kernel. Every other kind —
 * the sketch (`../sketch-solver/sketchFeature.ts`) and the modelling kinds
 * of the domain modules — joins {@link Feature} through the feature-kind
 * registry (`featureKinds.ts`).
 *
 * Units are millimetres. Z is up; the construction grid is the XY plane at
 * z = 0. Everything here is plain data (structured-clone safe) so a feature
 * list can be posted to the kernel worker unchanged.
 */

import type { ChamferMode, EdgeRule, ShellDirection, ShellFaceThickness } from './blendOptions.js';
import type { FeatureBase } from './featureKinds.js';

export type { Feature, FeatureBase, FeatureKind } from './featureKinds.js';
export { isBooleanResult } from './featureKinds.js';

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

/**
 * Where a sketch lies: a canonical plane with offset, a planar body face,
 * or a construction plane (`model/construction.ts`) by feature id; `frame`
 * is its last evaluated frame (the reference's signature: shown before the
 * kernel answers and as the ghost of a missing reference, never used to
 * evaluate); `shown` is where the plane was drawn then (its centre and half
 * size — the frame's origin is only the world origin projected onto it).
 */
export type SketchPlaneRef =
  | { kind: 'plane'; plane: Plane; offset: Millimeters }
  | { kind: 'face'; face: FaceRef }
  | {
      kind: 'construction';
      featureId: string;
      frame: SketchFrame;
      shown?: { center: Vec3; size: Millimeters };
    };

/**
 * What an extrude reads its profile from: regions of a sketch by their
 * stable region key (`regions` absent = every region of the sketch), or a
 * planar body face (push/pull).
 */
export type ExtrudeProfileRef =
  | { kind: 'sketch'; featureId: string; regions?: string[] }
  | { kind: 'face'; face: FaceRef };

/** New body, or join into / cut from / intersect with the target body (Shapr3D badge). */
export type ExtrudeOperation = 'new' | 'join' | 'cut' | 'intersect';

/**
 * What a "To Object" extrude runs up to: a face (a planar face is extended
 * as its infinite plane; any other face stops at the first contact with its
 * body), or a body (the first contact with it).
 */
export type ExtrudeObjectRef = { kind: 'face'; face: FaceRef } | { kind: 'body'; bodyId: string };

/**
 * How far an extrude goes (Shapr3D "Distance / To Object / Through All").
 * `distance` (default) uses `distance` (and `distance2` / `symmetric`);
 * `throughAll` goes through every body in the direction of `distance`'s
 * sign (both ways when symmetric); `toObject` runs up to `target` in the
 * direction of `distance`'s sign.
 */
export type ExtrudeExtent =
  | { kind: 'distance' }
  | { kind: 'throughAll' }
  | { kind: 'toObject'; target: ExtrudeObjectRef };

/**
 * Extrudes a sketch profile along its sketch normal (or a planar face along
 * its outward normal — Shapr3D-style push/pull, which always joins for a
 * positive and cuts for a negative distance).
 */
export interface ExtrudeFeature extends FeatureBase {
  kind: 'extrude';
  profile: ExtrudeProfileRef;
  distance: Millimeters;
  /** Extent (absent = `{ kind: 'distance' }`). */
  extent?: ExtrudeExtent | undefined;
  /**
   * Two sides with separate distances: how far the extrude also goes to
   * the other side of the profile plane (≥ 0, mm). Ignored when `symmetric`.
   */
  distance2?: Millimeters | undefined;
  /** The extrude starts this far from the profile along its normal (Shapr3D "Start: Offset"), mm. */
  startOffset?: Millimeters | undefined;
  /**
   * Taper (draft) angle of the side walls, degrees (Shapr3D's extrude draft
   * angle): positive narrows the solid away from the start plane (holes
   * widen), negative widens it; both sides of a symmetric/two-sided
   * extrude narrow away from the start. Every extent (Through All and To
   * Object trim the tapered prism, Block 9).
   */
  taper?: number | undefined;
  /**
   * Source formula for `distance` (document parameters, `model/parameters.ts`),
   * when set. `distance` always holds the last successfully resolved value
   * (kept in sync by `model/store.ts` whenever a parameter changes), so the
   * kernel and every reader that only knows about `distance` keep working
   * unchanged.
   */
  distanceExpression?: string | undefined;
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
  /** Picked edges; may be empty when `rules` pick the edges. */
  edges: EdgeRef[];
  radius: Millimeters;
  /** Variable radius: `radius` at the start of each edge chain, `radius2` at its end. */
  radius2?: Millimeters;
  /** Edges chosen by rule (all edges of a face, all concave/convex edges), added to `edges`. */
  rules?: EdgeRule[];
  /** Source formula for `radius`, see {@link ExtrudeFeature.distanceExpression}. */
  radiusExpression?: string | undefined;
  /** Source formula for `radius2`. */
  radius2Expression?: string | undefined;
}

export interface ChamferFeature extends FeatureBase {
  kind: 'chamfer';
  /** Picked edges; may be empty when `rules` pick the edges. */
  edges: EdgeRef[];
  distance: Millimeters;
  /** `equal` (default): `distance` on both faces; `twoDistances`: `distance` and `distance2`; `distanceAngle`: `distance` and `angle`. */
  mode?: ChamferMode;
  distance2?: Millimeters;
  /** Degrees, measured from the face `distance` lies on (distanceAngle). */
  angle?: number;
  /** Measure `distance` on the other face of each edge (twoDistances/distanceAngle). */
  flip?: boolean;
  rules?: EdgeRule[];
  /** Source formula for `distance`, see {@link ExtrudeFeature.distanceExpression}. */
  distanceExpression?: string | undefined;
  /** Source formula for `distance2`. */
  distance2Expression?: string | undefined;
}

/** Hollows a body, opening the given faces, keeping walls of `thickness`. */
export interface ShellFeature extends FeatureBase {
  kind: 'shell';
  bodyId: string;
  faces: FaceRef[];
  thickness: Millimeters;
  /** `inside` (default): walls grow into the body; `outside`: the body becomes the cavity. */
  direction?: ShellDirection;
  /** Walls with their own thickness (the wall that grows from each face). */
  faceThickness?: ShellFaceThickness[];
  /** Outward only: the cavity is the body grown by this gap (a case that fits over it), mm. */
  clearance?: Millimeters;
  /** Source formula for `thickness`, see {@link ExtrudeFeature.distanceExpression}. */
  thicknessExpression?: string | undefined;
}

/** Body boolean; tool bodies are consumed unless `keepTools`. */
export interface BooleanFeature extends FeatureBase {
  kind: 'boolean';
  operation: 'union' | 'subtract' | 'intersect';
  targetBodyId: string;
  toolBodyIds: string[];
  /** Keep the tool bodies (e.g. a cutter used again, or a lid subtracted from its box). */
  keepTools?: boolean;
  /**
   * Keep the target body as it was: the result becomes a new body
   * (`bodyIdFor(id)`) — Shapr3D's separate "Keep Target" (Keep Originals: All
   * = both flags, Modified = target, Removed = tools, None = neither).
   */
  keepTarget?: boolean;
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
  /**
   * Visualisation material (`viewport/displayModes.ts` `MaterialId`: `pla`,
   * `petg`, `metal`, `resin`): how "Visualized" renders the body and the
   * density the Measure panel uses for mass. Optional; never affects geometry.
   */
  material?: 'pla' | 'petg' | 'metal' | 'resin';
}

/**
 * Imports a STEP file as one history step producing a body (Shapr3D-style
 * "Import"). The STEP content is embedded as base64 so the project file
 * (`.hcasm`) stays self-contained and Save/Reopen never depends on an
 * external path. Millimetres are assumed unless the STEP file's own units
 * say otherwise (the kernel reads the file's `ISO-10303` unit header).
 */
export interface ImportStepFeature extends FeatureBase {
  kind: 'importStep';
  /** Base64-encoded STEP file bytes (ASCII STEP text, so this is compact). */
  data: string;
  /** Original file name, for display and as the default body name. */
  fileName: string;
  /**
   * `assembly` (every import since the interop work, `kernel/stepImport.ts`):
   * one body per placed part, named and coloured from the file, with its
   * assembly folder path (`Body.itemPath`). Absent (older projects): the
   * whole file is one body, as it was imported then — kept so existing
   * references to that body stay valid.
   */
  structure?: 'assembly';
  /**
   * `iges`: the embedded file is IGES (HimmelCAD OCCT build only; bodies
   * per solid/open surface, no structure). Absent: STEP.
   */
  format?: 'iges';
}

/**
 * Converts a closed triangle mesh (an imported reference mesh) into a B-rep
 * solid (`kernel/meshSolid.ts`): coplanar neighbouring triangles become one
 * planar face, every other triangle its own planar face. The welded mesh is
 * embedded (`interop/meshSolid.ts` payload, base64) so the step replays
 * without the reference mesh.
 */
export interface MeshSolidFeature extends FeatureBase {
  kind: 'meshSolid';
  /** Base64 of the welded mesh payload (`encodeMeshSolidPayload`). */
  data: string;
  /** Name of the source (reference mesh name), the body's default name. */
  fileName: string;
  /** Triangle count of the payload (display, limits). */
  triangles: number;
}

/** The core kinds: implemented by the evaluator itself (`coreKinds.ts` registers them). */
declare module './featureKinds.js' {
  interface FeatureKindMap {
    extrude: ExtrudeFeature;
    fillet: FilletFeature;
    chamfer: ChamferFeature;
    shell: ShellFeature;
    boolean: BooleanFeature;
    move: MoveFeature;
    setAppearance: SetAppearanceFeature;
    importStep: ImportStepFeature;
    meshSolid: MeshSolidFeature;
  }
}

/** Minimum size, in millimetres, of sketch dimensions and extrude distances. */
export const MIN_FEATURE_SIZE_MM: Millimeters = 0.1;

/** Largest taper angle of an extrude (either sign), degrees. */
export const MAX_EXTRUDE_TAPER = 80;

/** Body id for the body created by a feature: derived from the feature id, never from position. */
export function bodyIdFor(featureId: string): string {
  return `body:${featureId}`;
}

/** Body id of the `index`-th body a feature creates besides `bodyIdFor(featureId)` (copies, split parts). */
export function extraBodyId(featureId: string, index: number): string {
  return `body:${featureId}:${index}`;
}

// ---- References shared by feature kinds ---------------------------------------

/** A closed profile: a sketch profile or a planar body face (the extrude profile reference). */
export type ProfileRef = ExtrudeProfileRef;

export type WorldAxis = 'X' | 'Y' | 'Z';

/**
 * A straight axis: a world axis (through `origin`, default the world
 * origin), a straight body edge (or the axis of a circular edge), or a
 * sketch line by entity id (construction lines included, e.g. a dedicated
 * centre line), read from the sketch's last solved state.
 */
export type AxisRef =
  | { kind: 'world'; axis: WorldAxis; origin?: Vec3 }
  | { kind: 'edge'; edge: EdgeRef }
  | { kind: 'sketchLine'; featureId: string; entityId: string }
  /** A construction axis (`model/construction.ts`) by feature id; `line` is its last evaluated line (signature). */
  | { kind: 'construction'; featureId: string; line: { point: Vec3; dir: Vec3 } };

/**
 * Sweep path: a chain of body edges, the closed outer outline of a sketch
 * region (by region key, see `sketch-solver/regions.ts`), or a straight world line.
 */
export type PathRef =
  | { kind: 'edges'; edges: EdgeRef[] }
  | { kind: 'sketch'; featureId: string; region: string }
  | { kind: 'line'; start: Vec3; end: Vec3 };

/** A plane: a construction plane with offset, or a planar body face. */
export type PlaneRef = SketchPlaneRef;

/** Unit vector of a world axis. */
export function worldAxisVector(axis: WorldAxis): Vec3 {
  return axis === 'X' ? [1, 0, 0] : axis === 'Y' ? [0, 1, 0] : [0, 0, 1];
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
