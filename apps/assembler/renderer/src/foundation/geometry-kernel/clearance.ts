/**
 * Clearance between two solids (assembler/CHECKS.md): the exact minimum
 * distance (`BRepExtrema_DistShapeShape`; OCCT reports 0 and
 * `InnerSolution()` when one solid is inside the other) and, for solids
 * that touch, the shared volume (`BRepAlgoAPI_Common` + `BRepGProp`), which
 * tells contact (a shared face or edge, no volume) from overlap.
 *
 * Raw OCCT objects are deleted here; the caller owns the input shapes.
 */
import type { getOC } from 'replicad';

import type { Vec3 } from '../document/document.js';
import type { RawShape } from './occt.js';
import type { ClearanceRelation } from './types.js';

type OpenCascade = ReturnType<typeof getOC>;

/** Bodies closer than this count as touching, mm. */
export const CONTACT_TOLERANCE_MM = 1e-4;
/** A shared volume below this is contact, not overlap, mm³ (OCCT returns faces/edges for touching solids). */
export const OVERLAP_MIN_VOLUME_MM3 = 1e-4;

export interface ClearanceOfShapes {
  distance: number;
  pointA: Vec3;
  pointB: Vec3;
  relation: ClearanceRelation;
  overlapVolume: number | null;
  overlapCenter?: Vec3;
}

interface Pnt {
  X(): number;
  Y(): number;
  Z(): number;
  delete(): void;
}

function point(p: Pnt): Vec3 {
  const out: Vec3 = [p.X(), p.Y(), p.Z()];
  p.delete();
  return out;
}

/** Shared volume of two solids and its centre (`null` volume: the boolean failed). */
export function overlapOf(
  oc: OpenCascade,
  a: RawShape,
  b: RawShape,
): { volume: number | null; center?: Vec3 } {
  const builder = new oc.BRepAlgoAPI_Common();
  const args = new oc.NCollection_List_TopoDS_Shape();
  const tools = new oc.NCollection_List_TopoDS_Shape();
  const props = new oc.GProp_GProps();
  try {
    args.Append(a as never);
    tools.Append(b as never);
    builder.SetArguments(args);
    builder.SetTools(tools);
    // The inputs are the evaluator's cached shapes: never change their tolerances.
    builder.SetNonDestructive(true);
    builder.Build();
    if (builder.HasErrors()) return { volume: null };
    const shape = builder.Shape() as RawShape;
    try {
      oc.BRepGProp.VolumePropertiesGK(shape as never, props, 1e-6, false, true, true, false, false);
      const volume = Math.abs(props.Mass());
      if (volume < OVERLAP_MIN_VOLUME_MM3) return { volume };
      return { volume, center: point(props.CentreOfMass() as unknown as Pnt) };
    } finally {
      shape.delete();
    }
  } finally {
    props.delete();
    args.delete();
    tools.delete();
    builder.delete();
  }
}

/** Distance, closest points and relation of two solids (see the module comment). */
export function clearanceOfShapes(
  oc: OpenCascade,
  a: RawShape,
  b: RawShape,
  options: { overlap?: boolean } = {},
): ClearanceOfShapes {
  const dist = new oc.BRepExtrema_DistShapeShape(a as never, b as never, 1e-7);
  let distance: number;
  let pointA: Vec3;
  let pointB: Vec3;
  let inner: boolean;
  try {
    if (!dist.IsDone() || dist.NbSolution() < 1) {
      throw new Error('The distance could not be computed');
    }
    distance = dist.Value();
    pointA = point(dist.PointOnShape1(1) as unknown as Pnt);
    pointB = point(dist.PointOnShape2(1) as unknown as Pnt);
    inner = dist.InnerSolution();
  } finally {
    dist.delete();
  }
  if (distance > CONTACT_TOLERANCE_MM && !inner) {
    return { distance, pointA, pointB, relation: 'clear', overlapVolume: 0 };
  }
  if (options.overlap === false) {
    // Not asked to tell contact from overlap: a solid inside the other overlaps for sure.
    return {
      distance: 0,
      pointA,
      pointB,
      relation: inner ? 'overlap' : 'contact',
      overlapVolume: null,
    };
  }
  const overlap = overlapOf(oc, a, b);
  const overlapping =
    inner || (overlap.volume !== null && overlap.volume >= OVERLAP_MIN_VOLUME_MM3);
  return {
    distance: 0,
    pointA,
    pointB,
    relation: overlapping ? 'overlap' : 'contact',
    overlapVolume: overlap.volume,
    ...(overlapping && overlap.center ? { overlapCenter: overlap.center } : {}),
  };
}
