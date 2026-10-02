/**
 * Whole-body operations: Mirror, Pattern, Split, Transform (the Move/Rotate
 * gizmo, optionally as a copy) and Align. Rigid motions keep every face
 * key (the naming layer transforms the face descriptors along, see
 * `rigid.ts`); copies are new, independent bodies whose faces carry the
 * source keys (a reference is `bodyId` + key, so they stay unambiguous).
 */
import '../../../foundation/geometry-kernel/occtArena.js';
import * as R from '../../../foundation/geometry-kernel/features/occtApi.js';

import {
  bodyIdFor,
  frameForFace,
  framePoint,
  MIN_FEATURE_SIZE_MM,
  type ProfileRef,
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
  MAX_PATTERN_INSTANCES,
  MAX_SCALE_FACTOR,
  MIN_SCALE_FACTOR,
  type AlignFeature,
  type AlignReference,
  type MirrorFeature,
  type PatternFeature,
  type RotateAxisFeature,
  type ScaleFeature,
  type SplitFeature,
  splitBodyIds,
  type TransformFeature,
  type TranslateFeature,
} from '../features.js';
import { assignFaceKeys } from '../../../foundation/geometry-kernel/naming.js';
import { alignRefBodyId } from '../alignRefs.js';
import {
  booleanWithHistory,
  type HistoryResult,
} from '../../../foundation/geometry-kernel/occt.js';
import type {
  BodyStateLike,
  FeatureKit,
  ReplayContextLike,
  Shape3D,
} from '../../../foundation/geometry-kernel/features/kit.js';
import {
  nonUniformScaleUnsupported,
  scaleShape,
  transformShape,
} from '../../../foundation/geometry-kernel/features/occRigid.js';
import {
  bodyOrFail,
  profileSections,
  resolveAxis,
  resolvePlane,
} from '../../../foundation/geometry-kernel/features/refs.js';
import {
  add,
  applyPoint,
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
  /** The motion of instance `k` of a body whose box centre is `centre`. */
  let opsFor: (k: number, centre: Vec3) => RigidOp[];
  /** Second direction of a linear grid: its count and the move of its `j`-th row. */
  let rows: { count: number; vector: (j: number) => Vec3 } | null = null;
  if (pattern.kind === 'linear') {
    const total = pattern.spacingMode === 'total';
    const spacing = total ? pattern.spacing / (pattern.count - 1) : pattern.spacing;
    if (!(Math.abs(spacing) >= MIN_FEATURE_SIZE_MM)) {
      kit.fail(`Pattern spacing must be at least ${MIN_FEATURE_SIZE_MM} mm`);
    }
    const { dir } = resolveAxis(kit, ctx, pattern.direction);
    opsFor = (k) => [{ kind: 'translate', vector: scale(dir, spacing * k) }];
    const second = pattern.second;
    if (second) {
      if (!Number.isInteger(second.count) || second.count < 1 || second.count > MAX_PATTERN_COUNT) {
        kit.fail(
          `The second direction count must be a whole number from 1 to ${MAX_PATTERN_COUNT}`,
        );
      }
      if (pattern.count * second.count > MAX_PATTERN_INSTANCES) {
        kit.fail(`A pattern makes at most ${MAX_PATTERN_INSTANCES} instances`);
      }
      const spacing2 =
        total && second.count > 1 ? second.spacing / (second.count - 1) : second.spacing;
      if (second.count > 1 && !(Math.abs(spacing2) >= MIN_FEATURE_SIZE_MM)) {
        kit.fail(`Pattern spacing must be at least ${MIN_FEATURE_SIZE_MM} mm`);
      }
      const dir2 = resolveAxis(kit, ctx, second.direction).dir;
      if (length(cross(dir, dir2)) < 1e-6) kit.fail('The two pattern directions must differ');
      rows = { count: second.count, vector: (j) => scale(dir2, spacing2 * j) };
    }
  } else {
    if (!(Math.abs(pattern.angle) >= 0.1 && Math.abs(pattern.angle) <= 360)) {
      kit.fail('Pattern angle must be between 0.1° and 360°');
    }
    const axis = resolveAxis(kit, ctx, pattern.axis);
    const full = Math.abs(pattern.angle) >= 360 - 1e-9;
    const step =
      pattern.angleMode === 'spacing'
        ? pattern.angle
        : full
          ? 360 / pattern.count
          : pattern.angle / (pattern.count - 1);
    if (Math.abs(step * (pattern.count - 1)) > 360 + 1e-9) {
      kit.fail('The instances would go round more than once; use a smaller angle or count');
    }
    const turn = (k: number): RigidOp => ({
      kind: 'rotate',
      point: axis.point,
      axis: axis.dir,
      angle: (step * k * Math.PI) / 180,
    });
    opsFor = pattern.uniform
      ? // Uniform: the copy moves to where its box centre turns to, keeping its orientation.
        (k, centre) => [
          { kind: 'translate', vector: sub(applyPoint(opsAffine([turn(k)]), centre), centre) },
        ]
      : (k) => [turn(k)];
  }
  bodies.forEach((body, b) => {
    const [min, max] = kit.boundsOf(body.shape);
    const centre = scale(add(min, max), 0.5);
    for (let j = 0; j < (rows?.count ?? 1); j += 1) {
      for (let k = 0; k < pattern.count; k += 1) {
        if (j === 0 && k === 0) continue;
        const ops = opsFor(k, centre);
        const shift = rows && j > 0 ? rows.vector(j) : null;
        // Row 0 keeps the one-direction ids; further rows get ids of their own.
        const index =
          j === 0
            ? b * MAX_PATTERN_COUNT + k
            : GRID_ID_BASE + (b * MAX_PATTERN_COUNT + j) * MAX_PATTERN_COUNT + k;
        addCopy(
          kit,
          ctx,
          feature.id,
          body,
          shift ? [...ops, { kind: 'translate', vector: shift }] : ops,
          extraBodyId(feature.id, index),
          j === 0 ? `${body.name} (${k + 1})` : `${body.name} (${k + 1}, ${j + 1})`,
        );
      }
    }
  });
}

/** First body-id index of a pattern's second-direction rows (above every one-direction id). */
const GRID_ID_BASE = 1_000_000;

// ---- Split -------------------------------------------------------------------------

export function applySplit(feature: SplitFeature, ctx: ReplayContextLike, kit: FeatureKit): void {
  const ids = splitBodyIds(feature);
  ids.forEach((bodyId, k) => splitOne(feature, ctx, kit, bodyOrFail(kit, ctx, bodyId), k));
}

/**
 * Splits one body of the step (index `k`): the first keeps the ids it always
 * had (`body:<step>` for the positive part, `…:0` for the kept-original
 * negative part); further bodies get `…:<100 + 2k>` and `…:<101 + 2k>`.
 */
function splitOne(
  feature: SplitFeature,
  ctx: ReplayContextLike,
  kit: FeatureKit,
  body: BodyStateLike,
  k: number,
): void {
  const [min, max] = body.shape.boundingBox.bounds as [Vec3, Vec3];
  const centre: Vec3 = scale(add(min, max), 0.5);
  const what = feature.profile ? 'profile' : 'plane';
  let positive: HistoryResult;
  let negative: HistoryResult;
  try {
    const cutter = feature.profile
      ? profileCutter(kit, ctx, feature.profile, body, centre)
      : halfSpace(kit, ctx, feature, body, centre);
    positive = booleanWithHistory(kit.oc, 'common', body.shape, cutter);
    negative = booleanWithHistory(kit.oc, 'cut', body.shape, cutter);
  } catch (error) {
    if (kit.isFailure(error)) throw error;
    kit.fail(`Split failed: ${kit.describeError(error)}`);
  }
  try {
    const tiny = 1e-6 * Math.max(1, R.measureVolume(body.shape));
    if (!(R.measureVolume(positive.shape) > tiny) || !(R.measureVolume(negative.shape) > tiny)) {
      kit.fail(`The ${what} does not cut "${body.name}"`);
    }
    const keyed = (part: HistoryResult) =>
      kit.nameResult(
        part.shape,
        part.history,
        [{ shape: body.shape, faces: body.faces }],
        ctx.featureOrder,
        () => `${feature.id}:cut${k === 0 ? '' : `:${k}`}`,
      );
    const positiveFaces = keyed(positive);
    const negativeFaces = keyed(negative);
    if (feature.keepOriginal) {
      // Keep Originals: the body stays, both parts are new.
      kit.addBody(
        ctx,
        {
          id: extraBodyId(feature.id, k === 0 ? 0 : 101 + 2 * k),
          name: `${body.name} (split 1)`,
          createdBy: feature.id,
          shape: negative.shape,
          faces: negativeFaces,
        },
        body.color,
      );
    } else {
      body.shape = negative.shape;
      body.faces = negativeFaces;
      ctx.touch(body.id);
    }
    kit.addBody(
      ctx,
      {
        id: k === 0 ? bodyIdFor(feature.id) : extraBodyId(feature.id, 100 + 2 * k),
        name: feature.keepOriginal ? `${body.name} (split 2)` : `${body.name} (split)`,
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
/** The half-space on the plane's positive side: a large prism standing on the plane. */
function halfSpace(
  kit: FeatureKit,
  ctx: ReplayContextLike,
  feature: SplitFeature,
  body: BodyStateLike,
  centre: Vec3,
): Shape3D {
  const plane = resolvePlane(kit, ctx, feature.plane);
  const size = Math.max(10, kit.diagonalOf(body.shape) * 2 + length(sub(centre, plane.point)) * 2);
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
  const base = R.makePolygon(corners);
  const vector = new R.Vector(scale(plane.normal, size * 2));
  try {
    return R.basicFaceExtrusion(base, vector);
  } finally {
    vector.delete();
  }
}

/**
 * The profile's prism through the whole body along the profile normal
 * (Shapr3D: the split element is projected through the body and need not
 * touch it); several regions are joined.
 */
function profileCutter(
  kit: FeatureKit,
  ctx: ReplayContextLike,
  profile: ProfileRef,
  body: BodyStateLike,
  centre: Vec3,
): Shape3D {
  const sections = profileSections(kit, ctx, profile);
  let cutter: Shape3D | null = null;
  for (const section of sections) {
    const n = section.normal;
    const reach = kit.diagonalOf(body.shape) + Math.abs(dot(sub(centre, section.center), n)) + 1;
    const start = section.face.clone().translate(scale(n, -reach));
    const vector = new R.Vector(scale(n, reach * 2));
    let prism: Shape3D;
    try {
      prism = R.basicFaceExtrusion(start, vector);
    } finally {
      vector.delete();
    }
    if (!cutter) cutter = prism;
    else {
      const fused = booleanWithHistory(kit.oc, 'fuse', cutter, prism);
      fused.history.delete();
      cutter = fused.shape;
    }
  }
  if (!cutter) kit.fail('The split profile is empty');
  return cutter;
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

// ---- Scale ----------------------------------------------------------------------------

export function applyScale(feature: ScaleFeature, ctx: ReplayContextLike, kit: FeatureKit): void {
  const factors: Vec3 = feature.factors
    ? [...feature.factors]
    : [feature.factor, feature.factor, feature.factor];
  if (!factors.every((f) => Number.isFinite(f) && f >= MIN_SCALE_FACTOR && f <= MAX_SCALE_FACTOR)) {
    kit.fail(`Scale factors must be between ${MIN_SCALE_FACTOR} and ${MAX_SCALE_FACTOR}`);
  }
  if (!feature.center.every(Number.isFinite)) kit.fail('The scale centre must be a point');
  const uniform = factors[0] === factors[1] && factors[1] === factors[2];
  if (!uniform) {
    const reason = nonUniformScaleUnsupported(kit.oc);
    if (reason) kit.fail(reason);
  }
  const bodies = bodiesOf(kit, ctx, feature.bodyIds);
  const identity = factors.every((f) => f === 1);
  bodies.forEach((body, i) => {
    if (identity) {
      if (feature.copy) {
        addCopy(
          kit,
          ctx,
          feature.id,
          body,
          [],
          extraBodyId(feature.id, i),
          `${body.name} (scaled)`,
        );
      }
      return;
    }
    let shape: Shape3D;
    try {
      shape = scaleShape(kit.oc, body.shape, feature.center, factors);
    } catch (error) {
      if (kit.isFailure(error)) throw error;
      kit.fail(`Scale failed: ${kit.describeError(error)}`);
    }
    if (!(R.measureVolume(shape) > 0)) kit.fail('Scale failed: the result is not a closed solid');
    const faces = scaledFaces(kit, ctx, feature.id, body, shape);
    if (feature.copy) {
      kit.addBody(
        ctx,
        {
          id: extraBodyId(feature.id, i),
          name: `${body.name} (scaled)`,
          createdBy: feature.id,
          shape,
          faces,
        },
        body.color,
      );
    } else {
      body.shape = shape;
      body.faces = faces;
      ctx.touch(body.id);
    }
  });
}

/**
 * Keyed faces of a scaled copy: OCCT's transform keeps the topology and
 * its explorer order, so face `i` of the copy is face `i` of the source
 * (it keeps the source's key, like a moved body). A different face count
 * (never expected) falls back to surface identity.
 */
function scaledFaces(
  kit: FeatureKit,
  ctx: ReplayContextLike,
  featureId: string,
  body: BodyStateLike,
  shape: Shape3D,
): BodyStateLike['faces'] {
  const geoms = kit.describeShape(shape);
  if (geoms.length === body.faces.length) {
    return geoms.map((g, i) => ({
      ...g,
      key: body.faces[i]!.key,
      aliases: [...body.faces[i]!.aliases],
    }));
  }
  const keys = assignFaceKeys(geoms, body.faces, ctx.featureOrder, () => `${featureId}:new`);
  return kit.withKeys(geoms, keys);
}

// ---- Translate (point to point) -----------------------------------------------------------

export function applyTranslate(
  feature: TranslateFeature,
  ctx: ReplayContextLike,
  kit: FeatureKit,
): void {
  if (![...feature.from, ...feature.to].every(Number.isFinite)) {
    kit.fail('Translate needs a start and an end point');
  }
  const vector = sub(feature.to, feature.from);
  const ops: RigidOp[] = length(vector) > 0 ? [{ kind: 'translate', vector }] : [];
  bodiesOf(kit, ctx, feature.bodyIds).forEach((body, i) => {
    if (feature.copy) {
      addCopy(kit, ctx, feature.id, body, ops, extraBodyId(feature.id, i), `${body.name} (copy)`);
    } else if (ops.length > 0) {
      moveBody(kit, ctx, feature.id, body, ops);
    }
  });
}

// ---- Align ----------------------------------------------------------------------------

/** What an Align reference stands for: a plane, a line (an axis) or a point (a centre). */
type AlignPrimitive =
  | { type: 'plane'; point: Vec3; normal: Vec3 }
  | { type: 'line'; point: Vec3; dir: Vec3 }
  | { type: 'point'; point: Vec3 };

function alignPrimitive(
  kit: FeatureKit,
  ctx: ReplayContextLike,
  ref: AlignReference,
): AlignPrimitive {
  if (ref.kind === 'axis') {
    const line = resolveAxis(kit, ctx, ref.axis);
    return { type: 'line', point: line.point, dir: line.dir };
  }
  if (ref.kind === 'plane') {
    const plane = resolvePlane(kit, ctx, ref.plane);
    return { type: 'plane', point: plane.point, normal: plane.normal };
  }
  const body = bodyOrFail(kit, ctx, ref.face.bodyId);
  const { face, geom, topology, index } = kit.resolveFace(body, ref.face, ctx.warn);
  if (geom.surface === 'plane' && geom.normal) {
    return { type: 'plane', point: geom.centroid, normal: geom.normal };
  }
  if (geom.id.type === 'cylinder') {
    // The axis, through the face's middle (so "centred" seats a pin halfway into a hole).
    const dir = normalize(geom.id.axis);
    const point = add(geom.id.point, scale(dir, dot(sub(geom.centroid, geom.id.point), dir)));
    return { type: 'line', point, dir };
  }
  if (geom.surface === 'sphere') {
    const adaptor = new kit.oc.BRepAdaptor_Surface(face.wrapped as never, true);
    try {
      const sphere = adaptor.Sphere();
      const loc = sphere.Location();
      const point: Vec3 = [loc.X(), loc.Y(), loc.Z()];
      loc.delete();
      sphere.delete();
      return { type: 'point', point };
    } finally {
      adaptor.delete();
    }
  }
  if (geom.surface === 'cone') {
    // `gp_Cone` is not bound: the axis of one of the cone's circular edges is the cone axis.
    const circle = (topology.faceEdges[index] ?? []).find(
      (e) => topology.edgeGeoms[e]!.curve === 'circle',
    );
    if (circle === undefined)
      kit.fail('Align: this conical face has no round edge to find its axis');
    const edge = topology.edges[circle]!;
    const adaptor = new kit.oc.BRepAdaptor_Curve(edge.wrapped);
    const c = adaptor.Circle();
    const axis = c.Axis();
    const loc = axis.Location();
    const direction = axis.Direction();
    const dir = normalize([direction.X(), direction.Y(), direction.Z()]);
    const origin: Vec3 = [loc.X(), loc.Y(), loc.Z()];
    for (const o of [direction, loc, axis, c, adaptor]) o.delete();
    return {
      type: 'line',
      point: add(origin, scale(dir, dot(sub(geom.centroid, origin), dir))),
      dir,
    };
  }
  kit.fail(
    `Align takes planar, cylindrical, conical or spherical faces (this one is ${geom.surface})`,
  );
}

/** A unit vector perpendicular to `v`. */
function perpendicularTo(v: Vec3): Vec3 {
  const other: Vec3 = Math.abs(v[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
  return normalize(cross(v, other));
}

/** The turn about `pivot` that takes unit `from` to unit `to` (none when they agree). */
function turnOnto(from: Vec3, to: Vec3, pivot: Vec3): RigidOp[] {
  const c = dot(from, to);
  if (c >= 1 - 1e-12) return [];
  let axis = cross(from, to);
  if (length(axis) < 1e-9) axis = perpendicularTo(from); // 180°
  const angle = Math.acos(Math.max(-1, Math.min(1, c)));
  return [{ kind: 'rotate', point: pivot, axis: normalize(axis), angle }];
}

/** `v` without its part along unit `dir`. */
function across(v: Vec3, dir: Vec3): Vec3 {
  return sub(v, scale(dir, dot(v, dir)));
}

export function applyAlign(feature: AlignFeature, ctx: ReplayContextLike, kit: FeatureKit): void {
  const body = bodyOrFail(kit, ctx, feature.bodyId);
  const fromRef: AlignReference | null =
    feature.from ?? (feature.face ? { kind: 'face', face: feature.face } : null);
  const toRef: AlignReference | null =
    feature.to ?? (feature.target ? { kind: 'face', face: feature.target } : null);
  if (!fromRef || !toRef) kit.fail('Align needs a reference on the moved body and a target');
  if (alignRefBodyId(fromRef) !== body.id) {
    kit.fail('The moved reference must be a face or an edge of the moved body');
  }
  if (alignRefBodyId(toRef) === body.id) {
    kit.fail(`Pick the target ${toRef.kind === 'face' ? 'face' : 'edge'} on another body`);
  }
  if (!Number.isFinite(feature.offset)) kit.fail('Align offset must be a number');
  const from = alignPrimitive(kit, ctx, fromRef);
  const to = alignPrimitive(kit, ctx, toRef);
  if (from.type !== 'plane' || to.type !== 'plane') {
    const ops = alignOps(kit, feature, from, to);
    if (ops.length > 0) moveBody(kit, ctx, feature.id, body, ops);
    return;
  }
  const source = { normal: from.normal, centroid: from.point };
  const target = { normal: to.normal, centroid: to.point };
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

/**
 * The motion of an Align whose references are not two planes: axis on axis
 * (coaxial: the smaller turn, `flip` end for end; `offset` along the target
 * axis; `center` also brings the reference centres together), a centre on a
 * centre, a centre onto an axis, an axis through a centre.
 */
function alignOps(
  kit: FeatureKit,
  feature: AlignFeature,
  from: AlignPrimitive,
  to: AlignPrimitive,
): RigidOp[] {
  const ops: RigidOp[] = [];
  const push = (vector: Vec3) => {
    if (length(vector) > 0) ops.push({ kind: 'translate', vector });
  };
  if (from.type === 'line' && to.type === 'line') {
    const same = dot(from.dir, to.dir) >= 0;
    const want = same !== feature.flip ? to.dir : scale(to.dir, -1);
    ops.push(...turnOnto(from.dir, want, from.point));
    const d = sub(to.point, from.point);
    push(add(feature.center ? d : across(d, to.dir), scale(to.dir, feature.offset)));
    return ops;
  }
  if (from.type === 'point' && to.type === 'point') {
    push(sub(to.point, from.point));
    return ops;
  }
  if (from.type === 'point' && to.type === 'line') {
    const d = sub(to.point, from.point);
    push(add(feature.center ? d : across(d, to.dir), scale(to.dir, feature.offset)));
    return ops;
  }
  if (from.type === 'line' && to.type === 'point') {
    const d = sub(to.point, from.point);
    push(feature.center ? d : across(d, from.dir));
    return ops;
  }
  kit.fail(
    'Align a plane to a plane, an axis to an axis, or a centre to a centre or an axis (and back)',
  );
}
