/**
 * Resolution of the modelling features' references — profiles, axes,
 * planes, paths — against the replay state, with readable
 * `Missing reference: …` errors (never a silent re-bind; see `../naming.ts`).
 */
import type * as R from 'replicad';

import {
  MIN_FEATURE_SIZE_MM,
  frameForPlane,
  framePoint,
  type Vec3,
  worldAxisVector,
  type AxisRef,
  type PlaneRef,
  type ProfileRef,
} from '../../document/document.js';

import { entityMap, pointPos } from '../../sketch-solver/types.js';
import { assignEdgeKeys } from '../naming.js';
import { edgePointAt, takeList, type RawShape } from '../occt.js';
import { rebindRegion } from '../regionRebind.js';
import { regionFace, regionPieceName } from '../sketchGeometry.js';
import type { SketchRegion } from '../../sketch-solver/regions.js';
import type { BodyStateLike, FeatureKit, ReplayContextLike } from './kit.js';
import { cross, dot, normalize, sub } from './rigid.js';

/** One closed planar profile ready for a sweep-type operation. */
export interface ProfileSection {
  face: R.Face;
  /** Position in the reference's profile list (0 for a face profile), used in face names. */
  profileIndex: number;
  /**
   * Boundary edges with the piece they belong to (naming of generated side
   * faces): the sketch entity id (`~k` for several pieces of one entity), or
   * the edge's index among the face's edges for a face profile.
   */
  segments: { edge: R.Edge; segment: string; midpoint: Vec3 }[];
  normal: Vec3;
  center: Vec3;
  /** Sample points of the outline (world). */
  outline: Vec3[];
}

export function bodyOrFail(kit: FeatureKit, ctx: ReplayContextLike, bodyId: string): BodyStateLike {
  const body = ctx.bodies.get(bodyId);
  if (!body) kit.fail(`Missing reference: body "${bodyId}"`);
  return body;
}

/** The closed profiles a {@link ProfileRef} stands for (all profiles of a sketch unless one is picked). */
export function profileSections(
  kit: FeatureKit,
  ctx: ReplayContextLike,
  ref: ProfileRef,
): ProfileSection[] {
  if (ref.kind === 'face') {
    const body = bodyOrFail(kit, ctx, ref.face.bodyId);
    const { face, geom, topology, index } = kit.resolveFace(body, ref.face, ctx.warn);
    if (geom.surface !== 'plane' || !geom.normal) kit.fail('A profile face must be planar');
    const edgeKeys = assignEdgeKeys(
      topology.edgeFaces.map((faces, i) => ({
        faceIndices: faces,
        midpoint: topology.edgeGeoms[i]!.midpoint,
      })),
      body.faces.map((f) => f.key),
    );
    const own = [...(topology.faceEdges[index] ?? [])].sort((a, b) =>
      edgeKeys[a]! < edgeKeys[b]! ? -1 : edgeKeys[a]! > edgeKeys[b]! ? 1 : 0,
    );
    const clone = face.clone();
    const cloneEdges = kit.edgesOf(clone);
    const segments = cloneEdges.map((edge) => {
      const midpoint = edgePointAt(kit.oc, edge, 0.5);
      let best = 0;
      let bestDistance = Infinity;
      own.forEach((e, s) => {
        const d = distance(topology.edgeGeoms[e]!.midpoint, midpoint);
        if (d < bestDistance) {
          bestDistance = d;
          best = s;
        }
      });
      return { edge, segment: String(best), midpoint };
    });
    return [
      {
        face: clone,
        profileIndex: 0,
        segments,
        normal: geom.normal,
        center: geom.centroid,
        outline: sampleEdges(kit, cloneEdges),
      },
    ];
  }
  const sketchFeature = ctx.sketchFeatures.get(ref.featureId);
  const sketch = ctx.sketches.get(ref.featureId);
  const regions = ctx.sketchRegions.get(ref.featureId);
  if (!sketchFeature || !sketch || !regions) {
    kit.fail(`Missing reference: sketch "${ref.featureId}"`);
  }
  if (regions.length === 0) kit.fail(`"${sketchFeature.name}" has no closed profile`);
  // Same rule as Extrude: the listed region keys in order, else every region.
  const keys = ref.regions ?? regions.map((r) => r.key);
  const bound = new Set(keys.filter((key) => regions.some((r) => r.key === key)));
  const pick = (key: string): SketchRegion => {
    const found = regions.find((r) => r.key === key);
    if (found) return found;
    const rebound = rebindRegion(key, regions, bound, sketchFeature);
    if (!rebound) kit.fail(`Missing reference: profile "${key}" of "${sketchFeature.name}"`);
    bound.add(rebound.region.key);
    ctx.warn(rebound.message);
    return rebound.region;
  };
  return keys.map((key, index) => {
    const region = pick(key);
    if (region.area < MIN_FEATURE_SIZE_MM * MIN_FEATURE_SIZE_MM) {
      kit.fail(`Sketch profile is too small (${region.area.toFixed(4)} mm²)`);
    }
    let face: R.Face;
    try {
      face = regionFace(sketch.frame, region);
    } catch (error) {
      kit.fail(`Profile "${key}" could not be built: ${kit.describeError(error)}`);
    }
    const faceEdges = kit.edgesOf(face);
    const segments = faceEdges.map((edge) => {
      const midpoint = edgePointAt(kit.oc, edge, 0.5);
      return { edge, segment: regionPieceName(sketch.frame, region, midpoint), midpoint };
    });
    const evaluated = sketch.profiles.find((p) => p.key === region.key);
    return {
      face,
      profileIndex: index,
      segments,
      normal: sketch.frame.normal,
      center: evaluated?.center ?? framePoint(sketch.frame, region.sample[0], region.sample[1]),
      outline: evaluated?.outline ?? sampleEdges(kit, faceEdges),
    };
  });
}
/** A straight line in space: `point` + t · `dir` (unit). */
export interface Line3 {
  point: Vec3;
  dir: Vec3;
}

export function resolveAxis(kit: FeatureKit, ctx: ReplayContextLike, ref: AxisRef): Line3 {
  if (ref.kind === 'world') {
    return { point: ref.origin ?? [0, 0, 0], dir: worldAxisVector(ref.axis) };
  }
  if (ref.kind === 'construction') {
    const datum = ctx.datums.get(ref.featureId);
    if (datum?.kind !== 'axis') kit.fail(`Missing reference: construction axis "${ref.featureId}"`);
    return { point: datum.frame.origin, dir: datum.frame.normal };
  }
  if (ref.kind === 'edge') {
    const body = bodyOrFail(kit, ctx, ref.edge.bodyId);
    const { topology, indices } = kit.resolveEdges(body, [ref.edge], ctx.warn);
    const index = indices[0]!;
    const geom = topology.edgeGeoms[index]!;
    if (geom.curve === 'line' && geom.direction) {
      return { point: geom.midpoint, dir: normalize(geom.direction) };
    }
    if (geom.curve === 'circle') {
      const adaptor = new kit.oc.BRepAdaptor_Curve(topology.edges[index]!.wrapped);
      const circle = adaptor.Circle();
      const axis = circle.Axis();
      const loc = axis.Location();
      const direction = axis.Direction();
      const line: Line3 = {
        point: [loc.X(), loc.Y(), loc.Z()],
        dir: normalize([direction.X(), direction.Y(), direction.Z()]),
      };
      for (const o of [direction, loc, axis, circle, adaptor]) o.delete();
      return line;
    }
    kit.fail('An axis must be a straight or circular edge');
  }
  const sketchFeature = ctx.sketchFeatures.get(ref.featureId);
  const sketch = ctx.sketches.get(ref.featureId);
  if (!sketchFeature || !sketch) kit.fail(`Missing reference: sketch "${ref.featureId}"`);
  const entities = entityMap(sketchFeature);
  const line = entities.get(ref.entityId);
  if (!line) kit.fail(`Missing reference: line "${ref.entityId}" of "${sketchFeature.name}"`);
  if (line.kind !== 'line') kit.fail('An axis must be a straight sketch line');
  const a = pointPos(entities, line.a);
  const b = pointPos(entities, line.b);
  if (!a || !b) kit.fail(`Missing reference: line "${ref.entityId}" of "${sketchFeature.name}"`);
  const p = framePoint(sketch.frame, a[0], a[1]);
  const q = framePoint(sketch.frame, b[0], b[1]);
  if (distance(p, q) < MIN_FEATURE_SIZE_MM) kit.fail('The axis line is too short');
  return { point: p, dir: normalize(sub(q, p)) };
}
/** A resolved plane: point + unit normal. */
export interface Plane3 {
  point: Vec3;
  normal: Vec3;
}

export function resolvePlane(kit: FeatureKit, ctx: ReplayContextLike, ref: PlaneRef): Plane3 {
  if (ref.kind === 'plane') {
    const frame = frameForPlane(ref.plane, ref.offset);
    return { point: frame.origin, normal: frame.normal };
  }
  if (ref.kind === 'construction') {
    const datum = ctx.datums.get(ref.featureId);
    if (datum?.kind !== 'plane')
      kit.fail(`Missing reference: construction plane "${ref.featureId}"`);
    return { point: datum.center, normal: datum.frame.normal };
  }
  const body = bodyOrFail(kit, ctx, ref.face.bodyId);
  const { geom } = kit.resolveFace(body, ref.face, ctx.warn);
  if (geom.surface !== 'plane' || !geom.normal) kit.fail('The reference face must be planar');
  return { point: geom.centroid, normal: geom.normal };
}

/**
 * Join/cut target: the explicit body, else the most recently changed one
 * (the extrude rule). `null` when the document has no body.
 */
export function pickTarget(
  kit: FeatureKit,
  ctx: ReplayContextLike,
  targetBodyId: string | undefined,
): BodyStateLike | null {
  if (targetBodyId !== undefined) return bodyOrFail(kit, ctx, targetBodyId);
  const last = ctx.order[ctx.order.length - 1];
  return last ? (ctx.bodies.get(last) ?? null) : null;
}

/** Items of an OCCT shape list (deletes the list; delete the items when done). */
export function listShapes(kit: FeatureKit, list: { delete(): void }): RawShape[] {
  return takeList(kit.oc, list);
}

/** A few points along each edge, both ends included (world). */
export function sampleEdges(kit: FeatureKit, edges: readonly R.Edge[], perEdge = 9): Vec3[] {
  const out: Vec3[] = [];
  for (const edge of edges) {
    for (let i = 0; i < perEdge; i += 1) out.push(edgePointAt(kit.oc, edge, i / (perEdge - 1)));
  }
  return out;
}

export function pointOf(p: { x: number; y: number; z: number; delete(): void }): Vec3 {
  const out: Vec3 = [p.x, p.y, p.z];
  p.delete();
  return out;
}

export function distance(a: Vec3, b: Vec3): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}

/** Distance of `p` from the infinite line. */
export function distanceToLine(line: Line3, p: Vec3): number {
  const rel = sub(p, line.point);
  const c = cross(rel, line.dir);
  return Math.hypot(c[0], c[1], c[2]);
}

/** Signed position of `p` along the line. */
export function alongLine(line: Line3, p: Vec3): number {
  return dot(sub(p, line.point), line.dir);
}
