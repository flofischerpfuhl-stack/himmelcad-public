/**
 * Modelling features beyond sketch/extrude/fillet/shell/boolean: Revolve,
 * Sweep, Loft, Mirror, Pattern, Split, Transform (move/rotate/copy), Align,
 * Offset Face and Delete Face. Plain, structured-clone-safe data like the
 * rest of `document.ts`; evaluation lives in `kernel/features/`.
 *
 * Profiles are read through the same profile-reference abstraction as
 * Extrude ({@link ProfileRef}: a sketch profile or a planar body face), so a
 * new sketch representation only has to keep that reference resolvable.
 */
import type {
  EdgeRef,
  ExtrudeOperation,
  ExtrudeProfileRef,
  FaceRef,
  Feature,
  FeatureBase,
  Millimeters,
  SketchPlaneRef,
  Vec3,
} from './document.js';
import {
  PRINT_FEATURE_KINDS,
  PRINT_FEATURE_LABEL,
  printSketchIdsUsedBy,
  type PrintFeature,
} from './printFeatures.js';

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
  | { kind: 'sketchLine'; featureId: string; entityId: string };

/**
 * Sweep path: a chain of body edges, the closed outer outline of a sketch
 * region (by region key, see `sketch/regions.ts`), or a straight world line.
 */
export type PathRef =
  | { kind: 'edges'; edges: EdgeRef[] }
  | { kind: 'sketch'; featureId: string; region: string }
  | { kind: 'line'; start: Vec3; end: Vec3 };

/** A plane: a construction plane with offset, or a planar body face. */
export type PlaneRef = SketchPlaneRef;

/** Revolves a profile about an axis; New/Join/Cut like Extrude. */
export interface RevolveFeature extends FeatureBase {
  kind: 'revolve';
  profile: ProfileRef;
  axis: AxisRef;
  /** Degrees, (0, 360]; 360 is a full revolution. Negative turns the other way. */
  angle: number;
  operation: ExtrudeOperation;
  targetBodyId?: string;
  resultBodyName?: string;
}

/** Sweeps a profile along a path; New/Join/Cut like Extrude. */
export interface SweepFeature extends FeatureBase {
  kind: 'sweep';
  profile: ProfileRef;
  path: PathRef;
  operation: ExtrudeOperation;
  targetBodyId?: string;
  resultBodyName?: string;
}

/** Lofts through two or more profiles in the given order; New/Join/Cut like Extrude. */
export interface LoftFeature extends FeatureBase {
  kind: 'loft';
  profiles: ProfileRef[];
  /** Straight (ruled) sides between sections instead of a smooth surface. */
  ruled: boolean;
  operation: ExtrudeOperation;
  targetBodyId?: string;
  resultBodyName?: string;
}

/** Mirrors bodies across a plane; with `keepOriginal` the mirror images are new bodies. */
export interface MirrorFeature extends FeatureBase {
  kind: 'mirror';
  bodyIds: string[];
  plane: PlaneRef;
  keepOriginal: boolean;
}

export type PatternDefinition =
  | { kind: 'linear'; direction: AxisRef; count: number; spacing: Millimeters }
  | {
      kind: 'circular';
      axis: AxisRef;
      count: number;
      /** Total angle in degrees; 360 spreads `count` instances evenly around. */
      angle: number;
    };

/** Copies bodies in a linear or circular pattern (independent copies, like Shapr3D's Pattern 3D). */
export interface PatternFeature extends FeatureBase {
  kind: 'pattern';
  bodyIds: string[];
  pattern: PatternDefinition;
}

/** Splits a body by a plane into two bodies (the part on the plane's positive side becomes new). */
export interface SplitFeature extends FeatureBase {
  kind: 'split';
  bodyId: string;
  plane: PlaneRef;
}

/**
 * Rigid transform of a body (the Move/Rotate gizmo): rotate by `rx`, `ry`,
 * `rz` degrees about world X, then Y, then Z through `pivot`, then translate
 * by (`dx`, `dy`, `dz`). With `copy` the result is a new body.
 */
export interface TransformFeature extends FeatureBase {
  kind: 'transform';
  bodyId: string;
  dx: Millimeters;
  dy: Millimeters;
  dz: Millimeters;
  rx: number;
  ry: number;
  rz: number;
  pivot: Vec3;
  copy: boolean;
}

/**
 * Rotates bodies by `angle` degrees about an axis — a straight edge, the
 * axis of a circular edge, a sketch line or a world axis (Shapr3D "Rotate
 * Around Axis"). With `copy` the rotated bodies are new bodies and the
 * originals stay.
 */
export interface RotateAxisFeature extends FeatureBase {
  kind: 'rotateAxis';
  bodyIds: string[];
  axis: AxisRef;
  angle: number;
  copy: boolean;
}

/**
 * Moves body `bodyId` so its planar `face` lies on the plane of `target`
 * (a planar face of another body): opposed (touching) by default,
 * facing the same way with `flip`; `offset` leaves a gap along the target
 * normal; `center` also slides the face centres together.
 */
export interface AlignFeature extends FeatureBase {
  kind: 'align';
  bodyId: string;
  face: FaceRef;
  target: FaceRef;
  flip: boolean;
  center: boolean;
  offset: Millimeters;
}

/**
 * Offsets existing faces of one body along their normals (planar,
 * cylindrical and other smooth faces): positive adds material, negative
 * removes it (e.g. a negative offset on a hole's wall enlarges the hole).
 */
export interface OffsetFaceFeature extends FeatureBase {
  kind: 'offsetFace';
  faces: FaceRef[];
  distance: Millimeters;
}

/** Removes faces (holes, fillets, chamfers) and heals the body. */
export interface DeleteFaceFeature extends FeatureBase {
  kind: 'deleteFace';
  faces: FaceRef[];
}

export type ModelingFeature =
  | RevolveFeature
  | SweepFeature
  | LoftFeature
  | MirrorFeature
  | PatternFeature
  | SplitFeature
  | TransformFeature
  | RotateAxisFeature
  | AlignFeature
  | OffsetFaceFeature
  | DeleteFaceFeature
  // Hole, Emboss, Draft, Rib, Thicken (`printFeatures.ts`).
  | PrintFeature;

export const MODELING_FEATURE_KINDS: readonly ModelingFeature['kind'][] = [
  'revolve',
  'sweep',
  'loft',
  'mirror',
  'pattern',
  'split',
  'transform',
  'rotateAxis',
  'align',
  'offsetFace',
  'deleteFace',
  ...PRINT_FEATURE_KINDS,
];

export function isModelingFeature(feature: Feature): feature is ModelingFeature {
  return (MODELING_FEATURE_KINDS as readonly string[]).includes(feature.kind);
}

/** Display prefix of a feature kind's history cards (`"Revolve 1"`). */
export const MODELING_FEATURE_LABEL: Record<ModelingFeature['kind'], string> = {
  revolve: 'Revolve',
  sweep: 'Sweep',
  loft: 'Loft',
  mirror: 'Mirror',
  pattern: 'Pattern',
  split: 'Split',
  transform: 'Move/Rotate',
  rotateAxis: 'Rotate',
  align: 'Align',
  offsetFace: 'Offset Face',
  deleteFace: 'Delete Face',
  ...PRINT_FEATURE_LABEL,
};

/** Largest pattern instance count (bounds evaluation cost). */
export const MAX_PATTERN_COUNT = 200;

/** Body id of the `index`-th body a feature creates besides `bodyIdFor(featureId)` (copies, split parts). */
export function extraBodyId(featureId: string, index: number): string {
  return `body:${featureId}:${index}`;
}

/** Sketch feature ids a feature reads profiles from (hidden by default once used, like Shapr3D). */
export function sketchIdsUsedBy(feature: ModelingFeature): string[] {
  const out: string[] = [];
  const addProfile = (ref: ProfileRef) => {
    if (ref.kind === 'sketch') out.push(ref.featureId);
  };
  switch (feature.kind) {
    case 'revolve':
      addProfile(feature.profile);
      if (feature.axis.kind === 'sketchLine') out.push(feature.axis.featureId);
      break;
    case 'sweep':
      addProfile(feature.profile);
      if (feature.path.kind === 'sketch') out.push(feature.path.featureId);
      break;
    case 'loft':
      feature.profiles.forEach(addProfile);
      break;
    case 'hole':
    case 'emboss':
    case 'rib':
    case 'thicken':
      out.push(...printSketchIdsUsedBy(feature));
      break;
    default:
      break;
  }
  return out;
}

/** Unit vector of a world axis. */
export function worldAxisVector(axis: WorldAxis): Vec3 {
  return axis === 'X' ? [1, 0, 0] : axis === 'Y' ? [0, 1, 0] : [0, 0, 1];
}
