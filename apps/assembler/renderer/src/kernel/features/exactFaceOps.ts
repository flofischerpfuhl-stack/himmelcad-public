/**
 * Offset Face, Delete Face and per-wall Shell with OCCT's own algorithms,
 * available only on the HimmelCAD OCCT build (`../occtExtras.ts`):
 *
 * - `BRepOffset_MakeOffset` with `SetOffsetOnFace` (through the
 *   `HimmelcadOffset` facade): the face moves along its normal and its
 *   neighbours are re-extended or trimmed to meet it — no step between a
 *   face and inclined neighbours; per-face thicknesses in one shell.
 * - `BRepAlgoAPI_Defeaturing`: removes faces and lets the neighbours grow
 *   over the gap (any face whose neighbours can be extended, not only holes
 *   and simple blends).
 *
 * Each returns `null` when the build lacks the classes or OCCT does not
 * produce a valid solid of the expected kind, so the caller falls back to
 * the replicad-build emulation (`faceOps.ts`).
 */
import '../occtArena.js';
import * as R from 'replicad';

import { isValidShape, type HistoryResult, type RawShape } from '../occt.js';
import {
  JOIN_ARC,
  JOIN_INTERSECTION,
  OFFSET_MODE_SKIN,
  occtExtras,
  type HimmelcadOffset,
} from '../occtExtras.js';
import type { OpenCascade, Shape3D } from './kit.js';

/** OCCT's tolerance for the offset algorithms (same as the shell of the replicad build). */
const OFFSET_TOLERANCE = 1e-3;

function solidOf(raw: RawShape): Shape3D | null {
  const shape = R.cast(raw as never);
  if (!R.isShape3D(shape)) {
    shape.delete();
    return null;
  }
  return shape;
}

function acceptable(oc: OpenCascade, shape: Shape3D): boolean {
  return R.measureVolume(shape) > 0 && isValidShape(oc, shape);
}

/**
 * `shape` with each face moved by its own distance along its outward normal
 * (positive: out of the material), neighbours extended to meet it.
 */
export function offsetFacesWithHistory(
  oc: OpenCascade,
  shape: Shape3D,
  faces: readonly { face: R.Face; distance: number }[],
): HistoryResult | null {
  const extras = occtExtras(oc);
  if (!extras || faces.length === 0) return null;
  const offset = new extras.HimmelcadOffset();
  let ok = false;
  try {
    offset.Initialize(
      shape.wrapped as RawShape,
      0,
      OFFSET_TOLERANCE,
      OFFSET_MODE_SKIN,
      false,
      false,
      JOIN_INTERSECTION,
      false,
      false,
    );
    for (const { face, distance } of faces) {
      offset.SetOffsetOnFace(face.wrapped as RawShape, distance);
    }
    if (!offset.MakeOffsetShape() || !offset.IsDone()) return null;
    const result = built(oc, offset);
    if (!result) return null;
    const before = R.measureVolume(shape);
    const after = R.measureVolume(result);
    // Every face moved out grows the solid, every face moved in shrinks it.
    const out = faces.every((f) => f.distance > 0);
    const inward = faces.every((f) => f.distance < 0);
    if ((out && !(after > before)) || (inward && !(after < before))) {
      result.delete();
      return null;
    }
    ok = true;
    return { shape: result, history: offset as never };
  } catch {
    return null;
  } finally {
    if (!ok) offset.delete();
  }
}

/**
 * Hollows `shape` like `occt.ts#shellWithHistory`, with `walls` thicker or
 * thinner than `thickness` (`BRepOffset_MakeOffset::SetOffsetOnFace`).
 */
export function shellPerFaceWithHistory(
  oc: OpenCascade,
  shape: Shape3D,
  openFaces: readonly R.Face[],
  thickness: number,
  walls: readonly { face: R.Face; thickness: number }[],
  outward: boolean,
): HistoryResult | null {
  const extras = occtExtras(oc);
  if (!extras) return null;
  const sign = outward ? 1 : -1;
  const offset = new extras.HimmelcadOffset();
  let ok = false;
  try {
    offset.Initialize(
      shape.wrapped as RawShape,
      sign * thickness,
      OFFSET_TOLERANCE,
      OFFSET_MODE_SKIN,
      false,
      false,
      outward ? JOIN_INTERSECTION : JOIN_ARC,
      false,
      false,
    );
    for (const face of openFaces) offset.AddFace(face.wrapped as RawShape);
    for (const wall of walls)
      offset.SetOffsetOnFace(wall.face.wrapped as RawShape, sign * wall.thickness);
    if (!offset.MakeThickSolid() || !offset.IsDone()) return null;
    const result = built(oc, offset);
    if (!result) return null;
    ok = true;
    return { shape: result, history: offset as never };
  } catch {
    return null;
  } finally {
    if (!ok) offset.delete();
  }
}

/** `shape` without `faces`, the neighbours grown over the gaps (`BRepAlgoAPI_Defeaturing`). */
export function defeatureWithHistory(
  oc: OpenCascade,
  shape: Shape3D,
  faces: readonly R.Face[],
): HistoryResult | null {
  const extras = occtExtras(oc);
  if (!extras || faces.length === 0) return null;
  const algo = new extras.BRepAlgoAPI_Defeaturing();
  const range = new oc.Message_ProgressRange();
  let ok = false;
  try {
    algo.SetShape(shape.wrapped as RawShape);
    for (const face of faces) algo.AddFaceToRemove(face.wrapped as RawShape);
    algo.SetRunParallel(false);
    algo.SetToFillHistory(true);
    algo.Build(range);
    if (!algo.IsDone() || algo.HasErrors()) return null;
    // When the gap cannot be closed OCCT may return the input unchanged (with a warning).
    if (!faces.every((face) => algo.IsDeleted(face.wrapped as RawShape))) return null;
    const raw = algo.Shape();
    let result: Shape3D | null;
    try {
      result = solidOf(raw);
    } finally {
      raw.delete();
    }
    if (!result) return null;
    if (!acceptable(oc, result)) {
      result.delete();
      return null;
    }
    ok = true;
    return { shape: result, history: algo as never };
  } catch {
    return null;
  } finally {
    range.delete();
    if (!ok) algo.delete();
  }
}

function built(oc: OpenCascade, offset: HimmelcadOffset): Shape3D | null {
  const raw = offset.Shape();
  let result: Shape3D | null;
  try {
    result = solidOf(raw);
  } finally {
    raw.delete();
  }
  if (result && !acceptable(oc, result)) {
    result.delete();
    return null;
  }
  return result;
}
