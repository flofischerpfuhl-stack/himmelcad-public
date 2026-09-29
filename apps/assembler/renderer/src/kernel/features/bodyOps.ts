/**
 * Whole-body operations: Mirror, Pattern, Split, Transform (the Move/Rotate
 * gizmo, optionally as a copy) and Align. Rigid motions keep every face
 * key (the naming layer transforms the face descriptors along, see
 * `rigid.ts`); copies are new, independent bodies whose faces carry the
 * source keys (a reference is `bodyId` + key, so they stay unambiguous).
 */
import * as R from 'replicad';

import {
  bodyIdFor,
  frameForFace,
  framePoint,
  MIN_FEATURE_SIZE_MM,
  type Vec3,
} from '../../model/document.js';
import {
  extraBodyId,
  MAX_PATTERN_COUNT,
  type AlignFeature,
  type MirrorFeature,
  type PatternFeature,
  type SplitFeature,
  type TransformFeature,
} from '../../model/features.js';
import { assignFaceKeys } from '../naming.js';
import type { BodyStateLike, FeatureKit, ReplayContextLike, Shape3D } from './kit.js';
import { transformShape } from './occRigid.js';
import { bodyOrFail, resolveAxis, resolvePlane } from './refs.js';
import {
  add,
  cross,
  dot,
  length,
  normalize,
  opsAffine,
  scale,
  sub,
  transformGeom,
  transformOps,
  type RigidOp,
} from './rigid.js';

/** Moves `body` in place by `ops`, keeping its face keys. */
function moveBody(
  kit: FeatureKit,
  ctx: ReplayContextLike,
  featureId: string,
  body: BodyStateLike,
  ops: readonly RigidOp[],
): void {
  const moved = rigidCopy(kit, ctx, featureId, body, ops);
  body.shape = moved.shape;
  body.faces = moved.faces;
  ctx.touch(body.id);
}

/** Shape + keyed faces of `body` after `ops` (the body itself is untouched). */
function rigidCopy(
  kit: FeatureKit,
  ctx: ReplayContextLike,
  featureId: string,
  body: BodyStateLike,
  ops: readonly RigidOp[],
): { shape: Shape3D; faces: BodyStateLike['faces'] } {
  let shape: Shape3D;
  try {
    shape = transformShape(kit.oc, body.shape, ops);
  } catch (error) {
    kit.fail(`Transform failed: ${kit.describeError(error)}`);
  }
  const affine = opsAffine(ops);
  const moved = body.faces.map((f) => transformGeom(f, affine));
  const geoms = shape.faces.map((f) => kit.describeFace(f));
  const keys = assignFaceKeys(geoms, moved, ctx.featureOrder, () => `${featureId}:new`);
  return { shape, faces: kit.withKeys(geoms, keys) };
}

function addCopy(
  kit: FeatureKit,
  ctx: ReplayContextLike,
  featureId: string,
  source: BodyStateLike,
  ops: readonly RigidOp[],
  id: string,
  name: string,
): void {
  const copy = rigidCopy(kit, ctx, featureId, source, ops);
  kit.addBody(ctx, { id, name, createdBy: featureId, ...copy }, source.color);
}

function bodiesOf(
  kit: FeatureKit,
  ctx: ReplayContextLike,
  ids: readonly string[],
): BodyStateLike[] {
  if (ids.length === 0) kit.fail('Select at least one body');
  if (new Set(ids).size !== ids.length) kit.fail('A body is listed twice');
  return ids.map((id) => bodyOrFail(kit, ctx, id));
}

// ---- Mirror ------------------------------------------------------------------------

export function applyMirror(feature: MirrorFeature, ctx: ReplayContextLike, kit: FeatureKit): void {
  const plane = resolvePlane(kit, ctx, feature.plane);
  const ops: RigidOp[] = [{ kind: 'mirror', point: plane.point, normal: plane.normal }];
  bodiesOf(kit, ctx, feature.bodyIds).forEach((body, i) => {
    if (feature.keepOriginal) {
      addCopy(kit, ctx, feature.id, body, ops, extraBodyId(feature.id, i), `${body.name} (mirror)`);
    } else {
      moveBody(kit, ctx, feature.id, body, ops);
    }
  });
}

// ---- Pattern -----------------------------------------------------------------------

export function applyPattern(
  feature: PatternFeature,
  ctx: ReplayContextLike,
  kit: FeatureKit,
): void {
  const { pattern } = feature;
  if (!Number.isInteger(pattern.count) || pattern.count < 2 || pattern.count > MAX_PATTERN_COUNT) {
    kit.fail(`Pattern count must be a whole number from 2 to ${MAX_PATTERN_COUNT}`);
  }
  const bodies = bodiesOf(kit, ctx, feature.bodyIds);
  let opsFor: (k: number) => RigidOp[];
  if (pattern.kind === 'linear') {
    if (!(Math.abs(pattern.spacing) >= MIN_FEATURE_SIZE_MM)) {
      kit.fail(`Pattern spacing must be at least ${MIN_FEATURE_SIZE_MM} mm`);
    }
    const { dir } = resolveAxis(kit, ctx, pattern.direction);
    opsFor = (k) => [{ kind: 'translate', vector: scale(dir, pattern.spacing * k) }];
  } else {
    if (!(Math.abs(pattern.angle) >= 0.1 && Math.abs(pattern.angle) <= 360)) {
      kit.fail('Pattern angle must be between 0.1° and 360°');
    }
    const axis = resolveAxis(kit, ctx, pattern.axis);
    const full = Math.abs(pattern.angle) >= 360 - 1e-9;
    const step = full ? 360 / pattern.count : pattern.angle / (pattern.count - 1);
    opsFor = (k) => [
      { kind: 'rotate', point: axis.point, axis: axis.dir, angle: (step * k * Math.PI) / 180 },
    ];
  }
  bodies.forEach((body, b) => {
    for (let k = 1; k < pattern.count; k += 1) {
      addCopy(
        kit,
        ctx,
        feature.id,
        body,
        opsFor(k),
        extraBodyId(feature.id, b * MAX_PATTERN_COUNT + k),
        `${body.name} (${k + 1})`,
      );
    }
  });
}

// ---- Split -------------------------------------------------------------------------

export function applySplit(feature: SplitFeature, ctx: ReplayContextLike, kit: FeatureKit): void {
  const body = bodyOrFail(kit, ctx, feature.bodyId);
  const plane = resolvePlane(kit, ctx, feature.plane);
  const [min, max] = body.shape.boundingBox.bounds as [Vec3, Vec3];
  const centre: Vec3 = scale(add(min, max), 0.5);
  const size = Math.max(10, kit.diagonalOf(body.shape) * 2 + length(sub(centre, plane.point)) * 2);
  // Half-space on the plane's positive side: a large prism standing on the plane.
  const frame = frameForFace(plane.normal, plane.point);
  const onPlane = sub(centre, scale(plane.normal, dot(sub(centre, plane.point), plane.normal)));
  const uv = {
    u: dot(sub(onPlane, frame.origin), frame.u),
    v: dot(sub(onPlane, frame.origin), frame.v),
  };
  const corners = [
    [-1, -1],
    [1, -1],
    [1, 1],
    [-1, 1],
  ].map(([a, b]) => framePoint(frame, uv.u + a! * size, uv.v + b! * size));
  let positive: Shape3D;
  let negative: Shape3D;
  try {
    const base = R.makePolygon(corners);
    const vector = new R.Vector(scale(plane.normal, size * 2));
    const halfSpace = R.basicFaceExtrusion(base, vector);
    vector.delete();
    positive = body.shape.intersect(halfSpace);
    negative = body.shape.cut(halfSpace);
  } catch (error) {
    kit.fail(`Split failed: ${kit.describeError(error)}`);
  }
  const tiny = 1e-6 * Math.max(1, R.measureVolume(body.shape));
  if (!(R.measureVolume(positive) > tiny) || !(R.measureVolume(negative) > tiny)) {
    kit.fail(`The plane does not cut "${body.name}"`);
  }
  const keyed = (shape: Shape3D) => {
    const geoms = shape.faces.map((f) => kit.describeFace(f));
    const keys = assignFaceKeys(geoms, body.faces, ctx.featureOrder, () => `${feature.id}:cut`);
    return kit.withKeys(geoms, keys);
  };
  const positiveFaces = keyed(positive);
  body.shape = negative;
  body.faces = keyed(negative);
  ctx.touch(body.id);
  kit.addBody(
    ctx,
    {
      id: bodyIdFor(feature.id),
      name: `${body.name} (split)`,
      createdBy: feature.id,
      shape: positive,
      faces: positiveFaces,
    },
    body.color,
  );
}

// ---- Transform (Move/Rotate gizmo) ---------------------------------------------------

export function applyTransform(
  feature: TransformFeature,
  ctx: ReplayContextLike,
  kit: FeatureKit,
): void {
  const values = [
    feature.dx,
    feature.dy,
    feature.dz,
    feature.rx,
    feature.ry,
    feature.rz,
    ...feature.pivot,
  ];
  if (!values.every(Number.isFinite)) kit.fail('Move/Rotate values must be numbers');
  const body = bodyOrFail(kit, ctx, feature.bodyId);
  const ops = transformOps(feature);
  if (feature.copy) {
    addCopy(kit, ctx, feature.id, body, ops, bodyIdFor(feature.id), `${body.name} (copy)`);
  } else if (ops.length > 0) {
    moveBody(kit, ctx, feature.id, body, ops);
  }
}

// ---- Align ----------------------------------------------------------------------------

export function applyAlign(feature: AlignFeature, ctx: ReplayContextLike, kit: FeatureKit): void {
  const body = bodyOrFail(kit, ctx, feature.bodyId);
  if (feature.face.bodyId !== body.id) kit.fail('The moved face must belong to the moved body');
  if (feature.target.bodyId === body.id) kit.fail('Pick the target face on another body');
  const targetBody = bodyOrFail(kit, ctx, feature.target.bodyId);
  const source = kit.resolveFace(body, feature.face, ctx.warn).geom;
  const target = kit.resolveFace(targetBody, feature.target, ctx.warn).geom;
  if (
    !source.normal ||
    source.surface !== 'plane' ||
    !target.normal ||
    target.surface !== 'plane'
  ) {
    kit.fail('Align needs two planar faces');
  }
  if (!Number.isFinite(feature.offset)) kit.fail('Align offset must be a number');
  const want = feature.flip ? target.normal : scale(target.normal, -1);
  const ops: RigidOp[] = [];
  const c = dot(source.normal, want);
  if (c < 1 - 1e-12) {
    let axis = cross(source.normal, want);
    if (length(axis) < 1e-9) axis = frameForFace(source.normal, source.centroid).u; // 180°
    const angle = Math.acos(Math.max(-1, Math.min(1, c)));
    ops.push({ kind: 'rotate', point: source.centroid, axis: normalize(axis), angle });
  }
  const destination = feature.center
    ? add(target.centroid, scale(target.normal, feature.offset))
    : add(
        source.centroid,
        scale(
          target.normal,
          dot(sub(target.centroid, source.centroid), target.normal) + feature.offset,
        ),
      );
  const shift = sub(destination, source.centroid);
  if (length(shift) > 0) ops.push({ kind: 'translate', vector: shift });
  if (ops.length > 0) moveBody(kit, ctx, feature.id, body, ops);
}
