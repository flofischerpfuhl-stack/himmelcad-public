/**
 * Mock parametric document for the HimmelCAD Assembler Phase 0 UI shell.
 *
 * There is no CAD kernel yet. Every "body" produced here is an axis-aligned
 * box (an AABB) — never present these as real CAD geometry (BRep/NURBS) in
 * names, comments, or UI copy. This module exists so the UI shell
 * (viewport, panels, history, adaptive toolbar) can demonstrate a real
 * parametric workflow — sketch → extrude → edit-history → re-evaluate —
 * without depending on a geometry kernel.
 *
 * Units are millimetres. Z is up; the construction grid is the XY plane at
 * z = 0.
 *
 * This module is pure and side-effect-free: no module-level mutable state,
 * no I/O, no randomness, no `Date.now()`. `evaluate()` is a deterministic
 * fold over a `Feature[]` array; the same input always produces the same
 * output. Identity generation (feature ids, undo/redo, tool sessions) is
 * the store's job (`store.ts`), not this module's.
 */

/** A length or coordinate in millimetres. */
export type Millimeters = number;

/** One of the three canonical construction planes. */
export type Plane = 'XY' | 'XZ' | 'YZ';

/**
 * One of the six outward-facing sides of an axis-aligned box body.
 * `'+X'` is the face whose plane is at `body.max[0]`, outward normal
 * `(1, 0, 0)`; `'-X'` is at `body.min[0]`, outward normal `(-1, 0, 0)`;
 * analogously for Y and Z.
 */
export type FaceSide = '+X' | '-X' | '+Y' | '-Y' | '+Z' | '-Z';

/**
 * Canonical id of one of the 12 edges of a box body, written as its two
 * adjacent face sides joined by `'|'` in the fixed order
 * `['+X','-X','+Y','-Y','+Z','-Z']` (whichever side appears first in that
 * list is written first). Use {@link canonicalEdgeId} to build one instead
 * of constructing the string by hand — the order is easy to get wrong.
 *
 * Edge identity is semantic (which two faces meet), never a mesh/array
 * index, so it survives re-evaluation as long as the body still exists.
 */
export type EdgeId = `${FaceSide}|${FaceSide}`;

/** Fields every feature has, regardless of kind. */
export interface FeatureBase {
  /** Stable, unique identifier. Never reused, never derived from position. */
  id: string;
  /** History-card display name, e.g. `"Sketch 1"`, `"Extrude 2"`. */
  name: string;
  /**
   * When `true`, {@link evaluate} skips this feature entirely (as if it
   * were absent), which may cascade into missing-reference errors on
   * features that depended on it.
   */
  suppressed: boolean;
}

/**
 * A closed rectangular sketch profile on one of the three construction
 * planes. `x`/`y` are the in-plane coordinates of one corner; `width`/
 * `height` may be given negative (e.g. a drag that went top-left instead
 * of bottom-right) — {@link evaluate} normalizes the rectangle so
 * `min <= max` before anyone reads the result via {@link EvaluatedSketch}.
 */
export interface SketchRectFeature extends FeatureBase {
  kind: 'sketchRect';
  plane: Plane;
  /** Position of the sketch plane along its normal axis, in millimetres. */
  offset: Millimeters;
  x: Millimeters;
  y: Millimeters;
  width: Millimeters;
  height: Millimeters;
}

/** What an extrude feature reads its profile from. */
export type ExtrudeProfileRef =
  | { kind: 'sketch'; featureId: string }
  | { kind: 'face'; bodyId: string; side: FaceSide };

/**
 * Creates or grows/shrinks a box body.
 *
 * - `profile.kind === 'sketch'`: extrudes the referenced rectangle along
 *   its plane's normal by `distance` (sign selects direction), producing a
 *   new box body — unless `operation === 'join'` and a body already
 *   exists, in which case the new box is unioned (axis-aligned bounding
 *   box union) into the most recently created/modified body instead of
 *   creating a new one. See the "Contract decisions" note in this file's
 *   header comment / the module README for why `'join'` behaves this way
 *   in a kernel-less mock.
 * - `profile.kind === 'face'`: extends or shrinks the referenced body
 *   along that face's outward normal by `distance` (negative shrinks).
 *   `operation` has no effect for face profiles — a face extrude always
 *   modifies the existing body in place, it never creates a new one.
 *
 * A shrink (or an inverting growth on the opposite side) that would take
 * the affected dimension below {@link MIN_FEATURE_SIZE_MM} is **not**
 * silently clamped: {@link evaluate} records a feature error and leaves
 * the body exactly as it was before this feature.
 */
export interface ExtrudeFeature extends FeatureBase {
  kind: 'extrude';
  profile: ExtrudeProfileRef;
  distance: Millimeters;
  operation: 'new' | 'join';
  /**
   * Contract decision: display name for the body created by this feature
   * (only used when `profile.kind === 'sketch'` and a new body is
   * created). Phase 0 has no standalone "rename body" action — an
   * extrude's own history-card `name` follows the Shapr3D-style
   * "Extrude 1", "Extrude 2", … convention and must not be reused as the
   * body's name (see `createDemoDocument`'s "Base plate" / "Upright").
   * Defaults to `"Body {n}"` (n = creation order, 1-based) when omitted.
   */
  resultBodyName?: string;
}

/** Translates a body by a fixed delta, in millimetres. */
export interface MoveFeature extends FeatureBase {
  kind: 'move';
  bodyId: string;
  dx: Millimeters;
  dy: Millimeters;
  dz: Millimeters;
}

/** Sets a body's display color. Deliberately trivial — see task scope. */
export interface SetAppearanceFeature extends FeatureBase {
  kind: 'setAppearance';
  bodyId: string;
  /** sRGB hex color, e.g. `"#5B8DEF"`. */
  color: string;
}

/** The full set of mock-document feature kinds. */
export type Feature = SketchRectFeature | ExtrudeFeature | MoveFeature | SetAppearanceFeature;

/** A box body resulting from evaluating a feature history. */
export interface Body {
  /**
   * Derived deterministically from the creating feature's id (never from
   * array position), so editing an earlier step and re-evaluating keeps
   * this id stable across re-evaluations.
   */
  id: string;
  name: string;
  min: [Millimeters, Millimeters, Millimeters];
  max: [Millimeters, Millimeters, Millimeters];
  /** Theme-independent sRGB hex color, assigned by creation order. */
  color: string;
  /** The id of the feature that created this body. */
  createdBy: string;
}

/** A sketch rectangle after normalization (`min <= max` on both axes). */
export interface EvaluatedSketch {
  featureId: string;
  plane: Plane;
  offset: Millimeters;
  min: [Millimeters, Millimeters];
  max: [Millimeters, Millimeters];
}

/** Result of replaying a feature list. */
export interface EvaluationResult {
  /** Bodies in creation order. */
  bodies: Body[];
  /** Evaluated sketch profiles, in feature order. */
  sketches: EvaluatedSketch[];
  /** Per-feature error message, keyed by feature id. Absent = no error. */
  errors: Record<string, string>;
}

/**
 * Minimum size, in millimetres, any body dimension may have after an
 * extrude. A face-extrude that would take a dimension below this (whether
 * by shrinking or by inverting through zero) is rejected with a feature
 * error instead of being silently clamped.
 */
export const MIN_FEATURE_SIZE_MM: Millimeters = 0.1;

const FACE_SIDE_ORDER: readonly FaceSide[] = ['+X', '-X', '+Y', '-Y', '+Z', '-Z'];

const AXIS_OF_SIDE: Readonly<Record<FaceSide, 0 | 1 | 2>> = {
  '+X': 0,
  '-X': 0,
  '+Y': 1,
  '-Y': 1,
  '+Z': 2,
  '-Z': 2,
};

const SIGN_OF_SIDE: Readonly<Record<FaceSide, 1 | -1>> = {
  '+X': 1,
  '-X': -1,
  '+Y': 1,
  '-Y': -1,
  '+Z': 1,
  '-Z': -1,
};

const NORMAL_OF_SIDE: Readonly<Record<FaceSide, readonly [number, number, number]>> = {
  '+X': [1, 0, 0],
  '-X': [-1, 0, 0],
  '+Y': [0, 1, 0],
  '-Y': [0, -1, 0],
  '+Z': [0, 0, 1],
  '-Z': [0, 0, -1],
};

/** Outward unit normal of a box face, e.g. `'+X' -> [1, 0, 0]`. */
export function faceNormal(side: FaceSide): readonly [number, number, number] {
  return NORMAL_OF_SIDE[side];
}

/** All 12 canonical edge ids of a box, in a fixed, deterministic order. */
export const ALL_EDGE_IDS: readonly EdgeId[] = (() => {
  const ids: EdgeId[] = [];
  for (let i = 0; i < FACE_SIDE_ORDER.length; i += 1) {
    for (let j = i + 1; j < FACE_SIDE_ORDER.length; j += 1) {
      const a = FACE_SIDE_ORDER[i]!;
      const b = FACE_SIDE_ORDER[j]!;
      if (AXIS_OF_SIDE[a] !== AXIS_OF_SIDE[b]) ids.push(canonicalEdgeId(a, b));
    }
  }
  return ids;
})();

/**
 * Builds the canonical {@link EdgeId} for the edge shared by two faces.
 * Throws if the two faces are on the same axis (opposite faces never
 * share an edge; identical faces are not an edge).
 */
export function canonicalEdgeId(a: FaceSide, b: FaceSide): EdgeId {
  if (AXIS_OF_SIDE[a] === AXIS_OF_SIDE[b]) {
    throw new Error(`Invalid edge: faces "${a}" and "${b}" lie on the same axis`);
  }
  const [first, second] = FACE_SIDE_ORDER.indexOf(a) < FACE_SIDE_ORDER.indexOf(b) ? [a, b] : [b, a];
  return `${first}|${second}` as EdgeId;
}

function faceCoordinate(body: Body, side: FaceSide): number {
  const axis = AXIS_OF_SIDE[side];
  return SIGN_OF_SIDE[side] > 0 ? body.max[axis] : body.min[axis];
}

/**
 * The four corners of a body's face, in an arbitrary but consistent
 * winding order. Do not infer the outward normal from this winding — use
 * {@link faceNormal} instead.
 */
export function getFaceCorners(
  body: Body,
  side: FaceSide,
): [
  [number, number, number],
  [number, number, number],
  [number, number, number],
  [number, number, number],
] {
  const axis = AXIS_OF_SIDE[side];
  const [otherA, otherB] = [0, 1, 2].filter((a) => a !== axis) as [0 | 1 | 2, 0 | 1 | 2];
  const coord = faceCoordinate(body, side);
  const corners: [number, number][] = [
    [body.min[otherA], body.min[otherB]],
    [body.max[otherA], body.min[otherB]],
    [body.max[otherA], body.max[otherB]],
    [body.min[otherA], body.max[otherB]],
  ];
  return corners.map((pair) => {
    const point: [number, number, number] = [0, 0, 0];
    point[axis] = coord;
    point[otherA] = pair[0];
    point[otherB] = pair[1];
    return point;
  }) as [
    [number, number, number],
    [number, number, number],
    [number, number, number],
    [number, number, number],
  ];
}

/** The two endpoints of a body's edge, in min-to-max order along the free axis. */
export function getEdgeEndpoints(
  body: Body,
  edge: EdgeId,
): [[number, number, number], [number, number, number]] {
  const [sideA, sideB] = edge.split('|') as [FaceSide, FaceSide];
  const axisA = AXIS_OF_SIDE[sideA];
  const axisB = AXIS_OF_SIDE[sideB];
  if (axisA === axisB) {
    throw new Error(`Invalid edge id "${edge}": faces share an axis`);
  }
  const freeAxis = ([0, 1, 2] as const).find((a) => a !== axisA && a !== axisB)!;
  const lo: [number, number, number] = [0, 0, 0];
  const hi: [number, number, number] = [0, 0, 0];
  lo[axisA] = faceCoordinate(body, sideA);
  hi[axisA] = faceCoordinate(body, sideA);
  lo[axisB] = faceCoordinate(body, sideB);
  hi[axisB] = faceCoordinate(body, sideB);
  lo[freeAxis] = body.min[freeAxis];
  hi[freeAxis] = body.max[freeAxis];
  return [lo, hi];
}

/** `max - min` per axis. */
export function bodyDimensions(body: Body): [number, number, number] {
  return [body.max[0] - body.min[0], body.max[1] - body.min[1], body.max[2] - body.min[2]];
}

interface PlaneAxes {
  u: 0 | 1 | 2;
  v: 0 | 1 | 2;
  normal: 0 | 1 | 2;
}

const PLANE_AXES: Readonly<Record<Plane, PlaneAxes>> = {
  XY: { u: 0, v: 1, normal: 2 },
  XZ: { u: 0, v: 2, normal: 1 },
  YZ: { u: 1, v: 2, normal: 0 },
};

/**
 * Derives the construction plane and offset of one of a body's faces —
 * every face of an axis-aligned box lies exactly on one of the three
 * canonical planes. Used to start a sketch on a selected body face.
 */
export function planeForFace(body: Body, side: FaceSide): { plane: Plane; offset: Millimeters } {
  const axis = AXIS_OF_SIDE[side];
  const offset = faceCoordinate(body, side);
  const plane: Plane = axis === 2 ? 'XY' : axis === 1 ? 'XZ' : 'YZ';
  return { plane, offset };
}

/** Raised internally for a feature that cannot be evaluated; caught by {@link evaluate}. */
class FeatureEvaluationError extends Error {}

function normalizeRect(
  x: number,
  y: number,
  width: number,
  height: number,
): { x0: number; y0: number; w: number; h: number } {
  const x0 = width >= 0 ? x : x + width;
  const y0 = height >= 0 ? y : y + height;
  return { x0, y0, w: Math.abs(width), h: Math.abs(height) };
}

function evaluateSketchRect(feature: SketchRectFeature): EvaluatedSketch {
  const { x0, y0, w, h } = normalizeRect(feature.x, feature.y, feature.width, feature.height);
  if (w < MIN_FEATURE_SIZE_MM || h < MIN_FEATURE_SIZE_MM) {
    throw new FeatureEvaluationError(
      `Sketch rectangle is too small (${w.toFixed(3)} x ${h.toFixed(3)} mm)`,
    );
  }
  return {
    featureId: feature.id,
    plane: feature.plane,
    offset: feature.offset,
    min: [x0, y0],
    max: [x0 + w, y0 + h],
  };
}

function buildBoxFromSketch(
  sketch: EvaluatedSketch,
  distance: number,
): { min: [number, number, number]; max: [number, number, number] } {
  const axes = PLANE_AXES[sketch.plane];
  const min: [number, number, number] = [0, 0, 0];
  const max: [number, number, number] = [0, 0, 0];
  min[axes.u] = sketch.min[0];
  max[axes.u] = sketch.max[0];
  min[axes.v] = sketch.min[1];
  max[axes.v] = sketch.max[1];
  min[axes.normal] = Math.min(sketch.offset, sketch.offset + distance);
  max[axes.normal] = Math.max(sketch.offset, sketch.offset + distance);
  return { min, max };
}

function componentwiseMin3(
  a: [number, number, number],
  b: [number, number, number],
): [number, number, number] {
  return [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.min(a[2], b[2])];
}

function componentwiseMax3(
  a: [number, number, number],
  b: [number, number, number],
): [number, number, number] {
  return [Math.max(a[0], b[0]), Math.max(a[1], b[1]), Math.max(a[2], b[2])];
}

const COLOR_PALETTE: readonly string[] = [
  '#5B8DEF',
  '#F2994A',
  '#27AE60',
  '#BB6BD9',
  '#EB5757',
  '#2D9CDB',
  '#F2C94C',
  '#6FCF97',
];

function paletteColor(creationIndex: number): string {
  return COLOR_PALETTE[creationIndex % COLOR_PALETTE.length]!;
}

function applyExtrude(
  feature: ExtrudeFeature,
  bodies: Map<string, Body>,
  bodyOrder: string[],
  sketches: Map<string, EvaluatedSketch>,
  createdSoFar: number,
): 'created' | 'modified' {
  if (Math.abs(feature.distance) < MIN_FEATURE_SIZE_MM) {
    throw new FeatureEvaluationError(
      `Extrude distance must be at least ${MIN_FEATURE_SIZE_MM} mm in magnitude`,
    );
  }

  if (feature.profile.kind === 'face') {
    const target = bodies.get(feature.profile.bodyId);
    if (!target) {
      throw new FeatureEvaluationError(`Missing reference: body "${feature.profile.bodyId}"`);
    }
    const side = feature.profile.side;
    const axis = AXIS_OF_SIDE[side];
    const sign = SIGN_OF_SIDE[side];
    const currentSize = target.max[axis] - target.min[axis];
    const nextSize = currentSize + feature.distance;
    if (nextSize < MIN_FEATURE_SIZE_MM) {
      throw new FeatureEvaluationError(
        `Face extrude on "${target.name}" (${side}) would leave a size of ` +
          `${nextSize.toFixed(3)} mm, below the ${MIN_FEATURE_SIZE_MM} mm minimum`,
      );
    }
    const min: [number, number, number] = [...target.min];
    const max: [number, number, number] = [...target.max];
    if (sign > 0) {
      max[axis] = target.max[axis] + feature.distance;
    } else {
      min[axis] = target.min[axis] - feature.distance;
    }
    bodies.set(target.id, { ...target, min, max });
    return 'modified';
  }

  const sketch = sketches.get(feature.profile.featureId);
  if (!sketch) {
    throw new FeatureEvaluationError(`Missing reference: sketch "${feature.profile.featureId}"`);
  }
  const box = buildBoxFromSketch(sketch, feature.distance);

  if (feature.operation === 'join' && bodyOrder.length > 0) {
    const targetId = bodyOrder[bodyOrder.length - 1]!;
    const target = bodies.get(targetId)!;
    bodies.set(targetId, {
      ...target,
      min: componentwiseMin3(target.min, box.min),
      max: componentwiseMax3(target.max, box.max),
    });
    return 'modified';
  }

  const bodyId = `body:${feature.id}`;
  const body: Body = {
    id: bodyId,
    name: feature.resultBodyName ?? `Body ${createdSoFar + 1}`,
    min: box.min,
    max: box.max,
    color: paletteColor(createdSoFar),
    createdBy: feature.id,
  };
  bodies.set(bodyId, body);
  bodyOrder.push(bodyId);
  return 'created';
}

function applyMove(feature: MoveFeature, bodies: Map<string, Body>): void {
  const target = bodies.get(feature.bodyId);
  if (!target) {
    throw new FeatureEvaluationError(`Missing reference: body "${feature.bodyId}"`);
  }
  bodies.set(feature.bodyId, {
    ...target,
    min: [target.min[0] + feature.dx, target.min[1] + feature.dy, target.min[2] + feature.dz],
    max: [target.max[0] + feature.dx, target.max[1] + feature.dy, target.max[2] + feature.dz],
  });
}

function applySetAppearance(feature: SetAppearanceFeature, bodies: Map<string, Body>): void {
  const target = bodies.get(feature.bodyId);
  if (!target) {
    throw new FeatureEvaluationError(`Missing reference: body "${feature.bodyId}"`);
  }
  bodies.set(feature.bodyId, { ...target, color: feature.color });
}

/**
 * Replays a feature list from scratch and returns the resulting bodies,
 * sketches, and per-feature errors. Deterministic and pure: same input,
 * same output, no shared mutable state between calls.
 *
 * A feature whose reference is missing (its sketch or body was deleted or
 * is suppressed) gets an error recorded under its own feature id and is
 * skipped; every later feature is still evaluated. Suppressed features are
 * skipped without an error.
 */
export function evaluate(features: readonly Feature[]): EvaluationResult {
  const bodies = new Map<string, Body>();
  const bodyOrder: string[] = [];
  const sketches = new Map<string, EvaluatedSketch>();
  const errors: Record<string, string> = {};
  let created = 0;

  for (const feature of features) {
    if (feature.suppressed) continue;
    try {
      switch (feature.kind) {
        case 'sketchRect':
          sketches.set(feature.id, evaluateSketchRect(feature));
          break;
        case 'extrude': {
          const outcome = applyExtrude(feature, bodies, bodyOrder, sketches, created);
          if (outcome === 'created') created += 1;
          break;
        }
        case 'move':
          applyMove(feature, bodies);
          break;
        case 'setAppearance':
          applySetAppearance(feature, bodies);
          break;
      }
    } catch (error) {
      errors[feature.id] = error instanceof Error ? error.message : String(error);
    }
  }

  return {
    bodies: bodyOrder.map((id) => bodies.get(id)).filter((b): b is Body => b !== undefined),
    sketches: [...sketches.values()],
    errors,
  };
}

/**
 * A small printable demo part: an 80x50x6 mm "Base plate" (sketch +
 * extrude) and an 80x8x40 mm "Upright" standing on the plate's top face
 * (sketch + extrude, then a face-extrude that thickens it from 6 to 8
 * mm). Feature history-card names follow the Shapr3D convention
 * ("Sketch 1", "Extrude 1", …); body names ("Base plate", "Upright") are
 * set via `resultBodyName` — see {@link ExtrudeFeature}.
 */
export function createDemoDocument(): Feature[] {
  const sketch1: SketchRectFeature = {
    id: 'feature-sketch-1',
    name: 'Sketch 1',
    suppressed: false,
    kind: 'sketchRect',
    plane: 'XY',
    offset: 0,
    x: 0,
    y: 0,
    width: 80,
    height: 50,
  };
  const extrude1: ExtrudeFeature = {
    id: 'feature-extrude-1',
    name: 'Extrude 1',
    suppressed: false,
    kind: 'extrude',
    profile: { kind: 'sketch', featureId: sketch1.id },
    distance: 6,
    operation: 'new',
    resultBodyName: 'Base plate',
  };
  const sketch2: SketchRectFeature = {
    id: 'feature-sketch-2',
    name: 'Sketch 2',
    suppressed: false,
    kind: 'sketchRect',
    plane: 'XY',
    offset: 6,
    x: 0,
    y: 0,
    width: 80,
    height: 6,
  };
  const extrude2: ExtrudeFeature = {
    id: 'feature-extrude-2',
    name: 'Extrude 2',
    suppressed: false,
    kind: 'extrude',
    profile: { kind: 'sketch', featureId: sketch2.id },
    distance: 40,
    operation: 'new',
    resultBodyName: 'Upright',
  };
  const extrude3: ExtrudeFeature = {
    id: 'feature-extrude-3',
    name: 'Extrude 3',
    suppressed: false,
    kind: 'extrude',
    profile: { kind: 'face', bodyId: `body:${extrude2.id}`, side: '+Y' },
    distance: 2,
    operation: 'join',
  };
  return [sketch1, extrude1, sketch2, extrude2, extrude3];
}
