/**
 * Whole-body operations: Mirror, Pattern, Split, Transform (the Move/Rotate
 * gizmo, optionally as a copy) and Align. Rigid motions keep every face
 * key (the naming layer transforms the face descriptors along, see
 * `rigid.ts`); copies are new, independent bodies whose faces carry the
 * source keys (a reference is `bodyId` + key, so they stay unambiguous).
 */
import '../../../foundation/geometry-kernel/occtArena.js';
import * as R from 'replicad';

import {
  bodyIdFor,
  frameForFace,
  framePoint,
  MIN_FEATURE_SIZE_MM,
  type SketchFrame,
  type Vec3,
  extraBodyId,
} from '../../../foundation/document/document.js';
import type { SketchFeature } from '../../../foundation/sketch-solver/sketchFeature.js';
import { addProjection, projectSource } from '../../../foundation/sketch-solver/projection.js';
import { EMPTY_SKETCH } from '../../../foundation/sketch-solver/types.js';
import { evaluateSketchGeometry } from '../../../foundation/geometry-kernel/sketchGeometry.js';
import { sampleEdge } from '../../../foundation/geometry-kernel/sketchProjection.js';
import {
  mirroredSketchId,
  MAX_PATTERN_COUNT,
  type AlignFeature,
  type MirrorFeature,
  type PatternFeature,
  type RotateAxisFeature,
  type SplitFeature,
  type TransformFeature,
} from '../features.js';
import { assignFaceKeys } from '../../../foundation/geometry-kernel/naming.js';
import { booleanWithHistory, type HistoryResult } from '../../../foundation/geometry-kernel/occt.js';
import type {
  BodyStateLike,
  FeatureKit,
  ReplayContextLike,
  Shape3D,
} from '../../../foundation/geometry-kernel/features/kit.js';
import { transformShape } from '../../../foundation/geometry-kernel/features/occRigid.js';
import {
  bodyOrFail,
  resolveAxis,
  resolvePlane,
} from '../../../foundation/geometry-kernel/features/refs.js';
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
} from '../../../foundation/geometry-kernel/features/rigid.js';

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
  if (sameFacesMoved(kit, body.shape, shape)) {
    // Same B-rep under a new location: the moved descriptors are exact, no OCCT query needed.
    const keys = assignFaceKeys(moved, moved, ctx.featureOrder, () => `${featureId}:new`);
    return { shape, faces: kit.withKeys(moved, keys) };
  }
  const geoms = kit.describeShape(shape);
  const matched = assignFaceKeys(geoms, moved, ctx.featureOrder, () => `${featureId}:new`);
  return { shape, faces: kit.withKeys(geoms, matched) };
}

/** `true` when `moved` has the faces of `source` (same B-rep, only relocated) in the same order. */
function sameFacesMoved(kit: FeatureKit, source: Shape3D, moved: Shape3D): boolean {
  const a = kit.topologyOf(source).faces;
  const b = kit.topologyOf(moved).faces;
  return a.length === b.length && a.every((face, i) => face.wrapped.IsPartner(b[i]!.wrapped));
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
  let ops: RigidOp[];
  if (feature.axis) {
    // About a line: a half turn about it (in a sketch plane, the 2D mirror across that line).
    const axis = resolveAxis(kit, ctx, feature.axis);
    ops = [{ kind: 'rotate', point: axis.point, axis: axis.dir, angle: Math.PI }];
  } else {
    const plane = resolvePlane(kit, ctx, feature.plane);
    ops = [{ kind: 'mirror', point: plane.point, normal: plane.normal }];
  }
  const sketchIds = feature.sketchIds ?? [];
  const faces = feature.faces ?? [];
  if (feature.bodyIds.length === 0 && sketchIds.length === 0 && faces.length === 0) {
    kit.fail('Select bodies, sketches or planar faces to mirror');
  }
  if (feature.bodyIds.length > 0) {
    bodiesOf(kit, ctx, feature.bodyIds).forEach((body, i) => {
      if (feature.keepOriginal) {
        addCopy(
          kit,
          ctx,
          feature.id,
          body,
          ops,
          extraBodyId(feature.id, i),
          `${body.name} (mirror)`,
        );
      } else {
        moveBody(kit, ctx, feature.id, body, ops);
      }
    });
  }
  mirrorSketches(kit, ctx, feature, ops);
}

/**
 * Mirrored sketches (`sketchIds`, then planar `faces` as profiles): the
 * source's sketch data in the mirrored frame, registered like a sketch so
 * later steps extrude/revolve its profiles by {@link mirroredSketchId}.
 */
function mirrorSketches(
  kit: FeatureKit,
  ctx: ReplayContextLike,
  feature: MirrorFeature,
  ops: readonly RigidOp[],
): void {
  const affine = opsAffine(ops);
  // The normal is mirrored too (not u × v): extruding the mirrored sketch gives the mirror
  // image of extruding the original.
  const mapFrame = (frame: SketchFrame): SketchFrame => ({
    origin: applyAffine(affine, frame.origin),
    u: mulDir(affine.m, frame.u),
    v: mulDir(affine.m, frame.v),
    normal: mulDir(affine.m, frame.normal),
  });
  const register = (index: number, source: SketchFeature, frame: SketchFrame): void => {
    const id = mirroredSketchId(feature.id, index);
    const mirrored: SketchFeature = {
      ...source,
      id,
      name: `${source.name} (mirror)`,
      plane: { kind: 'construction', featureId: feature.id, frame },
    };
    delete (mirrored as { projections?: unknown }).projections;
    let result: ReturnType<typeof evaluateSketchGeometry>;
    try {
      result = evaluateSketchGeometry(mirrored, frame);
    } catch (error) {
      if (kit.isFailure(error)) throw error;
      kit.fail(`Mirror of "${source.name}" failed: ${kit.describeError(error)}`);
    }
    for (const message of result.warnings) ctx.warn(message);
    ctx.sketches.set(id, result.evaluated);
    ctx.sketchFeatures.set(id, mirrored);
    ctx.sketchRegions.set(id, result.regions);
  };
  const sketchIds = feature.sketchIds ?? [];
  if (new Set(sketchIds).size !== sketchIds.length) kit.fail('A sketch is listed twice');
  sketchIds.forEach((sketchId, i) => {
    const source = ctx.sketchFeatures.get(sketchId);
    const evaluated = ctx.sketches.get(sketchId);
    if (!source || !evaluated) kit.fail(`Missing reference: sketch "${sketchId}"`);
    register(i, source, mapFrame(evaluated.frame));
  });
  (feature.faces ?? []).forEach((ref, j) => {
    const body = bodyOrFail(kit, ctx, ref.bodyId);
    const { geom, topology, index } = kit.resolveFace(body, ref, ctx.warn);
    if (geom.surface !== 'plane' || !geom.normal) {
      kit.fail('Only planar faces can be mirrored (as a profile); mirror the body instead');
    }
    const frame = frameForFace(geom.normal, geom.centroid);
    const samples = (topology.faceEdges[index] ?? []).map((e) =>
      sampleEdge(kit.oc, topology.edges[e]!, topology.edgeGeoms[e]!.curve),
    );
    const added = addProjection(
      EMPTY_SKETCH,
      { kind: 'face', ref },
      projectSource(samples, frame),
      false,
    );
    if (!added) kit.fail('The face outline could not be mirrored');
    const source: SketchFeature = {
      id: `${feature.id}:face:${j}`,
      name: `Face ${j + 1}`,
      suppressed: false,
      kind: 'sketch',
      plane: { kind: 'face', face: ref },
      ...added.sketch,
    };
    register(sketchIds.length + j, source, mapFrame(frame));
  });
}

function mulDir(m: readonly number[], v: Vec3): Vec3 {
  return [
    m[0]! * v[0] + m[1]! * v[1] + m[2]! * v[2],
    m[3]! * v[0] + m[4]! * v[1] + m[5]! * v[2],
    m[6]! * v[0] + m[7]! * v[1] + m[8]! * v[2],
  ];
}

function applyAffine(a: { m: readonly number[]; t: Vec3 }, p: Vec3): Vec3 {
  return add(mulDir(a.m, p), a.t);
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
  let positive: HistoryResult;
  let negative: HistoryResult;
  try {
    const base = R.makePolygon(corners);
    const vector = new R.Vector(scale(plane.normal, size * 2));
    const halfSpace = R.basicFaceExtrusion(base, vector);
    vector.delete();
    positive = booleanWithHistory(kit.oc, 'common', body.shape, halfSpace);
    negative = booleanWithHistory(kit.oc, 'cut', body.shape, halfSpace);
  } catch (error) {
    if (kit.isFailure(error)) throw error;
    kit.fail(`Split failed: ${kit.describeError(error)}`);
  }
  try {
    const tiny = 1e-6 * Math.max(1, R.measureVolume(body.shape));
    if (!(R.measureVolume(positive.shape) > tiny) || !(R.measureVolume(negative.shape) > tiny)) {
      kit.fail(`The plane does not cut "${body.name}"`);
    }
    const keyed = (part: HistoryResult) =>
      kit.nameResult(
        part.shape,
        part.history,
        [{ shape: body.shape, faces: body.faces }],
        ctx.featureOrder,
        () => `${feature.id}:cut`,
      );
    const positiveFaces = keyed(positive);
    const negativeFaces = keyed(negative);
    body.shape = negative.shape;
    body.faces = negativeFaces;
    ctx.touch(body.id);
    kit.addBody(
      ctx,
      {
        id: bodyIdFor(feature.id),
        name: `${body.name} (split)`,
        createdBy: feature.id,
        shape: positive.shape,
        faces: positiveFaces,
      },
      body.color,
    );
  } finally {
    positive.history.delete();
    negative.history.delete();
  }
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

// ---- Rotate Around Axis ----------------------------------------------------------------

export function applyRotateAxis(
  feature: RotateAxisFeature,
  ctx: ReplayContextLike,
  kit: FeatureKit,
): void {
  if (!Number.isFinite(feature.angle) || Math.abs(feature.angle) > 360) {
    kit.fail('Rotation angle must be between -360° and 360°');
  }
  const bodies = bodiesOf(kit, ctx, feature.bodyIds);
  const axis = resolveAxis(kit, ctx, feature.axis);
  const ops: RigidOp[] =
    feature.angle === 0
      ? []
      : [
          {
            kind: 'rotate',
            point: axis.point,
            axis: axis.dir,
            angle: (feature.angle * Math.PI) / 180,
          },
        ];
  bodies.forEach((body, i) => {
    if (feature.copy) {
      addCopy(kit, ctx, feature.id, body, ops, extraBodyId(feature.id, i), `${body.name} (copy)`);
    } else if (ops.length > 0) {
      moveBody(kit, ctx, feature.id, body, ops);
    }
  });
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
