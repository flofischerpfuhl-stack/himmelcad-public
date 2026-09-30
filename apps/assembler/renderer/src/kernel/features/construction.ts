/**
 * Construction planes and axes (`model/construction.ts`): evaluated into
 * datums (`EvaluatedDatum`) other steps reference by feature id. No body is
 * created or changed. Every reference fails with a readable
 * `Missing reference: …` when it no longer resolves (History "Fix…").
 */
import { frameForFace, type SketchFrame, type Vec3 } from '../../foundation/document/document.js';
import type {
  ConstructionAxisFeature,
  ConstructionPlaneFeature,
  PointRef,
} from '../../model/construction.js';
import { edgePointAt } from '../../foundation/geometry-kernel/occt.js';
import type { EvaluatedDatum } from '../../foundation/geometry-kernel/types.js';
import type {
  FeatureKit,
  ReplayContextLike,
} from '../../foundation/geometry-kernel/features/kit.js';
import {
  bodyOrFail,
  resolveAxis,
  resolvePlane,
  type Line3,
  type Plane3,
} from '../../foundation/geometry-kernel/features/refs.js';
import {
  add,
  cross,
  dot,
  length,
  normalize,
  opAffine,
  scale,
  sub,
} from '../../foundation/geometry-kernel/features/rigid.js';

/** Default half size of a drawn plane / half length of an axis without a sized reference, mm. */
const DEFAULT_SIZE_MM = 20;

/** The world point a {@link PointRef} stands for. */
export function resolvePoint(kit: FeatureKit, ctx: ReplayContextLike, ref: PointRef): Vec3 {
  if (ref.kind === 'point') {
    if (!ref.point.every(Number.isFinite)) kit.fail('A point must have finite coordinates');
    return ref.point;
  }
  const body = bodyOrFail(kit, ctx, ref.edge.bodyId);
  const { topology, indices } = kit.resolveEdges(body, [ref.edge], ctx.warn);
  const index = indices[0]!;
  const geom = topology.edgeGeoms[index]!;
  if (ref.kind === 'edgeMid') return geom.midpoint;
  const edge = topology.edges[index]!;
  if (ref.kind === 'circleCenter') {
    if (geom.curve !== 'circle') kit.fail('A centre point needs a circular edge');
    return resolveAxis(kit, ctx, { kind: 'edge', edge: ref.edge }).point;
  }
  const a = edgePointAt(kit.oc, edge, 0);
  const b = edgePointAt(kit.oc, edge, 1);
  return length(sub(a, ref.near)) <= length(sub(b, ref.near)) ? a : b;
}

/** Half size for drawing a datum next to a face (its extent), else the default. */
function faceSize(area: number | undefined): number {
  return area && area > 0 ? Math.max(8, Math.min(200, Math.sqrt(area) * 0.75)) : DEFAULT_SIZE_MM;
}

function planeDatum(
  featureId: string,
  normal: Vec3,
  point: Vec3,
  size: number,
  flip: boolean,
): EvaluatedDatum {
  const n = flip ? scale(normal, -1) : normal;
  const frame: SketchFrame = frameForFace(n, point);
  // Drawn around the reference point (projected onto the plane).
  const center = sub(point, scale(n, dot(sub(point, frame.origin), n)));
  return { featureId, kind: 'plane', frame, center, size };
}

function axisDatum(featureId: string, line: Line3, size: number, flip: boolean): EvaluatedDatum {
  const dir = flip ? scale(line.dir, -1) : line.dir;
  const frame = frameForFace(dir, line.point);
  return {
    featureId,
    kind: 'axis',
    frame: { ...frame, origin: line.point, normal: dir },
    center: line.point,
    size,
  };
}

/** Plane of a reference plus a size hint for drawing (the face's extent). */
function planeWithSize(
  kit: FeatureKit,
  ctx: ReplayContextLike,
  ref: Parameters<typeof resolvePlane>[2],
): Plane3 & { size: number } {
  const plane = resolvePlane(kit, ctx, ref);
  if (ref.kind === 'face') {
    const body = bodyOrFail(kit, ctx, ref.face.bodyId);
    const { geom } = kit.resolveFace(body, ref.face, ctx.warn);
    return { ...plane, size: faceSize(geom.area) };
  }
  if (ref.kind === 'construction') {
    return { ...plane, size: ctx.datums.get(ref.featureId)?.size ?? DEFAULT_SIZE_MM };
  }
  return { ...plane, size: DEFAULT_SIZE_MM * 2 };
}

export function applyConstructionPlane(
  feature: ConstructionPlaneFeature,
  ctx: ReplayContextLike,
  kit: FeatureKit,
): void {
  const def = feature.definition;
  const flip = feature.flip === true;
  let datum: EvaluatedDatum;
  switch (def.kind) {
    case 'offset': {
      if (!Number.isFinite(def.distance)) kit.fail('The offset must be a number');
      const base = planeWithSize(kit, ctx, def.base);
      datum = planeDatum(
        feature.id,
        base.normal,
        add(base.point, scale(base.normal, def.distance)),
        base.size,
        flip,
      );
      break;
    }
    case 'angle': {
      if (!Number.isFinite(def.angle)) kit.fail('The angle must be a number');
      const base = planeWithSize(kit, ctx, def.base);
      const axis = resolveAxis(kit, ctx, def.axis);
      if (Math.abs(dot(axis.dir, base.normal)) > 1e-6) {
        kit.fail('The axis must be parallel to the reference plane');
      }
      const turn = opAffine({
        kind: 'rotate',
        point: [0, 0, 0],
        axis: axis.dir,
        angle: (def.angle * Math.PI) / 180,
      });
      const n = base.normal;
      const normal = normalize([
        turn.m[0]! * n[0] + turn.m[1]! * n[1] + turn.m[2]! * n[2],
        turn.m[3]! * n[0] + turn.m[4]! * n[1] + turn.m[5]! * n[2],
        turn.m[6]! * n[0] + turn.m[7]! * n[1] + turn.m[8]! * n[2],
      ]);
      // Drawn along the axis, next to the reference.
      const onAxis = add(axis.point, scale(axis.dir, dot(sub(base.point, axis.point), axis.dir)));
      datum = planeDatum(feature.id, normal, onAxis, base.size, flip);
      break;
    }
    case 'threePoints': {
      if (def.points.length !== 3) kit.fail('A plane through points needs exactly three points');
      const [a, b, c] = def.points.map((p) => resolvePoint(kit, ctx, p)) as [Vec3, Vec3, Vec3];
      const normalRaw = cross(sub(b, a), sub(c, a));
      if (length(normalRaw) < 1e-9 * Math.max(1, length(sub(b, a)) * length(sub(c, a)))) {
        kit.fail('The three points lie on one line');
      }
      const centre = scale(add(add(a, b), c), 1 / 3);
      const reach = Math.max(
        length(sub(a, centre)),
        length(sub(b, centre)),
        length(sub(c, centre)),
      );
      datum = planeDatum(feature.id, normalize(normalRaw), centre, Math.max(8, reach * 1.25), flip);
      break;
    }
    case 'midplane': {
      const a = planeWithSize(kit, ctx, def.a);
      const b = planeWithSize(kit, ctx, def.b);
      const alignment = dot(a.normal, b.normal);
      if (Math.abs(alignment) < 1 - 1e-6) kit.fail('A midplane needs two parallel planes or faces');
      const gap = dot(sub(b.point, a.point), a.normal);
      if (Math.abs(gap) < 1e-6) kit.fail('The two planes coincide');
      const mid = add(a.point, scale(a.normal, gap / 2));
      // Drawn between the two references' centres.
      const between = scale(add(a.point, b.point), 0.5);
      const onPlane = sub(between, scale(a.normal, dot(sub(between, mid), a.normal)));
      datum = planeDatum(feature.id, a.normal, onPlane, Math.max(a.size, b.size), flip);
      break;
    }
    case 'tangent': {
      if (!Number.isFinite(def.angle)) kit.fail('The angle must be a number');
      const body = bodyOrFail(kit, ctx, def.face.bodyId);
      const { geom } = kit.resolveFace(body, def.face, ctx.warn);
      if (geom.id.type !== 'cylinder') kit.fail('A tangent plane needs a cylindrical face');
      const { axis, point, radius } = geom.id;
      const radial = radialAt(axis, def.angle);
      // On the face's height (its centroid projected onto the axis).
      const along = dot(sub(geom.centroid, point), axis);
      const touch = add(add(point, scale(axis, along)), scale(radial, radius));
      datum = planeDatum(feature.id, radial, touch, faceSize(geom.area), flip);
      break;
    }
  }
  ctx.datums.set(feature.id, datum);
}

/** Unit direction perpendicular to `axis`, `angle`° from the axis frame's u. */
export function radialAt(axis: Vec3, angle: number): Vec3 {
  const frame = frameForFace(axis, [0, 0, 0]);
  const a = (angle * Math.PI) / 180;
  return normalize(add(scale(frame.u, Math.cos(a)), scale(frame.v, Math.sin(a))));
}

export function applyConstructionAxis(
  feature: ConstructionAxisFeature,
  ctx: ReplayContextLike,
  kit: FeatureKit,
): void {
  const def = feature.definition;
  const flip = feature.flip === true;
  let datum: EvaluatedDatum;
  switch (def.kind) {
    case 'edge': {
      const body = bodyOrFail(kit, ctx, def.edge.bodyId);
      const { topology, indices } = kit.resolveEdges(body, [def.edge], ctx.warn);
      const geom = topology.edgeGeoms[indices[0]!]!;
      if (geom.curve !== 'line' || !geom.direction) {
        // A circular edge stands for its axis (like Revolve/Pattern).
        if (geom.curve !== 'circle') kit.fail('An axis needs a straight or circular edge');
        const line = resolveAxis(kit, ctx, { kind: 'edge', edge: def.edge });
        datum = axisDatum(feature.id, line, Math.max(10, (geom.radius ?? 5) * 2), flip);
        break;
      }
      datum = axisDatum(
        feature.id,
        { point: geom.midpoint, dir: normalize(geom.direction) },
        Math.max(10, geom.length * 0.75),
        flip,
      );
      break;
    }
    case 'twoPoints': {
      const a = resolvePoint(kit, ctx, def.a);
      const b = resolvePoint(kit, ctx, def.b);
      const d = sub(b, a);
      if (length(d) < 1e-6) kit.fail('The two points coincide');
      datum = axisDatum(
        feature.id,
        { point: scale(add(a, b), 0.5), dir: normalize(d) },
        Math.max(10, length(d) * 0.75),
        flip,
      );
      break;
    }
    case 'cylinder': {
      const body = bodyOrFail(kit, ctx, def.face.bodyId);
      const { geom } = kit.resolveFace(body, def.face, ctx.warn);
      if (geom.id.type !== 'cylinder') kit.fail('A cylinder axis needs a cylindrical face');
      const { axis, point, radius } = geom.id;
      const along = dot(sub(geom.centroid, point), axis);
      const height = geom.area / (2 * Math.PI * Math.max(radius, 1e-6));
      datum = axisDatum(
        feature.id,
        { point: add(point, scale(axis, along)), dir: axis },
        Math.max(10, Math.min(400, height * 0.75 + radius)),
        flip,
      );
      break;
    }
    case 'planes': {
      const a = planeWithSize(kit, ctx, def.a);
      const b = planeWithSize(kit, ctx, def.b);
      const dirRaw = cross(a.normal, b.normal);
      if (length(dirRaw) < 1e-6) kit.fail('The two planes are parallel; they do not intersect');
      const dir = normalize(dirRaw);
      // The point of the line nearest to both references' centres.
      const point = linePoint(a, b, dir, scale(add(a.point, b.point), 0.5));
      datum = axisDatum(feature.id, { point, dir }, Math.max(a.size, b.size), flip);
      break;
    }
  }
  ctx.datums.set(feature.id, datum);
}

/** The point on the intersection line of `a` and `b` (direction `dir`) nearest to `near`. */
function linePoint(a: Plane3, b: Plane3, dir: Vec3, near: Vec3): Vec3 {
  // Solve n_a·x = d_a, n_b·x = d_b, dir·x = dir·near.
  const da = dot(a.normal, a.point);
  const db = dot(b.normal, b.point);
  const dn = dot(dir, near);
  const rows = [a.normal, b.normal, dir];
  const rhs = [da, db, dn];
  const det = dot(rows[0]!, cross(rows[1]!, rows[2]!));
  const c0 = cross(rows[1]!, rows[2]!);
  const c1 = cross(rows[2]!, rows[0]!);
  const c2 = cross(rows[0]!, rows[1]!);
  return scale(add(add(scale(c0, rhs[0]!), scale(c1, rhs[1]!)), scale(c2, rhs[2]!)), 1 / det);
}
