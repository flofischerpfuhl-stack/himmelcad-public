/**
 * Modelling features for printable parts: Hole, Emboss (and engrave),
 * Draft, Rib and Thicken. Plain, structured-clone-safe data like
 * `features.ts`; evaluation lives in `kernel/features/` (`holes.ts`,
 * `emboss.ts`, `draft.ts`, `ribThicken.ts`).
 *
 * Standard metric sizes are **sizes only**: ISO 273 clearance holes, ISO
 * coarse-thread tap-drill diameters, DIN 974-1 counterbores for ISO 4762
 * socket head screws and ISO 15065 countersinks. No thread geometry is
 * modelled; a hole may carry a cosmetic thread label (`thread`), which is
 * metadata for the history card, the agent API and exports only.
 */
import type {
  ExtrudeOperation,
  FaceRef,
  FeatureBase,
  Millimeters,
  PlaneRef,
  ProfileRef,
} from '../foundation/document/document.js';

// ---- Hole ---------------------------------------------------------------------------

/**
 * Where a hole sits on its face: a point in the face's plane frame
 * (`frameForFace(normal, point)`, which depends only on the plane, so an
 * edit that moves the face keeps the position), or a point entity of a
 * sketch (e.g. a circle centre), projected onto the face along its normal.
 */
export type HolePlacement =
  | { kind: 'point'; u: Millimeters; v: Millimeters }
  | { kind: 'sketchPoint'; featureId: string; entityId: string };

export type HoleType = 'simple' | 'counterbore' | 'countersink';

/** Blind depth from the face, or through the whole body. */
export type HoleExtent = { kind: 'blind'; depth: Millimeters } | { kind: 'through' };

/**
 * Drills one or more holes into a planar face (one history step, one cut):
 * simple, counterbored or countersunk, blind or through all.
 */
export interface HoleFeature extends FeatureBase {
  kind: 'hole';
  face: FaceRef;
  placements: HolePlacement[];
  holeType: HoleType;
  diameter: Millimeters;
  /** Source formula for `diameter` over document parameters (`model/parameters.ts`). */
  diameterExpression?: string | undefined;
  extent: HoleExtent;
  /** Counterbore diameter and depth (counterbore holes). */
  counterboreDiameter?: Millimeters;
  counterboreDepth?: Millimeters;
  /** Countersink diameter at the face and included angle in degrees (countersink holes; default 90). */
  countersinkDiameter?: Millimeters;
  countersinkAngle?: number;
  /** Cosmetic thread label such as `"M3"`: metadata only, no thread geometry. */
  thread?: string;
  /** The preset the size came from (`"M3 clearance (normal)"`), for display only. */
  preset?: string;
}

/** One standard metric size row (all diameters in mm). */
export interface MetricHoleSize {
  thread: string;
  /** ISO 273 clearance holes: fine, medium and coarse series. */
  clearanceFine: number;
  clearanceNormal: number;
  clearanceCoarse: number;
  /** Tap-drill diameter for the ISO coarse thread (nominal minus pitch). */
  tapDrill: number;
  /** DIN 974-1 counterbore for an ISO 4762 socket head cap screw; depth = head height + 0.4 mm. */
  counterboreDiameter: number;
  counterboreDepth: number;
  /** ISO 15065 countersink diameter (90 degrees) for a countersunk screw. */
  countersinkDiameter: number;
}

/** Standard metric sizes M2 to M10 (see {@link MetricHoleSize} for the sources). */
export const METRIC_HOLE_SIZES: readonly MetricHoleSize[] = [
  {
    thread: 'M2',
    clearanceFine: 2.2,
    clearanceNormal: 2.4,
    clearanceCoarse: 2.6,
    tapDrill: 1.6,
    counterboreDiameter: 4.3,
    counterboreDepth: 2.4,
    countersinkDiameter: 4.4,
  },
  {
    thread: 'M2.5',
    clearanceFine: 2.7,
    clearanceNormal: 2.9,
    clearanceCoarse: 3.1,
    tapDrill: 2.05,
    counterboreDiameter: 5,
    counterboreDepth: 2.9,
    countersinkDiameter: 5.5,
  },
  {
    thread: 'M3',
    clearanceFine: 3.2,
    clearanceNormal: 3.4,
    clearanceCoarse: 3.6,
    tapDrill: 2.5,
    counterboreDiameter: 6.5,
    counterboreDepth: 3.4,
    countersinkDiameter: 6.3,
  },
  {
    thread: 'M4',
    clearanceFine: 4.3,
    clearanceNormal: 4.5,
    clearanceCoarse: 4.8,
    tapDrill: 3.3,
    counterboreDiameter: 8,
    counterboreDepth: 4.4,
    countersinkDiameter: 9.4,
  },
  {
    thread: 'M5',
    clearanceFine: 5.3,
    clearanceNormal: 5.5,
    clearanceCoarse: 5.8,
    tapDrill: 4.2,
    counterboreDiameter: 10,
    counterboreDepth: 5.4,
    countersinkDiameter: 10.4,
  },
  {
    thread: 'M6',
    clearanceFine: 6.4,
    clearanceNormal: 6.6,
    clearanceCoarse: 7,
    tapDrill: 5,
    counterboreDiameter: 11,
    counterboreDepth: 6.4,
    countersinkDiameter: 12.6,
  },
  {
    thread: 'M8',
    clearanceFine: 8.4,
    clearanceNormal: 9,
    clearanceCoarse: 10,
    tapDrill: 6.8,
    counterboreDiameter: 15,
    counterboreDepth: 8.4,
    countersinkDiameter: 17.3,
  },
  {
    thread: 'M10',
    clearanceFine: 10.5,
    clearanceNormal: 11,
    clearanceCoarse: 12,
    tapDrill: 8.5,
    counterboreDiameter: 18,
    counterboreDepth: 10.4,
    countersinkDiameter: 20,
  },
];

/**
 * Fit allowances for printed holes around a pin or shaft of the nominal
 * diameter (added to the nominal diameter). Starting points for FDM with a
 * 0.4 mm nozzle, where printed holes typically come out 0.1 to 0.2 mm
 * undersize; calibrate per printer and material with a test print.
 */
export const PRINT_FITS = [
  { id: 'press', label: 'Press fit', allowance: 0 },
  { id: 'snug', label: 'Snug fit', allowance: 0.1 },
  { id: 'clearance', label: 'Clearance fit', allowance: 0.2 },
  { id: 'loose', label: 'Loose fit', allowance: 0.4 },
] as const;

export type PrintFitId = (typeof PRINT_FITS)[number]['id'];

/** Printing clearance presets for Offset Face / Shell gaps (mm). */
export const PRINT_CLEARANCES: readonly number[] = [0.1, 0.2, 0.3, 0.4];

export type HolePresetKind = 'clearanceFine' | 'clearanceNormal' | 'clearanceCoarse' | 'tapDrill';

export const HOLE_PRESET_LABEL: Record<HolePresetKind, string> = {
  clearanceFine: 'clearance (close)',
  clearanceNormal: 'clearance (normal)',
  clearanceCoarse: 'clearance (loose)',
  tapDrill: 'tap drill',
};

export type HolePresetParams = Pick<
  HoleFeature,
  | 'diameter'
  | 'counterboreDiameter'
  | 'counterboreDepth'
  | 'countersinkDiameter'
  | 'countersinkAngle'
  | 'preset'
>;

/** Hole parameters of a standard size (`"M3"`) and preset, `null` for an unknown size. */
export function holePreset(
  thread: string,
  preset: HolePresetKind,
  holeType: HoleType,
): HolePresetParams | null {
  const size = METRIC_HOLE_SIZES.find((s) => s.thread === thread);
  if (!size) return null;
  return {
    diameter: size[preset],
    ...(holeType === 'counterbore'
      ? {
          counterboreDiameter: size.counterboreDiameter,
          counterboreDepth: size.counterboreDepth,
        }
      : {}),
    ...(holeType === 'countersink'
      ? { countersinkDiameter: size.countersinkDiameter, countersinkAngle: 90 }
      : {}),
    preset: `${thread} ${HOLE_PRESET_LABEL[preset]}`,
  };
}

/** Hole diameter for a pin of `nominal` mm with a printing fit. */
export function fitDiameter(nominal: number, fit: PrintFitId): number {
  const allowance = PRINT_FITS.find((f) => f.id === fit)?.allowance ?? 0;
  return Math.round((nominal + allowance) * 1000) / 1000;
}

// ---- Emboss / engrave -----------------------------------------------------------------

/**
 * Raises (positive `depth`) or engraves (negative) sketch profiles on a
 * body face. On a planar face the profiles are projected along the face
 * normal (the sketch must be parallel to the face); on a cylindrical face
 * they are **wrapped** around it, keeping their lengths along the surface
 * (the sketch plane must be parallel to the axis; the profiles wrap around
 * the line where the sketch normal through the axis meets the surface).
 */
export interface EmbossFeature extends FeatureBase {
  kind: 'emboss';
  profile: ProfileRef;
  face: FaceRef;
  depth: Millimeters;
}

// ---- Draft ------------------------------------------------------------------------------

/**
 * Tilts planar, cylindrical or conical side faces by `angle` degrees about
 * their intersection with a neutral plane, relative to the pull direction
 * (the neutral plane's normal; `flip` reverses it). Positive angles make the
 * part narrower away from the neutral plane along the pull direction.
 */
export interface DraftFeature extends FeatureBase {
  kind: 'draft';
  faces: FaceRef[];
  /** Neutral plane: a planar face (usually the bottom or top) or a construction plane. */
  neutral: PlaneRef;
  angle: number;
  /** Source formula for `angle` (may resolve negative). */
  angleExpression?: string | undefined;
  flip: boolean;
}

// ---- Rib ----------------------------------------------------------------------------------

/**
 * A rib (web) from open sketch lines: each line is thickened across the
 * sketch plane (`thickness`, symmetric about the plane) and filled towards
 * the body until it meets it (`flip` fills the other side). Joined into the
 * body it touches (`targetBodyId`, default: the last changed body).
 */
export interface RibFeature extends FeatureBase {
  kind: 'rib';
  /** Sketch feature and the line entities that form the rib. */
  sketchId: string;
  entityIds: string[];
  thickness: Millimeters;
  /** Source formula for `thickness`. */
  thicknessExpression?: string | undefined;
  flip: boolean;
  targetBodyId?: string;
}

// ---- Thicken -----------------------------------------------------------------------------

export type ThickenDirection = 'outside' | 'inside' | 'both';

export type ThickenSource =
  | { kind: 'faces'; faces: FaceRef[] }
  | { kind: 'profile'; profile: ProfileRef };

/**
 * Turns faces of a body (or sketch profiles) into a solid of `thickness`:
 * outward along the face normal, inward, or half each way. New body, or
 * join/cut like Extrude.
 */
export interface ThickenFeature extends FeatureBase {
  kind: 'thicken';
  source: ThickenSource;
  thickness: Millimeters;
  /** Source formula for `thickness`. */
  thicknessExpression?: string | undefined;
  direction: ThickenDirection;
  operation: ExtrudeOperation;
  targetBodyId?: string;
  resultBodyName?: string;
}

export type PrintFeature = HoleFeature | EmbossFeature | DraftFeature | RibFeature | ThickenFeature;

declare module '../foundation/document/featureKinds.js' {
  interface FeatureKindMap {
    hole: HoleFeature;
    emboss: EmbossFeature;
    draft: DraftFeature;
    rib: RibFeature;
    thicken: ThickenFeature;
  }
}

export const PRINT_FEATURE_KINDS: readonly PrintFeature['kind'][] = [
  'hole',
  'emboss',
  'draft',
  'rib',
  'thicken',
];

export const PRINT_FEATURE_LABEL: Record<PrintFeature['kind'], string> = {
  hole: 'Hole',
  emboss: 'Emboss',
  draft: 'Draft',
  rib: 'Rib',
  thicken: 'Thicken',
};

/** Degrees; OCCT's draft needs the tilted face to stay well away from the pull direction. */
export const MAX_DRAFT_ANGLE = 45;

/** Largest number of holes in one Hole feature (bounds evaluation cost). */
export const MAX_HOLES = 200;

/** Sketch feature ids a print feature reads (hidden by default once used, like Shapr3D). */
export function printSketchIdsUsedBy(feature: PrintFeature): string[] {
  switch (feature.kind) {
    case 'hole':
      return feature.placements
        .filter(
          (p): p is Extract<HolePlacement, { kind: 'sketchPoint' }> => p.kind === 'sketchPoint',
        )
        .map((p) => p.featureId)
        .filter((id, i, all) => all.indexOf(id) === i);
    case 'emboss':
      return feature.profile.kind === 'sketch' ? [feature.profile.featureId] : [];
    case 'rib':
      return [feature.sketchId];
    case 'thicken':
      return feature.source.kind === 'profile' && feature.source.profile.kind === 'sketch'
        ? [feature.source.profile.featureId]
        : [];
    default:
      return [];
  }
}

/** Display summary of a hole ("3 x Ø3.4 through, counterbore Ø6.5 x 3.4"). */
export function holeSummary(feature: HoleFeature): string {
  const n = feature.placements.length;
  const extent =
    feature.extent.kind === 'through' ? 'through all' : `${fmt(feature.extent.depth)} mm deep`;
  const head =
    feature.holeType === 'counterbore'
      ? `, counterbore Ø${fmt(feature.counterboreDiameter ?? 0)} × ${fmt(feature.counterboreDepth ?? 0)}`
      : feature.holeType === 'countersink'
        ? `, countersink Ø${fmt(feature.countersinkDiameter ?? 0)} ${fmt(feature.countersinkAngle ?? 90)}°`
        : '';
  const thread = feature.thread ? ` (${feature.thread} thread, cosmetic)` : '';
  return `${n} × Ø${fmt(feature.diameter)} ${extent}${head}${thread}`;
}

function fmt(v: number): string {
  return String(Math.round(v * 1000) / 1000);
}
