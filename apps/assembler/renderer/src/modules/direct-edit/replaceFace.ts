/**
 * Replace Face (Shapr3D, MOD-23): planar faces of one body are extended or
 * trimmed until they lie on the surface of a replacing face — "especially
 * for fitting extruded end faces to neighbouring geometry". Kernel part of
 * the direct-edit module, registered by `kernel.ts`.
 *
 * Neither OCCT build binds a general face replacement (`LocOpe`/`BRepFeat`
 * replace + healing), so each face takes one of two routes:
 *
 * - **Tilt** (planar replacing face, at most 80° from the face): the face is
 *   offset along its normal (Offset Face) and turned about a line in it
 *   (OCCT's draft, as Move Face's rings) until it lies in the replacing
 *   plane. Its neighbours are trimmed or extended to meet it, whatever their
 *   angle — the true replacement.
 * - **Prism** (a cylindrical replacing face, or when the tilt is refused):
 *   the face's prism along its normal is cut at the replacing surface; the
 *   part before the surface is added, the part of the body beyond it is
 *   removed. The new end face is exact (it lies on the surface); the side
 *   walls run along the face normal, so they continue neighbours that are
 *   perpendicular to the face (an extrusion's end face) and leave a step
 *   at slanted ones.
 *
 * The replaced face keeps its key either way, so a fillet on its edge or a
 * sketch on it still finds it after earlier steps change.
 */
import * as R from '../../foundation/geometry-kernel/features/occtApi.js';

import { frameForFace, framePoint, type Vec3 } from '../../foundation/document/document.js';
import type { FeatureOf } from '../../foundation/document/featureKinds.js';
import {
  assignFaceKeys,
  baseFaceKey,
  type FaceGeom,
} from '../../foundation/geometry-kernel/naming.js';
import { booleanWithHistory, solidsOf } from '../../foundation/geometry-kernel/occt.js';
import { isFatalKernelError } from '../../foundation/geometry-kernel/fatal.js';
import { isKernelTimeout } from '../../foundation/geometry-kernel/timeout.js';
import {
  facesOfOneBody,
  type FaceTool,
} from '../../foundation/geometry-kernel/features/faceOps.js';
import type {
  BodyStateLike,
  FeatureKit,
  ReplayContextLike,
  ResolvedFace,
  Shape3D,
} from '../../foundation/geometry-kernel/features/kit.js';
import { bodyOrFail } from '../../foundation/geometry-kernel/features/refs.js';
import {
  add,
  cross,
  dot,
  length,
  normalize,
  scale,
  sub,
} from '../../foundation/geometry-kernel/features/rigid.js';
import { offsetResolvedFaces } from './faceEdits.js';
import { MAX_FACE_ROTATION, rotateFace } from './moveEdits.js';

type ReplaceFaceFeature = FeatureOf<'replaceFace'>;

/** Moves and turns below these leave the face where it is. */
const NO_MOVE_MM = 1e-6;
const NO_TURN_DEG = 1e-6;

/** The replacing surface, captured before any face moves (the target may be on the same body). */
type TargetSurface =
  | { kind: 'plane'; point: Vec3; normal: Vec3 }
  | { kind: 'cylinder'; point: Vec3; axis: Vec3; radius: number };

function targetSurface(kit: FeatureKit, geom: FaceGeom): TargetSurface {
  if (geom.surface === 'plane' && geom.normal) {
    return { kind: 'plane', point: geom.centroid, normal: geom.normal };
  }
  if (geom.id.type === 'cylinder') {
    return {
      kind: 'cylinder',
      point: geom.id.point,
      axis: normalize(geom.id.axis),
      radius: geom.id.radius,
    };
  }
  kit.fail(`The replacing face must be planar or cylindrical (it is ${geom.surface})`);
}

export function applyReplaceFace(
  feature: ReplaceFaceFeature,
  ctx: ReplayContextLike,
  kit: FeatureKit,
): void {
  const { body, resolved } = facesOfOneBody(kit, ctx, feature.faces);
  const targetBody = bodyOrFail(kit, ctx, feature.target.bodyId);
  const target = kit.resolveFace(targetBody, feature.target, ctx.warn);
  if (targetBody.id === body.id && resolved.some((r) => r.index === target.index)) {
    kit.fail('The replacing face cannot be one of the faces to replace');
  }
  const surface = targetSurface(kit, target.geom);
  for (const r of resolved) {
    if (r.geom.surface !== 'plane' || !r.geom.normal) {
      kit.fail('Only planar faces can be replaced', { bodyId: body.id, faceKeys: [r.geom.key] });
    }
  }
  // One face after the other; each is found again by its key (earlier ones moved the edges).
  const keys = resolved.map((r) => baseFaceKey(r.geom.key));
  keys.forEach((key, i) => {
    const r = resolveByKey(kit, body, key);
    if (surface.kind === 'plane' && tiltOnto(kit, ctx, body, r, surface, feature.id)) return;
    replaceByPrism(kit, ctx, body, r, surface, feature.id, i);
  });
  if (!(R.measureVolume(body.shape) > 1e-9)) kit.fail('Replace Face would remove the whole body');
}

function resolveByKey(kit: FeatureKit, body: BodyStateLike, key: string): ResolvedFace {
  const index = body.faces.findIndex((f) => baseFaceKey(f.key) === key);
  if (index < 0) kit.fail('Replace Face failed: a face to replace could not be found again');
  const topology = kit.topologyOf(body.shape);
  return { face: topology.faces[index]!, geom: body.faces[index]!, topology, index };
}

// ---- tilt route ----------------------------------------------------------------------------

/**
 * Offsets and turns planar face `r` into `plane` (neighbours follow).
 * `false` (body unchanged) when the turn is too steep or OCCT refuses it.
 */
function tiltOnto(
  kit: FeatureKit,
  ctx: ReplayContextLike,
  body: BodyStateLike,
  r: ResolvedFace,
  plane: Extract<TargetSurface, { kind: 'plane' }>,
  featureId: string,
): boolean {
  const n = r.geom.normal!;
  const c = r.geom.centroid;
  // The replacing plane's normal, turned to the face's side.
  const m = dot(n, plane.normal) >= 0 ? plane.normal : scale(plane.normal, -1);
  const cos = Math.min(1, dot(n, m));
  if (cos < 1e-6) kit.fail('The replacing face is perpendicular to the face to replace');
  const angle = (Math.acos(cos) * 180) / Math.PI;
  if (angle > MAX_FACE_ROTATION) return false;
  // Along the face normal from its centre to the replacing plane.
  const d = dot(sub(plane.point, c), m) / cos;
  if (Math.abs(d) < NO_MOVE_MM && angle < NO_TURN_DEG) return true;
  const saved = { shape: body.shape, faces: body.faces };
  try {
    if (Math.abs(d) >= NO_MOVE_MM) offsetResolvedFaces(kit, ctx, body, [r], d, featureId);
    if (angle >= NO_TURN_DEG) {
      rotateFace(
        kit,
        ctx,
        body,
        baseFaceKey(r.geom.key),
        { point: c, axis: normalize(cross(n, m)), angle },
        scale(n, d),
        featureId,
      );
    }
    return true;
  } catch (error) {
    if (isKernelTimeout(error) || isFatalKernelError(error)) throw error;
    // The prism route below starts again from the untouched body.
    body.shape = saved.shape;
    body.faces = saved.faces;
    return false;
  }
}

// ---- prism route -------------------------------------------------------------------------------

/**
 * Cuts face `r`'s prism (both ways along its normal) at the replacing
 * surface: adds the part before the surface that rests on the face, removes
 * the part of the body beyond the surface under the face.
 */
function replaceByPrism(
  kit: FeatureKit,
  ctx: ReplayContextLike,
  body: BodyStateLike,
  r: ResolvedFace,
  surface: TargetSurface,
  featureId: string,
  i: number,
): void {
  const n = r.geom.normal!;
  const c = r.geom.centroid;
  const crossing = crossingAlongNormal(kit, c, n, surface);
  const reach = kit.diagonalOf(body.shape) + Math.abs(crossing.s) + 10;
  let addParts: Shape3D[];
  let removeParts: Shape3D[];
  try {
    const beyond = beyondSolid(surface, c, n, crossing, reach);
    const out = prism(r.face, n, 0, reach);
    const inward = prism(r.face, n, -reach, reach);
    // Material lies before the surface: outside `beyond`, or inside it for a cylinder entered from within.
    const before = (shape: Shape3D) =>
      booleanWithHistory(kit.oc, crossing.materialInside ? 'common' : 'cut', shape, beyond.shape);
    const after = (shape: Shape3D) =>
      booleanWithHistory(kit.oc, crossing.materialInside ? 'cut' : 'common', shape, beyond.shape);
    addParts = piecesOnFace(kit, before(out), c, n);
    removeParts = piecesOnFace(kit, after(inward), c, n);
  } catch (error) {
    if (kit.isFailure(error)) throw error;
    kit.fail(`Replace Face failed: ${kit.describeError(error)}`);
  }
  if (addParts.length === 0 && removeParts.length === 0) {
    if (Math.abs(crossing.s) < NO_MOVE_MM) return; // already on the surface
    kit.fail('The replacing face does not reach across the face along its normal', {
      bodyId: body.id,
      faceKeys: [r.geom.key],
    });
  }
  const key = baseFaceKey(r.geom.key);
  const onSurface = (g: FaceGeom) => liesOn(g, surface);
  try {
    addParts.forEach((part, j) => {
      kit.combine(
        body,
        keyedPiece(kit, part, onSurface, key, `${featureId}:add:${i}:${j}`),
        'join',
        featureId,
        ctx.featureOrder,
      );
    });
    removeParts.forEach((part, j) => {
      kit.combine(
        body,
        keyedPiece(kit, part, onSurface, key, `${featureId}:trim:${i}:${j}`),
        'cut',
        featureId,
        ctx.featureOrder,
      );
    });
  } catch (error) {
    if (kit.isFailure(error)) throw error;
    kit.fail(`Replace Face failed: ${kit.describeError(error)}`);
  }
  ctx.touch(body.id);
}

/**
 * Where the line through the face centre `c` along `n` meets the surface
 * (`s`: signed distance along `n`, the crossing nearest to the face) and on
 * which side of the surface the material before that crossing lies.
 */
function crossingAlongNormal(
  kit: FeatureKit,
  c: Vec3,
  n: Vec3,
  surface: TargetSurface,
): { s: number; materialInside: boolean } {
  if (surface.kind === 'plane') {
    const along = dot(n, surface.normal);
    if (Math.abs(along) < 1e-6) {
      kit.fail('The replacing face is perpendicular to the face to replace');
    }
    return { s: dot(sub(surface.point, c), surface.normal) / along, materialInside: false };
  }
  const a = surface.axis;
  const w = sub(c, surface.point);
  const wp = sub(w, scale(a, dot(w, a)));
  const np = sub(n, scale(a, dot(n, a)));
  const A = dot(np, np);
  if (A < 1e-12)
    kit.fail('The face normal runs along the cylinder axis; it never meets the surface');
  const B = 2 * dot(wp, np);
  const C = dot(wp, wp) - surface.radius * surface.radius;
  const disc = B * B - 4 * A * C;
  if (disc < 0) kit.fail('The replacing cylinder does not lie in front of or behind the face');
  const root = Math.sqrt(disc);
  const s1 = (-B - root) / (2 * A);
  const s2 = (-B + root) / (2 * A);
  const s = Math.abs(s1) <= Math.abs(s2) ? s1 : s2;
  // Just before the crossing along `n`: inside the cylinder or not.
  const step = Math.min(0.5, Math.abs(s2 - s1) / 4) || 0.5;
  const probe = sub(add(w, scale(n, s - step)), scale(a, dot(add(w, scale(n, s - step)), a)));
  return { s, materialInside: length(probe) < surface.radius };
}

/** The region beyond the surface: the half-space past the plane, or the solid cylinder. */
function beyondSolid(
  surface: TargetSurface,
  c: Vec3,
  n: Vec3,
  crossing: { s: number },
  reach: number,
): { shape: Shape3D } {
  const size = reach * 2;
  if (surface.kind === 'plane') {
    const normal = dot(n, surface.normal) >= 0 ? surface.normal : scale(surface.normal, -1);
    const hit = add(c, scale(n, crossing.s));
    const frame = frameForFace(normal, hit);
    const corners = [
      [-1, -1],
      [1, -1],
      [1, 1],
      [-1, 1],
    ].map(([u, v]) => framePoint(frame, u! * size, v! * size));
    const vector = new R.Vector(scale(normal, size * 2));
    try {
      return { shape: R.basicFaceExtrusion(R.makePolygon(corners), vector) };
    } finally {
      vector.delete();
    }
  }
  const a = surface.axis;
  const centre = add(surface.point, scale(a, dot(sub(c, surface.point), a)));
  const base = sub(centre, scale(a, size * 2));
  return { shape: R.makeCylinder(surface.radius, size * 4, base, a) };
}

/** The face's prism from `from` to `from + span` along `n`. */
function prism(face: R.Face, n: Vec3, from: number, span: number): Shape3D {
  const start = from === 0 ? face.clone() : face.clone().translate(scale(n, from));
  const vector = new R.Vector(scale(n, span));
  try {
    return R.basicFaceExtrusion(start, vector);
  } finally {
    vector.delete();
  }
}

/** Solids of a boolean result that rest on the face's plane (an area on it, not an edge). */
function piecesOnFace(
  kit: FeatureKit,
  result: { shape: Shape3D; history: { delete(): void } },
  c: Vec3,
  n: Vec3,
): Shape3D[] {
  try {
    return solidsOf(kit.oc, result.shape).filter((piece) => {
      if (!(R.measureVolume(piece) > 1e-9)) return false;
      return kit
        .describeShape(piece)
        .some(
          (g) =>
            g.surface === 'plane' &&
            g.normal !== null &&
            Math.abs(Math.abs(dot(g.normal, n)) - 1) < 1e-9 &&
            Math.abs(dot(sub(g.centroid, c), n)) < 1e-5 &&
            g.area > 1e-9,
        );
    });
  } finally {
    result.history.delete();
  }
}

function liesOn(g: FaceGeom, surface: TargetSurface): boolean {
  if (surface.kind === 'plane') {
    return (
      g.surface === 'plane' &&
      g.normal !== null &&
      Math.abs(Math.abs(dot(g.normal, surface.normal)) - 1) < 1e-9 &&
      Math.abs(dot(sub(g.centroid, surface.point), surface.normal)) < 1e-5
    );
  }
  if (g.id.type !== 'cylinder') return false;
  const id = g.id;
  const w = sub(id.point, surface.point);
  const off = sub(w, scale(surface.axis, dot(w, surface.axis)));
  return (
    Math.abs(Math.abs(dot(normalize(id.axis), surface.axis)) - 1) < 1e-9 &&
    Math.abs(id.radius - surface.radius) < 1e-5 &&
    length(off) < 1e-5
  );
}

/** A piece with keys: its face on the replacing surface takes the replaced face's key. */
function keyedPiece(
  kit: FeatureKit,
  shape: Shape3D,
  onSurface: (g: FaceGeom) => boolean,
  replacedKey: string,
  prefix: string,
): FaceTool {
  const geoms = kit.describeShape(shape);
  let cap = false;
  let side = 0;
  const keys = assignFaceKeys(geoms, [], new Map(), (index) => {
    if (!cap && onSurface(geoms[index]!)) {
      cap = true;
      return replacedKey;
    }
    side += 1;
    return `${prefix}:${side - 1}`;
  });
  return { shape, faces: kit.withKeys(geoms, keys) };
}
