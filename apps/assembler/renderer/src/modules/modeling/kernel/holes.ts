/**
 * Hole: simple, counterbored or countersunk holes on a planar face, blind or
 * through all, several in one feature.
 *
 * Each hole is one revolved tool (`revolution` of its half cross-section
 * about the hole axis, the face's inward normal), starting slightly above
 * the face so no coplanar cap is left; all tools are fused and cut from the
 * body in one boolean. Tool faces are named by role and hole index, and keep
 * those names on the body through the cut's history:
 * `<id>:wall:<i>` (the bore), `:cbore:<i>` / `:cbfloor:<i>` (counterbore wall
 * and floor), `:csink:<i>` (countersink cone), `:floor:<i>` (blind bottom).
 */
import '../../../foundation/geometry-kernel/occtArena.js';
import * as R from '../../../foundation/geometry-kernel/features/occtApi.js';

import {
  MIN_FEATURE_SIZE_MM,
  frameForFace,
  framePoint,
  type Vec3,
} from '../../../foundation/document/document.js';
import { MAX_HOLES, type HoleFeature, type HolePlacement } from '../printFeatures.js';
import { entityMap, pointPos } from '../../../foundation/sketch-solver/types.js';
import {
  assignFaceKeys,
  type FaceGeom,
  type KeyedFace,
} from '../../../foundation/geometry-kernel/naming.js';
import type {
  FeatureKit,
  ReplayContextLike,
  Shape3D,
} from '../../../foundation/geometry-kernel/features/kit.js';
import { bodyOrFail } from '../../../foundation/geometry-kernel/features/refs.js';
import { add, dot, scale, sub } from '../../../foundation/geometry-kernel/features/rigid.js';

interface Tool {
  shape: Shape3D;
  faces: KeyedFace[];
}

/** Half cross-section of a hole in (radius, depth) with depth > 0 into the material. */
interface HoleSection {
  points: [number, number][];
  /** Radii and depths used to name the revolved faces. */
  bore: number;
  counterbore: { radius: number; depth: number } | null;
  countersink: boolean;
  depth: number;
  through: boolean;
}

function fmt(v: number): string {
  return String(Math.round(v * 1000) / 1000);
}

/** Validated cross-section of `feature` (throws readable errors). */
export function holeSection(
  feature: HoleFeature,
  throughDepth: number,
  lead: number,
  fail: (message: string) => never,
): HoleSection {
  const d = feature.diameter;
  if (!(Number.isFinite(d) && d >= MIN_FEATURE_SIZE_MM)) {
    fail(`Hole diameter must be at least ${MIN_FEATURE_SIZE_MM} mm`);
  }
  const r = d / 2;
  const through = feature.extent.kind === 'through';
  const depth = feature.extent.kind === 'through' ? throughDepth : feature.extent.depth;
  if (!(Number.isFinite(depth) && depth >= MIN_FEATURE_SIZE_MM)) {
    fail(`Hole depth must be at least ${MIN_FEATURE_SIZE_MM} mm`);
  }
  const top = -lead;
  if (feature.holeType === 'counterbore') {
    const cd = feature.counterboreDiameter ?? 0;
    const ch = feature.counterboreDepth ?? 0;
    if (!(cd > d + 1e-6)) {
      fail(`Counterbore diameter (${fmt(cd)} mm) must be larger than the hole (${fmt(d)} mm)`);
    }
    if (!(ch >= MIN_FEATURE_SIZE_MM)) {
      fail(`Counterbore depth must be at least ${MIN_FEATURE_SIZE_MM} mm`);
    }
    if (!through && ch >= depth - 1e-6) {
      fail(`Counterbore depth (${fmt(ch)} mm) must be less than the hole depth (${fmt(depth)} mm)`);
    }
    const R0 = cd / 2;
    return {
      points: [
        [0, top],
        [R0, top],
        [R0, ch],
        [r, ch],
        [r, depth],
        [0, depth],
      ],
      bore: r,
      counterbore: { radius: R0, depth: ch },
      countersink: false,
      depth,
      through,
    };
  }
  if (feature.holeType === 'countersink') {
    const cd = feature.countersinkDiameter ?? 0;
    const angle = feature.countersinkAngle ?? 90;
    if (!(angle >= 30 && angle <= 150)) fail('Countersink angle must be between 30° and 150°');
    if (!(cd > d + 1e-6)) {
      fail(`Countersink diameter (${fmt(cd)} mm) must be larger than the hole (${fmt(d)} mm)`);
    }
    const half = ((angle / 2) * Math.PI) / 180;
    const R0 = cd / 2;
    const sinkDepth = (R0 - r) / Math.tan(half);
    if (!through && sinkDepth >= depth - 1e-6) {
      fail(
        `The countersink (${fmt(sinkDepth)} mm deep) must end above the hole bottom (${fmt(depth)} mm)`,
      );
    }
    return {
      points: [
        [0, top],
        [R0 + lead * Math.tan(half), top],
        [r, sinkDepth],
        [r, depth],
        [0, depth],
      ],
      bore: r,
      counterbore: null,
      countersink: true,
      depth,
      through,
    };
  }
  return {
    points: [
      [0, top],
      [r, top],
      [r, depth],
      [0, depth],
    ],
    bore: r,
    counterbore: null,
    countersink: false,
    depth,
    through,
  };
}

/** World centre of one placement on the face plane (`n`, `offset`). */
function placementPoint(
  kit: FeatureKit,
  ctx: ReplayContextLike,
  placement: HolePlacement,
  frame: ReturnType<typeof frameForFace>,
  n: Vec3,
  offset: number,
): Vec3 {
  if (placement.kind === 'point') return framePoint(frame, placement.u, placement.v);
  const sketchFeature = ctx.sketchFeatures.get(placement.featureId);
  const sketch = ctx.sketches.get(placement.featureId);
  if (!sketchFeature || !sketch) kit.fail(`Missing reference: sketch "${placement.featureId}"`);
  const map = entityMap(sketchFeature);
  const entity = map.get(placement.entityId);
  // A circle or arc stands for its centre point.
  const pointId =
    entity?.kind === 'circle' || entity?.kind === 'arc' ? entity.center : placement.entityId;
  const uv = pointPos(map, pointId);
  if (!uv) {
    kit.fail(`Missing reference: point "${placement.entityId}" of "${sketchFeature.name}"`);
  }
  const world = framePoint(sketch.frame, uv[0], uv[1]);
  // Project along the face normal onto the face plane.
  return sub(world, scale(n, dot(n, world) - offset));
}

export function applyHole(feature: HoleFeature, ctx: ReplayContextLike, kit: FeatureKit): void {
  if (feature.placements.length === 0) kit.fail('Place at least one hole');
  if (feature.placements.length > MAX_HOLES) {
    kit.fail(`At most ${MAX_HOLES} holes per Hole feature`);
  }
  const body = bodyOrFail(kit, ctx, feature.face.bodyId);
  const { geom, face } = kit.resolveFace(body, feature.face, ctx.warn);
  if (geom.surface !== 'plane' || !geom.normal) {
    kit.fail('A hole needs a planar face (pick a flat face of the body)');
  }
  const n = geom.normal;
  const offset = dot(n, geom.centroid);
  const frame = frameForFace(n, geom.centroid);
  const diagonal = kit.diagonalOf(body.shape);
  const lead = Math.max(0.05, Math.min(1, diagonal * 1e-3));
  const section = holeSection(feature, diagonal * 1.2 + 1, lead, kit.fail);
  const centres = feature.placements.map((p) => placementPoint(kit, ctx, p, frame, n, offset));
  centres.forEach((c, i) => {
    for (let j = 0; j < i; j += 1) {
      if (Math.hypot(...sub(c, centres[j]!)) < 1e-6) {
        kit.fail(`Holes ${j + 1} and ${i + 1} are at the same position`);
      }
    }
  });

  const into = scale(n, -1);
  const radial = frame.u;
  const tools = centres.map((centre, i) =>
    holeTool(kit, feature.id, i, centre, into, radial, section),
  );
  // Holes that do not touch each other are cut in one boolean with a compound tool (a
  // fuse per hole costs a boolean each); overlapping holes are fused first.
  const outer = Math.max(...section.points.map(([r]) => r));
  const apart = centres.every((c, i) =>
    centres.slice(0, i).every((d) => Math.hypot(...sub(c, d)) > 2 * outer + 1e-3),
  );
  const holder = { id: '', name: '', color: '', createdBy: '', ...tools[0]! };
  if (apart && tools.length > 1) {
    // replicad's makeCompound deletes its inputs: hand it clones (same B-rep, new wrappers).
    holder.shape = R.makeCompound(tools.map((t) => t.shape.clone())) as Shape3D;
    holder.faces = tools.flatMap((t) => t.faces);
  } else {
    for (const next of tools.slice(1))
      kit.combine(holder, next, 'join', feature.id, ctx.featureOrder);
  }

  // A hole whose centre is off the face is almost always a mistake: say which.
  const outside = centres
    .map((c, i) => ({ i, d: pointFaceDistance(kit, c, face) }))
    .filter((x) => x.d > Math.max(1e-3, section.bore * 1e-3));
  if (outside.length === centres.length) {
    kit.fail(
      centres.length === 1
        ? 'The hole lies outside the face'
        : `All ${centres.length} holes lie outside the face`,
    );
  }
  if (outside.length > 0) {
    ctx.warn(
      `Hole ${outside.map((x) => x.i + 1).join(', ')} ${outside.length === 1 ? 'lies' : 'lie'} outside the face`,
    );
  }
  try {
    kit.combine(
      body,
      { shape: holder.shape, faces: holder.faces },
      'cut',
      feature.id,
      ctx.featureOrder,
    );
  } catch (error) {
    if (kit.isFailure(error)) throw error;
    kit.fail(`Hole failed: ${kit.describeError(error)}`);
  }
  ctx.touch(body.id);
}

function pointFaceDistance(kit: FeatureKit, point: Vec3, face: R.Face): number {
  const oc = kit.oc;
  const vertex = R.makeVertex(point);
  const dist = new oc.BRepExtrema_DistShapeShape(
    vertex.wrapped as never,
    face.wrapped as never,
    1e-7,
  );
  try {
    return dist.IsDone() ? dist.Value() : Infinity;
  } finally {
    dist.delete();
    vertex.delete();
  }
}

/** The revolved cutting tool of hole `i` at `centre`, drilled along `into`. */
function holeTool(
  kit: FeatureKit,
  featureId: string,
  i: number,
  centre: Vec3,
  into: Vec3,
  radial: Vec3,
  section: HoleSection,
): Tool {
  const at = ([r, z]: [number, number]): Vec3 => add(add(centre, scale(radial, r)), scale(into, z));
  let shape: Shape3D;
  try {
    const profile = R.makePolygon(section.points.map(at));
    shape = R.revolution(profile, centre, into, 360) as Shape3D;
  } catch (error) {
    if (kit.isFailure(error)) throw error;
    kit.fail(`Hole ${i + 1} could not be built: ${kit.describeError(error)}`);
  }
  if (!(R.measureVolume(shape) > 0)) kit.fail(`Hole ${i + 1} could not be built`);
  const geoms = kit.describeShape(shape);
  const keys = assignFaceKeys(
    geoms,
    [],
    new Map(),
    (index) => `${featureId}:${holeFaceRole(geoms[index]!, centre, into, section)}:${i}`,
  );
  return { shape, faces: kit.withKeys(geoms, keys) };
}

function holeFaceRole(g: FaceGeom, centre: Vec3, into: Vec3, section: HoleSection): string {
  const tol = 1e-4;
  if (g.id.type === 'cylinder') {
    if (section.counterbore && Math.abs(g.id.radius - section.counterbore.radius) < tol) {
      return 'cbore';
    }
    return 'wall';
  }
  if (g.surface === 'cone') return 'csink';
  if (g.id.type === 'plane') {
    const z = dot(sub(g.centroid, centre), into);
    if (section.counterbore && Math.abs(z - section.counterbore.depth) < tol) return 'cbfloor';
    if (z > tol) return section.through ? 'end' : 'floor';
    return 'top';
  }
  return 'wall';
}
