/**
 * Modelling features beyond sketch/extrude/fillet/shell/boolean: Revolve,
 * Sweep, Loft, Mirror, Pattern, Split, Transform (move/rotate/copy) and
 * Align. Plain, structured-clone-safe data like the rest of `document.ts`;
 * evaluation lives in `kernel/`. Offset Face and Delete Face belong to the
 * direct-edit module, construction planes/axes to the construction module.
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
  PRINT_FEATURE_KINDS,
  PRINT_FEATURE_LABEL,
  printSketchIdsUsedBy,
  type PrintFeature,
} from './printFeatures.js';

// The shared reference types moved to the document (`foundation/document/document.ts`),
// where the kernel reads them; re-exported for the modelling code.
export type { AxisRef, PathRef, PlaneRef, ProfileRef, WorldAxis };
export { extraBodyId, worldAxisVector } from '../../foundation/document/document.js';

/**
 * Helical revolve (Shapr3D's revolve "elevation"): while turning about the
 * axis the profile climbs `pitch` mm along it per turn, for `turns` turns —
 * springs, coils and thread ridges. Right-handed about the axis direction
 * unless `leftHanded`; a negative pitch climbs against the axis direction.
 */
export interface RevolveHelix {
  /** Rise per full turn, mm; its magnitude must exceed the profile's extent along the axis. */
  pitch: Millimeters;
  /** Number of turns, (0, MAX_HELIX_TURNS]; fractions allowed. */
  turns: number;
  leftHanded?: boolean;
}

/** Revolves a profile about an axis; New/Join/Cut like Extrude. */
export interface RevolveFeature extends FeatureBase {
  kind: 'revolve';
  profile: ProfileRef;
  axis: AxisRef;
  /** Degrees, (0, 360]; 360 is a full revolution. Negative turns the other way. Ignored with `helix`. */
  angle: number;
  /** Helical revolve instead of a plain one (optional, additive). */
  helix?: RevolveHelix;
  operation: ExtrudeOperation;
  targetBodyId?: string;
  resultBodyName?: string;
}

/** Most turns of a helical revolve (bounds evaluation cost). */
export const MAX_HELIX_TURNS = 200;

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
  | {
      kind: 'linear';
      direction: AxisRef;
      count: number;
      /** Distance between neighbours, or with `spacingMode: 'total'` from the first to the last. */
      spacing: Millimeters;
      spacingMode?: 'spacing' | 'total';
      /** A second direction (a grid of `count × second.count`), Shapr3D's Pattern 3D. */
      second?: { direction: AxisRef; count: number; spacing: Millimeters };
    }
  | {
      kind: 'circular';
      axis: AxisRef;
      count: number;
      /**
       * Total angle in degrees (360 spreads `count` instances evenly around),
       * or with `angleMode: 'spacing'` the angle between neighbours.
       */
      angle: number;
      angleMode?: 'total' | 'spacing';
      /** Copies keep their orientation (moved along the circle, not turned). */
      uniform?: boolean;
    };

/** Most instances of a two-direction pattern (bounds evaluation cost). */
export const MAX_PATTERN_INSTANCES = 1000;

/** Copies bodies in a linear or circular pattern (independent copies, like Shapr3D's Pattern 3D). */
export interface PatternFeature extends FeatureBase {
  kind: 'pattern';
  bodyIds: string[];
  pattern: PatternDefinition;
}

/**
 * Splits a body into two bodies: by a plane (the part on the plane's
 * positive side becomes new), or with `profile` by a closed sketch profile
 * (or planar face) projected through the body along its normal (the part
 * inside the profile becomes new). With `keepOriginal` the body stays as it
 * was and both parts are new bodies (Shapr3D's Keep Originals).
 */
export interface SplitFeature extends FeatureBase {
  kind: 'split';
  bodyId: string;
  /**
   * More bodies split by the same element in this step (Shapr3D: "one or
   * several bodies"); each must be cut. Absent: `bodyId` only.
   */
  bodyIds?: string[];
  plane: PlaneRef;
  /** Split with this profile instead of `plane`. */
  profile?: ProfileRef;
  keepOriginal?: boolean;
}

/** Every body a Split step cuts, `bodyId` first. */
export function splitBodyIds(feature: Pick<SplitFeature, 'bodyId' | 'bodyIds'>): string[] {
  return [...new Set([feature.bodyId, ...(feature.bodyIds ?? [])])];
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
 * An Align reference (Shapr3D Align: planar, spherical and conical faces,
 * planes and axes, line and circle edges): a face (planar: its plane;
 * cylindrical/conical: its axis; spherical: its centre), an axis (a straight
 * edge, a circular edge's axis through its centre, a sketch line, a
 * construction or world axis) or a plane (a construction or world plane).
 */
export type AlignReference =
  | { kind: 'face'; face: FaceRef }
  | { kind: 'axis'; axis: AxisRef }
  | { kind: 'plane'; plane: PlaneRef };

/**
 * Moves body `bodyId` so a reference of it lands on a target reference:
 * a plane on a plane (opposed, touching, by default; facing the same way
 * with `flip`; `offset` leaves a gap along the target normal), an axis on an
 * axis (coaxial; `flip` turns it end for end; `offset` slides along the
 * target axis), a centre on a centre or onto an axis, an axis through a
 * centre. `center` also brings the reference centres together.
 *
 * Two planar faces are stored as `face`/`target` (as before Block 9); any
 * other pair as `from`/`to` (Block 9, which then win).
 */
export interface AlignFeature extends FeatureBase {
  kind: 'align';
  bodyId: string;
  face?: FaceRef;
  target?: FaceRef;
  /** The moved reference (a face or an edge of `bodyId`); wins over `face`. */
  from?: AlignReference;
  /** The target reference (another body's face or edge, a datum); wins over `target`. */
  to?: AlignReference;
  flip: boolean;
  center: boolean;
  offset: Millimeters;
}

/**
 * Scales bodies about `center` (Shapr3D Scale; print fit tests): uniformly
 * by `factor`, or with `factors` independently along world X, Y and Z
 * (non-uniform; needs the HimmelCAD OCCT build, whose surfaces become NURBS
 * where a similarity cannot carry them). With `copy` the scaled bodies are
 * new bodies and the originals stay.
 */
export interface ScaleFeature extends FeatureBase {
  kind: 'scale';
  bodyIds: string[];
  /** Uniform factor (> 0); ignored when `factors` is set. */
  factor: number;
  /** Source formula of `factor` (document parameters), when set. */
  factorExpression?: string | undefined;
  /** Per-axis factors along world X, Y, Z (each > 0). */
  factors?: Vec3;
  /** The fixed point of the scaling (world). */
  center: Vec3;
  copy: boolean;
}

/** Smallest and largest scale factor (bounds tolerance trouble and evaluation cost). */
export const MIN_SCALE_FACTOR = 0.001;
export const MAX_SCALE_FACTOR = 1000;

/**
 * Point-to-point translation of bodies (Shapr3D Translate): every body
 * moves by `to − from` (the picked start and end points, world); with
 * `copy` the moved bodies are new bodies and the originals stay.
 */
export interface TranslateFeature extends FeatureBase {
  kind: 'translate';
  bodyIds: string[];
  from: Vec3;
  to: Vec3;
  copy: boolean;
}

export type PrimitiveShape = 'box' | 'cylinder' | 'sphere' | 'cone' | 'torus';

export const PRIMITIVE_SHAPES: readonly PrimitiveShape[] = [
  'box',
  'cylinder',
  'sphere',
  'cone',
  'torus',
];

/**
 * A primitive solid standing on a plane (the "Add" menu): its base is
 * centred at `center` (a world point, projected onto the plane) and it
 * grows along the plane's normal (`flip`: to the other side). Sizes per shape — box: `width` (along
 * the plane's u), `depth` (v), `height`; cylinder: `radius`, `height`;
 * cone: `radius` (base), `radius2` (top, 0 = pointed), `height`; sphere:
 * `radius` (resting on the plane); torus: `radius` (ring), `radius2`
 * (tube), lying on the plane. New/Join/Cut like Extrude.
 */
export interface PrimitiveFeature extends FeatureBase {
  kind: 'primitive';
  shape: PrimitiveShape;
  plane: PlaneRef;
  center: Vec3;
  width?: Millimeters;
  depth?: Millimeters;
  height?: Millimeters;
  radius?: Millimeters;
  radius2?: Millimeters;
  /** Grows to the other side of the plane (into the face: a pocket or a hole when cutting). */
  flip?: boolean;
  /** Source formulas of the sizes (document parameters), when set. */
  widthExpression?: string | undefined;
  depthExpression?: string | undefined;
  heightExpression?: string | undefined;
  radiusExpression?: string | undefined;
  operation: ExtrudeOperation;
  targetBodyId?: string;
  resultBodyName?: string;
}

/** The size fields each primitive shape needs (all > 0, except a cone's `radius2` ≥ 0). */
export const PRIMITIVE_SIZE_FIELDS: Record<
  PrimitiveShape,
  readonly ('width' | 'depth' | 'height' | 'radius' | 'radius2')[]
> = {
  box: ['width', 'depth', 'height'],
  cylinder: ['radius', 'height'],
  sphere: ['radius'],
  cone: ['radius', 'radius2', 'height'],
  torus: ['radius', 'radius2'],
};

export const PRIMITIVE_LABEL: Record<PrimitiveShape, string> = {
  box: 'Box',
  cylinder: 'Cylinder',
  sphere: 'Sphere',
  cone: 'Cone',
  torus: 'Torus',
};

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
  | ScaleFeature
  | TranslateFeature
  | PrimitiveFeature
  // Hole, Emboss, Draft, Rib, Thicken (`printFeatures.ts`).
  | PrintFeature;

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
    scale: ScaleFeature;
    translate: TranslateFeature;
    primitive: PrimitiveFeature;
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
  ...PRINT_FEATURE_KINDS,
  'scale',
  'translate',
  'primitive',
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
  ...PRINT_FEATURE_LABEL,
  scale: 'Scale',
  translate: 'Translate',
  primitive: 'Primitive',
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
    case 'split':
      if (feature.profile) addProfile(feature.profile);
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
