/**
 * Construction geometry (Shapr3D "Construct" menu, modelling research §2):
 * construction planes and axes as History steps with references. They
 * make no body; the kernel evaluates them into datums (`EvaluatedDatum`)
 * that later steps reference by feature id — as a sketch plane, a mirror
 * or split plane, a draft neutral plane, a revolve/pattern/rotate axis —
 * and the Section View can cut along a plane.
 *
 * Plain, structured-clone-safe data like the rest of `document.ts`;
 * evaluation lives in `kernel/features/construction.ts`.
 */
import type { EvaluationResult } from '../foundation/geometry-kernel/types.js';
import {
  frameForFace,
  frameForPlane,
  type EdgeRef,
  type FaceRef,
  type FeatureBase,
  type Millimeters,
  type SketchFrame,
  type Vec3,
} from '../foundation/document/document.js';
import type { AxisRef, PlaneRef } from '../foundation/document/document.js';

/**
 * A point in space: a fixed world point, the end of an edge nearest to
 * `near` (the end the user clicked), an edge's midpoint or the centre of a
 * circular edge.
 */
export type PointRef =
  | { kind: 'point'; point: Vec3 }
  | { kind: 'edgeEnd'; edge: EdgeRef; near: Vec3 }
  | { kind: 'edgeMid'; edge: EdgeRef }
  | { kind: 'circleCenter'; edge: EdgeRef };

/**
 * How a construction plane is defined:
 * - `offset`: parallel to a plane or planar face, `distance` along its normal;
 * - `angle`: through a straight edge/axis, turned `angle`° from a plane or face;
 * - `threePoints`: through three points (vertices, midpoints, circle centres);
 * - `midplane`: halfway between two parallel planes/faces;
 * - `tangent`: tangent to a cylindrical face, `angle`° around its axis.
 */
export type ConstructionPlaneDef =
  | { kind: 'offset'; base: PlaneRef; distance: Millimeters }
  | { kind: 'angle'; base: PlaneRef; axis: AxisRef; angle: number }
  | { kind: 'threePoints'; points: PointRef[] }
  | { kind: 'midplane'; a: PlaneRef; b: PlaneRef }
  | { kind: 'tangent'; face: FaceRef; angle: number };

/**
 * How a construction axis is defined: along a straight edge, through two
 * points, the axis of a cylindrical face, or where two planes intersect.
 */
export type ConstructionAxisDef =
  | { kind: 'edge'; edge: EdgeRef }
  | { kind: 'twoPoints'; a: PointRef; b: PointRef }
  | { kind: 'cylinder'; face: FaceRef }
  | { kind: 'planes'; a: PlaneRef; b: PlaneRef };

export interface ConstructionPlaneFeature extends FeatureBase {
  kind: 'constructionPlane';
  definition: ConstructionPlaneDef;
  /** Turns the plane's normal around (sketch side, extrude direction). */
  flip?: boolean;
}

export interface ConstructionAxisFeature extends FeatureBase {
  kind: 'constructionAxis';
  definition: ConstructionAxisDef;
  /** Turns the axis direction around. */
  flip?: boolean;
}

export type ConstructionFeature = ConstructionPlaneFeature | ConstructionAxisFeature;

declare module '../foundation/document/featureKinds.js' {
  interface FeatureKindMap {
    constructionPlane: ConstructionPlaneFeature;
    constructionAxis: ConstructionAxisFeature;
  }
}

export const CONSTRUCTION_FEATURE_KINDS: readonly ConstructionFeature['kind'][] = [
  'constructionPlane',
  'constructionAxis',
];

export const CONSTRUCTION_FEATURE_LABEL: Record<ConstructionFeature['kind'], string> = {
  constructionPlane: 'Plane',
  constructionAxis: 'Axis',
};

export function isConstructionFeatureKind(kind: unknown): kind is ConstructionFeature['kind'] {
  return (CONSTRUCTION_FEATURE_KINDS as readonly unknown[]).includes(kind);
}

/** Readable name of a plane definition ("Offset", "Angle", …) for History cards and Items. */
export const PLANE_DEF_LABEL: Record<ConstructionPlaneDef['kind'], string> = {
  offset: 'Offset',
  angle: 'At angle',
  threePoints: 'Three points',
  midplane: 'Midplane',
  tangent: 'Tangent',
};

export const AXIS_DEF_LABEL: Record<ConstructionAxisDef['kind'], string> = {
  edge: 'Along edge',
  twoPoints: 'Two points',
  cylinder: 'Cylinder axis',
  planes: 'Plane intersection',
};

/**
 * The frame a plane reference stands for, from the evaluation when it has
 * the geometry (a construction plane's datum, a face of an evaluated body),
 * else from the reference's own signature. `null` for a non-planar face.
 */
export function planeRefFrame(
  ref: PlaneRef,
  evaluation?: Pick<EvaluationResult, 'bodies' | 'datums'>,
): SketchFrame | null {
  if (ref.kind === 'plane') return frameForPlane(ref.plane, ref.offset);
  if (ref.kind === 'construction') {
    const datum = evaluation?.datums?.find((d) => d.featureId === ref.featureId);
    return datum?.kind === 'plane' ? datum.frame : ref.frame;
  }
  const face = evaluation?.bodies
    .find((b) => b.id === ref.face.bodyId)
    ?.faces.find((f) => f.key === ref.face.key || f.aliases.includes(ref.face.key));
  const normal = face?.normal ?? ref.face.signature.normal;
  if (!normal) return null;
  return frameForFace(normal, face?.centroid ?? ref.face.signature.centroid);
}

/** A point and normal of a plane reference (`planeRefFrame`), with the datum's drawn centre. */
export function planeRefPlane(
  ref: PlaneRef,
  evaluation?: Pick<EvaluationResult, 'bodies' | 'datums'>,
): { point: Vec3; normal: Vec3 } | null {
  if (ref.kind === 'construction') {
    const datum = evaluation?.datums?.find((d) => d.featureId === ref.featureId);
    if (datum?.kind === 'plane') return { point: datum.center, normal: datum.frame.normal };
    return { point: ref.frame.origin, normal: ref.frame.normal };
  }
  if (ref.kind === 'face') {
    const face = evaluation?.bodies
      .find((b) => b.id === ref.face.bodyId)
      ?.faces.find((f) => f.key === ref.face.key || f.aliases.includes(ref.face.key));
    const normal = face?.normal ?? ref.face.signature.normal;
    if (!normal) return null;
    return { point: face?.centroid ?? ref.face.signature.centroid, normal };
  }
  const frame = frameForPlane(ref.plane, ref.offset);
  return { point: frame.origin, normal: frame.normal };
}

/** A construction axis reference's line: the evaluated datum, else its signature. */
export function constructionAxisLine(
  ref: Extract<AxisRef, { kind: 'construction' }>,
  evaluation?: Pick<EvaluationResult, 'datums'>,
): { point: Vec3; dir: Vec3 } {
  const datum = evaluation?.datums?.find((d) => d.featureId === ref.featureId);
  return datum?.kind === 'axis' ? { point: datum.frame.origin, dir: datum.frame.normal } : ref.line;
}

/** A reference to the evaluated datum `featureId` (plane or axis), or `null` if not evaluated. */
export function datumRef(
  evaluation: Pick<EvaluationResult, 'datums'>,
  featureId: string,
): PlaneRef | AxisRef | null {
  const datum = evaluation.datums?.find((d) => d.featureId === featureId);
  if (!datum) return null;
  return datum.kind === 'plane'
    ? {
        kind: 'construction',
        featureId,
        frame: datum.frame,
        shown: { center: datum.center, size: datum.size },
      }
    : {
        kind: 'construction',
        featureId,
        line: { point: datum.frame.origin, dir: datum.frame.normal },
      };
}

/** Feature ids a construction step references (other construction steps). */
export function constructionDependencies(feature: ConstructionFeature): string[] {
  const out: string[] = [];
  const plane = (ref: PlaneRef) => {
    if (ref.kind === 'construction') out.push(ref.featureId);
  };
  const axis = (ref: AxisRef) => {
    if (ref.kind === 'construction' || ref.kind === 'sketchLine') out.push(ref.featureId);
  };
  const def = feature.definition;
  switch (def.kind) {
    case 'offset':
      plane(def.base);
      break;
    case 'angle':
      plane(def.base);
      axis(def.axis);
      break;
    case 'midplane':
    case 'planes':
      plane(def.a);
      plane(def.b);
      break;
    default:
      break;
  }
  return out;
}
