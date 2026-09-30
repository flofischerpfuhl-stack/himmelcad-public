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
  AxisRef,
  ExtrudeOperation,
  FaceRef,
  Feature,
  FeatureBase,
  Millimeters,
  PathRef,
  PlaneRef,
  ProfileRef,
  Vec3,
  WorldAxis,
} from '../../foundation/document/document.js';
import {
  CONSTRUCTION_FEATURE_KINDS,
  CONSTRUCTION_FEATURE_LABEL,
  type ConstructionFeature,
} from '../../model/construction.js';
import {
  PRINT_FEATURE_KINDS,
  PRINT_FEATURE_LABEL,
  printSketchIdsUsedBy,
  type PrintFeature,
} from './printFeatures.js';

// The shared reference types moved to the document (`foundation/document/document.ts`),
// where the kernel reads them; re-exported for the modelling code.
export type { AxisRef, PathRef, PlaneRef, ProfileRef, WorldAxis };
export { extraBodyId, worldAxisVector } from '../../foundation/document/document.js';

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

/**
 * Mirrors bodies across a plane (a world plane, a planar face or a
 * construction plane) or, with `axis`, about a line (a half turn about it —
 * the in-plane mirror of a sketch); with `keepOriginal` the mirror images
 * of bodies are new bodies. Sketches (every profile) and planar faces can
 * be mirrored too: each becomes a mirrored sketch whose profiles later
 * steps reference as `{ kind: 'sketch', featureId: mirroredSketchId(...) }`
 * (the originals stay).
 */
export interface MirrorFeature extends FeatureBase {
  kind: 'mirror';
  bodyIds: string[];
  plane: PlaneRef;
  keepOriginal: boolean;
  /** Sketch feature ids to mirror. */
  sketchIds?: string[];
  /** Planar faces to mirror as profiles. */
  faces?: FaceRef[];
  /** Mirror about this line instead of `plane`. */
  axis?: AxisRef;
}

/** Id of the `index`-th mirrored sketch (`sketchIds` first, then `faces`) of a Mirror step. */
export function mirroredSketchId(mirrorId: string, index: number): string {
  return `${mirrorId}:sketch:${index}`;
}

/** The Mirror step and index a mirrored-sketch id stands for, or `null`. */
export function parseMirroredSketchId(id: string): { mirrorId: string; index: number } | null {
  const match = /^(.*):sketch:(\d+)$/.exec(id);
  return match ? { mirrorId: match[1]!, index: Number(match[2]) } : null;
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
/**
 * How Offset Face reads its value (Shapr3D DIR-01): `offset` moves the faces
 * by `distance` along their outward normals; with one face `radius` /
 * `diameter` set a cylindrical face's size and `total` its distance to the
 * parallel `opposite` face — re-measured on every evaluation, so the target
 * holds when earlier steps change the face.
 */
export type OffsetFaceMode = 'offset' | 'radius' | 'diameter' | 'total';

export const OFFSET_FACE_MODES: readonly OffsetFaceMode[] = [
  'offset',
  'radius',
  'diameter',
  'total',
];

export interface OffsetFaceFeature extends FeatureBase {
  kind: 'offsetFace';
  faces: FaceRef[];
  /** The value in `mode`: offset distance (signed), target radius, diameter or total distance. */
  distance: Millimeters;
  /** Absent: `offset`. */
  mode?: OffsetFaceMode;
  /** `total`: the parallel planar face the distance is measured to. */
  opposite?: FaceRef;
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
  | PrintFeature
  // Construction planes and axes (`construction.ts`).
  | ConstructionFeature;

declare module '../../foundation/document/featureKinds.js' {
  interface FeatureKindMap {
    revolve: RevolveFeature;
    sweep: SweepFeature;
    loft: LoftFeature;
    mirror: MirrorFeature;
    pattern: PatternFeature;
    split: SplitFeature;
    transform: TransformFeature;
    rotateAxis: RotateAxisFeature;
    align: AlignFeature;
    offsetFace: OffsetFaceFeature;
    deleteFace: DeleteFaceFeature;
  }
}

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
  ...CONSTRUCTION_FEATURE_KINDS,
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
  ...CONSTRUCTION_FEATURE_LABEL,
};

/** Largest pattern instance count (bounds evaluation cost). */
export const MAX_PATTERN_COUNT = 200;

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
