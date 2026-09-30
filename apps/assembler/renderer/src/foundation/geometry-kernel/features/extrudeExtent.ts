/**
 * Extrude extents (Shapr3D "Distance / To Object / Through All", one side /
 * symmetric / two sides, start offset): where along the profile normal a
 * prism starts and ends, and — for "To Object" — how the long prism is
 * trimmed at the object. Pure span arithmetic plus two OCCT trims:
 *
 * - a planar target face stops the prism at its (infinite) plane: exact
 *   for parallel planes (a shorter prism), else the long prism is cut by
 *   the half-space beyond the plane (a slanted end);
 * - a body, or a non-planar face (its body), stops the prism at the first
 *   contact: the long prism minus the body, keeping the pieces that touch
 *   the profile.
 */
import '../occtArena.js';
import * as R from 'replicad';

import {
  MIN_FEATURE_SIZE_MM,
  frameForFace,
  framePoint,
  type ExtrudeFeature,
  type Vec3,
} from '../../document/document.js';
import { booleanWithHistory, distanceToShape, solidsOf, type HistoryResult } from '../occt.js';
import type { KeyedFace } from '../naming.js';
import type { FeatureKit, ReplayContextLike, Shape3D } from './kit.js';
import { bodyOrFail } from './refs.js';
import { add, dot, scale, sub } from './rigid.js';

/** Signed interval along the profile normal (profile plane = 0), mm. */
export interface ExtrudeSpan {
  from: number;
  to: number;
}

/** How the long prism of a "To Object" extrude is cut back. */
export type ExtrudeTrim =
  /** Keep the side of the plane the profile is on. */
  | { kind: 'plane'; point: Vec3; normal: Vec3 }
  /** Keep the prism pieces before the first contact with this body. */
  | { kind: 'body'; bodyId: string };

/** Direction of the main side: the sign of `distance` (a zero distance extrudes along the normal). */
export function extrudeSign(feature: Pick<ExtrudeFeature, 'distance'>): 1 | -1 {
  return feature.distance < 0 ? -1 : 1;
}

/** Margin a through-all / to-object prism runs past the geometry it has to reach, mm. */
const REACH_MARGIN_MM = 1;

/**
 * The span of a distance extrude: one side (`distance`), symmetric
 * (`±|distance|`) or two sides (`distance` plus `distance2` the other way),
 * shifted by `startOffset`.
 */
export function distanceSpan(
  feature: Pick<ExtrudeFeature, 'distance' | 'symmetric' | 'distance2' | 'startOffset'>,
): ExtrudeSpan {
  const s = feature.startOffset ?? 0;
  const d = feature.distance;
  if (feature.symmetric) return { from: s - Math.abs(d), to: s + Math.abs(d) };
  const other = feature.distance2 !== undefined && feature.distance2 > 0 ? feature.distance2 : 0;
  const back = -extrudeSign(feature) * other;
  return { from: s + Math.min(0, d, back), to: s + Math.max(0, d, back) };
}

/**
 * The span (and trim) of `feature` for a profile whose plane passes
 * through `origin` with normal `normal`; `outline` are world points of the
 * profile (for "To Object" reach). Fails with a readable message when the
 * extent cannot be reached.
 */
export function resolveExtrudeSpan(
  kit: FeatureKit,
  ctx: ReplayContextLike,
  feature: ExtrudeFeature,
  origin: Vec3,
  normal: Vec3,
  outline: readonly Vec3[],
): { span: ExtrudeSpan; trim: ExtrudeTrim | null } {
  const extent = feature.extent ?? { kind: 'distance' };
  const s = feature.startOffset ?? 0;
  if (!Number.isFinite(s)) kit.fail('Start offset must be a number');
  if (feature.distance2 !== undefined && !(feature.distance2 >= 0)) {
    kit.fail('The second side distance must be zero or positive');
  }
  if (extent.kind === 'distance') {
    if (Math.abs(feature.distance) < MIN_FEATURE_SIZE_MM) {
      kit.fail(`Extrude distance must be at least ${MIN_FEATURE_SIZE_MM} mm in magnitude`);
    }
    return { span: distanceSpan(feature), trim: null };
  }
  const sign = extrudeSign(feature);
  const base = dot(origin, normal);
  // The other side of a two-sided extrude keeps its distance.
  const otherSide =
    !feature.symmetric && feature.distance2 !== undefined && feature.distance2 > 0
      ? feature.distance2
      : 0;
  const withOther = (reach: number): ExtrudeSpan => {
    const main = s + sign * reach;
    const back = s - sign * otherSide;
    return { from: Math.min(s, main, back), to: Math.max(s, main, back) };
  };
  if (extent.kind === 'throughAll') {
    let lo = Infinity;
    let hi = -Infinity;
    for (const body of ctx.bodies.values()) {
      const [min, max] = body.shape.boundingBox.bounds as [Vec3, Vec3];
      for (const corner of boxCorners(min, max)) {
        const t = dot(corner, normal) - base;
        lo = Math.min(lo, t);
        hi = Math.max(hi, t);
      }
    }
    if (!Number.isFinite(lo)) kit.fail('Through All needs a body to extrude through');
    if (feature.symmetric) {
      return {
        span: { from: Math.min(lo, s) - REACH_MARGIN_MM, to: Math.max(hi, s) + REACH_MARGIN_MM },
        trim: null,
      };
    }
    const reach = sign > 0 ? hi - s : s - lo;
    if (!(reach > MIN_FEATURE_SIZE_MM)) {
      kit.fail('Through All: there is no body on this side of the profile; flip the direction');
    }
    return { span: withOther(reach + REACH_MARGIN_MM), trim: null };
  }
  // ---- To Object ----
  if (feature.symmetric) kit.fail('To Object extrudes one side; turn Symmetric off');
  const dir = scale(normal, sign);
  const target = extent.target;
  if (target.kind === 'face') {
    const body = bodyOrFail(kit, ctx, target.face.bodyId);
    const { geom } = kit.resolveFace(body, target.face, ctx.warn);
    if (geom.surface === 'plane' && geom.normal) {
      const m = geom.normal;
      const along = dot(dir, m);
      if (Math.abs(along) < 1e-6)
        kit.fail('To Object: the face is parallel to the extrude direction');
      // Distance (along `dir`) from each profile point, started at the offset, to the plane.
      const reaches = outline.map(
        (p) => dot(sub(geom.centroid, add(p, scale(normal, s))), m) / along,
      );
      const nearest = Math.min(...reaches);
      const farthest = Math.max(...reaches);
      if (!(nearest > -1e-6) || !(farthest > MIN_FEATURE_SIZE_MM)) {
        kit.fail('To Object: the face lies behind the profile; flip the direction');
      }
      if (1 - Math.abs(dot(normal, m)) < 1e-9) {
        return { span: withOther(farthest), trim: null };
      }
      return {
        span: withOther(farthest + REACH_MARGIN_MM),
        // Keep the side of the plane the profile starts on.
        trim: { kind: 'plane', point: geom.centroid, normal: along > 0 ? m : scale(m, -1) },
      };
    }
    return {
      span: withOther(bodyReach(kit, body.shape, normal, base, s, sign)),
      trim: {
        kind: 'body',
        bodyId: body.id,
      },
    };
  }
  const body = bodyOrFail(kit, ctx, target.bodyId);
  return {
    span: withOther(bodyReach(kit, body.shape, normal, base, s, sign)),
    trim: { kind: 'body', bodyId: body.id },
  };
}

function bodyReach(
  kit: FeatureKit,
  shape: Shape3D,
  normal: Vec3,
  base: number,
  s: number,
  sign: 1 | -1,
): number {
  const [min, max] = shape.boundingBox.bounds as [Vec3, Vec3];
  const ts = boxCorners(min, max).map((c) => dot(c, normal) - base);
  const reach = sign > 0 ? Math.max(...ts) - s : s - Math.min(...ts);
  if (!(reach > MIN_FEATURE_SIZE_MM)) {
    kit.fail('To Object: the object lies behind the profile; flip the direction');
  }
  return reach + REACH_MARGIN_MM;
}

/**
 * Cuts a "To Object" prism back (see {@link ExtrudeTrim}); `start` is a point
 * on the prism's start cap (a point of the profile), which tells the kept
 * pieces from the ones past the object.
 */
export function trimExtrudeTool(
  kit: FeatureKit,
  ctx: ReplayContextLike,
  featureId: string,
  tool: { shape: Shape3D; faces: KeyedFace[] },
  trim: ExtrudeTrim,
  start: Vec3,
): { shape: Shape3D; faces: KeyedFace[] } {
  let built: HistoryResult;
  let cutter: { shape: Shape3D; faces: readonly KeyedFace[] };
  try {
    if (trim.kind === 'plane') {
      cutter = { shape: halfSpace(kit, tool.shape, trim.point, trim.normal), faces: [] };
    } else {
      const body = bodyOrFail(kit, ctx, trim.bodyId);
      cutter = { shape: body.shape, faces: body.faces };
    }
    built = booleanWithHistory(kit.oc, 'cut', tool.shape, cutter.shape);
  } catch (error) {
    if (kit.isFailure(error)) throw error;
    kit.fail(`To Object failed: ${kit.describeError(error)}`);
  }
  try {
    const inputs: { shape: Shape3D; faces: readonly KeyedFace[]; reversed?: boolean }[] = [
      { shape: tool.shape, faces: tool.faces },
    ];
    if (cutter.faces.length > 0) inputs.push({ ...cutter, reversed: true });
    const faces = kit.nameResult(
      built.shape,
      built.history,
      inputs,
      ctx.featureOrder,
      () => `${featureId}:end:0`,
    );
    const pieces = solidsOf(kit.oc, built.shape);
    const kept = pieces.filter((piece) => distanceToShape(kit.oc, start, piece) < 1e-4);
    if (kept.length === 0) {
      kit.fail('To Object: the profile does not reach the object in this direction');
    }
    if (kept.length === pieces.length) return { shape: built.shape, faces };
    const shape: Shape3D = kept.length === 1 ? kept[0]! : (R.makeCompound(kept) as Shape3D);
    const resultTopology = kit.topologyOf(built.shape);
    const keptFaces = kit.topologyOf(shape).faces.map((face) => {
      const index = resultTopology.faceIndexOf(face.wrapped);
      const keyed = index >= 0 ? faces[index] : undefined;
      if (!keyed) kit.fail('To Object failed: the trimmed extrusion could not be named');
      return keyed;
    });
    return { shape, faces: keptFaces };
  } finally {
    built.history.delete();
  }
}

/** A half-space (large prism) beyond the plane through `point` with outward `normal`, covering `around`. */
function halfSpace(kit: FeatureKit, around: Shape3D, point: Vec3, normal: Vec3): Shape3D {
  const [min, max] = around.boundingBox.bounds as [Vec3, Vec3];
  const centre = scale(add(min, max), 0.5);
  const size = Math.max(10, kit.diagonalOf(around) * 2 + Math.hypot(...sub(centre, point)) * 2);
  const frame = frameForFace(normal, point);
  const onPlane = sub(centre, scale(normal, dot(sub(centre, point), normal)));
  const u = dot(sub(onPlane, frame.origin), frame.u);
  const v = dot(sub(onPlane, frame.origin), frame.v);
  const corners = [
    [-1, -1],
    [1, -1],
    [1, 1],
    [-1, 1],
  ].map(([a, b]) => framePoint(frame, u + a! * size, v + b! * size));
  const base = R.makePolygon(corners);
  const vector = new R.Vector(scale(normal, size * 2));
  const shape = R.basicFaceExtrusion(base, vector);
  vector.delete();
  return shape;
}

function boxCorners(min: Vec3, max: Vec3): Vec3[] {
  const out: Vec3[] = [];
  for (const x of [min[0], max[0]])
    for (const y of [min[1], max[1]]) for (const z of [min[2], max[2]]) out.push([x, y, z]);
  return out;
}
