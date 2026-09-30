/**
 * Emboss / engrave sketch profiles onto a body face.
 *
 * - **Planar face**: the profile (its sketch must be parallel to the face)
 *   is moved onto the face plane along the normal and extruded outwards by
 *   the depth (emboss, joined) or inwards (engrave, cut), starting exactly
 *   on the face plane — like an extrude from a sketch on a face. (Until
 *   2026-09-30 the tool overlapped the body by a small lead; that made
 *   OCCT intersect every glyph side face with the face plane, ~30 % of the
 *   feature's time, and added a lead-thick skirt under profile parts that
 *   hang over the face's edge. Names and volumes on the face are the same.)
 * - **Cylindrical face (outside of a round boss)**: the profile is
 *   **wrapped** — surface lengths are kept: a sketch point at distance `s`
 *   (along the sketch, perpendicular to the axis) from the wrap centre goes
 *   to the angle `s / R` around the axis, its position along the axis is
 *   kept. The wrapped outline is drawn in the parametric space of a
 *   cylindrical surface (replicad `sketchOnFace(…, 'native')`, i.e. OCCT
 *   p-curves: lines become helices, arcs exact 2D curves), and the face is
 *   thickened radially (`BRepOffsetAPI_MakeThickSolid::MakeThickSolidBySimple`).
 *   The wrap centre is where the sketch normal through the axis meets the
 *   cylinder, on the sketch's side.
 *
 * Face names: `<id>:top:<p>` (raised face or engraved floor is `:floor:`),
 * `<id>:side:<p>` (`#n` pieces) for profile `p`.
 */
import '../occtArena.js';
import * as R from 'replicad';

import { MIN_FEATURE_SIZE_MM, framePoint, type Vec3 } from '../../model/document.js';
import type { EmbossFeature } from '../../model/printFeatures.js';
import { isFullCircle, pointAt } from '../../sketch/geometry.js';
import type { RegionLoop, SketchRegion } from '../../sketch/regions.js';
import { assignFaceKeys, type FaceGeom, type KeyedFace } from '../naming.js';
import { rebindRegion } from '../regionRebind.js';
import type { FeatureKit, ReplayContextLike, Shape3D } from './kit.js';
import { bodyOrFail, profileSections } from './refs.js';
import { cross, dot, normalize, scale, sub } from './rigid.js';

interface Tool {
  shape: Shape3D;
  faces: KeyedFace[];
}

function fmt(v: number): string {
  return String(Math.round(v * 1000) / 1000);
}

export function applyEmboss(feature: EmbossFeature, ctx: ReplayContextLike, kit: FeatureKit): void {
  const depth = feature.depth;
  if (!(Number.isFinite(depth) && Math.abs(depth) >= MIN_FEATURE_SIZE_MM / 2)) {
    kit.fail(`Emboss depth must be at least ${MIN_FEATURE_SIZE_MM / 2} mm (negative engraves)`);
  }
  const body = bodyOrFail(kit, ctx, feature.face.bodyId);
  const { geom } = kit.resolveFace(body, feature.face, ctx.warn);
  let tools: Tool[];
  if (geom.surface === 'plane' && geom.normal) {
    tools = planarTools(kit, ctx, feature, geom);
  } else if (geom.id.type === 'cylinder') {
    if (!geom.id.convex) {
      kit.fail('Emboss wraps onto the outside of a round face; this face is the inside of a hole');
    }
    // The wrapped tool overlaps the cylinder radially by a small lead.
    const diagonal = kit.diagonalOf(body.shape);
    const lead = Math.max(0.02, Math.min(0.2, diagonal * 2e-4));
    tools = wrappedTools(kit, ctx, feature, geom.id, lead);
  } else {
    kit.fail(
      'Emboss works on planar and cylindrical faces; wrapping onto cones or free-form faces is not supported',
    );
  }
  const holder = batchTools(kit, ctx, feature.id, tools);
  try {
    kit.combine(
      body,
      { shape: holder.shape, faces: holder.faces },
      depth > 0 ? 'join' : 'cut',
      feature.id,
      ctx.featureOrder,
    );
  } catch (error) {
    if (kit.isFailure(error)) throw error;
    kit.fail(`Emboss failed: ${kit.describeError(error)}`);
  }
  ctx.touch(body.id);
}

/**
 * One tool for all profiles, applied to the body in a single boolean.
 * Profiles whose tools cannot touch (bounding boxes apart by more than a
 * small margin — the letters of a label, the dot of an "i") are gathered
 * in a compound: no boolean at all. Only tools whose boxes overlap are
 * fused first, in profile order, as before. A fuse of disjoint solids
 * returns their faces unchanged, so the compound names the result's faces
 * exactly like the fuse did; it only avoids one boolean per extra profile
 * (each over the growing union: ~1 s for an 11-glyph label).
 */
function batchTools(
  kit: FeatureKit,
  ctx: ReplayContextLike,
  featureId: string,
  tools: Tool[],
): {
  id: string;
  name: string;
  color: string;
  createdBy: string;
  shape: Shape3D;
  faces: KeyedFace[];
} {
  const holderOf = (tool: Tool) => ({ id: '', name: '', color: '', createdBy: '', ...tool });
  if (tools.length === 1) return holderOf(tools[0]!);
  const boxes = tools.map((t) => kit.boundsOf(t.shape));
  const size = Math.max(
    ...boxes.flatMap(([min, max]) => [max[0] - min[0], max[1] - min[1], max[2] - min[2]]),
  );
  const margin = Math.max(0.01, size * 1e-3);
  const overlap = (a: number, b: number) =>
    [0, 1, 2].every(
      (k) =>
        boxes[a]![0][k]! <= boxes[b]![1][k]! + margin &&
        boxes[b]![0][k]! <= boxes[a]![1][k]! + margin,
    );
  // Groups of possibly touching tools (union-find), each keyed by its first profile.
  const parent = tools.map((_, i) => i);
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i]!)));
  for (let a = 0; a < tools.length; a += 1) {
    for (let b = a + 1; b < tools.length; b += 1) {
      if (overlap(a, b)) parent[Math.max(find(a), find(b))] = Math.min(find(a), find(b));
    }
  }
  const groups = new Map<number, number[]>();
  tools.forEach((_, i) => groups.set(find(i), [...(groups.get(find(i)) ?? []), i]));
  const fused = [...groups.values()].map((members) => {
    const holder = holderOf(tools[members[0]!]!);
    for (const next of members.slice(1))
      kit.combine(holder, tools[next]!, 'join', featureId, ctx.featureOrder);
    return holder;
  });
  if (fused.length === 1) return fused[0]!;
  // replicad's makeCompound deletes its inputs: hand it clones (same B-rep, new wrappers).
  return {
    ...fused[0]!,
    shape: R.makeCompound(fused.map((t) => t.shape.clone())) as Shape3D,
    faces: fused.flatMap((t) => t.faces),
  };
}

// ---- planar -----------------------------------------------------------------------------

function planarTools(
  kit: FeatureKit,
  ctx: ReplayContextLike,
  feature: EmbossFeature,
  geom: KeyedFace,
): Tool[] {
  const n = geom.normal!;
  const offset = dot(n, geom.centroid);
  const depth = feature.depth;
  return profileSections(kit, ctx, feature.profile).map((section) => {
    if (Math.abs(Math.abs(dot(section.normal, n)) - 1) > 1e-6) {
      kit.fail('Emboss on a planar face needs a sketch parallel to the face');
    }
    // Onto the face plane, then `depth` out of (or into) the material from there.
    const face = section.face.translate(scale(n, offset - dot(n, section.center)));
    const vector = new R.Vector(scale(n, depth));
    let shape: Shape3D;
    try {
      shape = R.basicFaceExtrusion(face, vector);
    } catch (error) {
      if (kit.isFailure(error)) throw error;
      kit.fail(`Emboss failed: ${kit.describeError(error)}`);
    } finally {
      vector.delete();
    }
    return nameTool(kit, feature.id, section.profileIndex, shape, (g) => {
      if (g.id.type !== 'plane' || !g.normal || Math.abs(Math.abs(dot(g.normal, n)) - 1) > 1e-7) {
        return 'side';
      }
      const level = dot(n, g.centroid) - offset;
      return Math.abs(level - depth) < 1e-4 ? (depth > 0 ? 'top' : 'floor') : 'base';
    });
  });
}

// ---- wrapped onto a cylinder ----------------------------------------------------------------

type CylinderId = Extract<KeyedFace['id'], { type: 'cylinder' }>;

function wrappedTools(
  kit: FeatureKit,
  ctx: ReplayContextLike,
  feature: EmbossFeature,
  cylinder: CylinderId,
  lead: number,
): Tool[] {
  const ref = feature.profile;
  if (ref.kind !== 'sketch') kit.fail('Wrapping onto a round face needs a sketch profile');
  const sketchFeature = ctx.sketchFeatures.get(ref.featureId);
  const sketch = ctx.sketches.get(ref.featureId);
  const regions = ctx.sketchRegions.get(ref.featureId);
  if (!sketchFeature || !sketch || !regions)
    kit.fail(`Missing reference: sketch "${ref.featureId}"`);
  if (regions.length === 0) kit.fail(`"${sketchFeature.name}" has no closed profile`);
  const frame = sketch.frame;
  const axis = normalize(cylinder.axis);
  const radius = cylinder.radius;
  if (Math.abs(dot(frame.normal, axis)) > 1e-6) {
    kit.fail('Wrapping needs a sketch plane parallel to the cylinder axis');
  }
  // Wrap centre direction: from the axis towards the sketch plane (its normal side if it contains the axis).
  const side = dot(sub(frame.origin, cylinder.point), frame.normal);
  const toward = Math.abs(side) < 1e-9 ? frame.normal : scale(frame.normal, Math.sign(side));
  const tangent = normalize(cross(axis, toward));
  const origin = cylinder.point;
  /** Unrolled coordinates of a sketch point: arc length `s` from the wrap centre, `z` along the axis. */
  const unroll = (u: number, v: number): [number, number] => {
    const p = framePoint(frame, u, v);
    return [dot(sub(p, origin), tangent), dot(sub(p, origin), axis)];
  };

  const keys = ref.regions ?? regions.map((r) => r.key);
  const bound = new Set(keys.filter((key) => regions.some((r) => r.key === key)));
  const depth = feature.depth;
  return keys.map((key, p) => {
    let region = regions.find((r) => r.key === key);
    if (!region) {
      const rebound = rebindRegion(key, regions, bound, sketchFeature);
      if (!rebound) kit.fail(`Missing reference: profile "${key}" of "${sketchFeature.name}"`);
      bound.add(rebound.region.key);
      ctx.warn(rebound.message);
      region = rebound.region;
    }
    const extent = loopExtent(region.outer, unroll);
    if (extent.maxS - extent.minS >= 2 * Math.PI * radius * 0.98) {
      kit.fail(
        `The profile (${fmt(extent.maxS - extent.minS)} mm wide) does not fit around the cylinder (circumference ${fmt(2 * Math.PI * radius)} mm)`,
      );
    }
    if (Math.max(Math.abs(extent.minS), Math.abs(extent.maxS)) >= Math.PI * radius * 0.99) {
      kit.fail(
        'The profile wraps more than halfway around the cylinder from its centre; move it towards the sketch centre line',
      );
    }
    // Outer surface of the tool and radial thickness (overlapping the body by `lead`).
    const outer = depth > 0 ? radius + depth : radius + lead;
    const thickness = depth > 0 ? depth + lead : -depth + lead;
    if (outer - thickness <= MIN_FEATURE_SIZE_MM / 10) {
      kit.fail(
        `Engraving ${fmt(-depth)} mm deep would cut through the cylinder (radius ${fmt(radius)} mm)`,
      );
    }
    let shape: Shape3D;
    try {
      const face = wrappedFace(kit, region, unroll, origin, axis, toward, outer, radius);
      shape = thickenInward(kit, face, thickness, outer - thickness);
    } catch (error) {
      if (kit.isFailure(error)) throw error;
      kit.fail(`Emboss could not wrap profile ${p + 1}: ${kit.describeError(error)}`);
    }
    return nameTool(kit, feature.id, p, shape, (g) => {
      if (g.id.type !== 'cylinder') return 'side';
      if (Math.abs(g.id.radius - (radius + depth)) < 1e-4) return depth > 0 ? 'top' : 'floor';
      return 'base';
    });
  });
}

/** The region drawn on a cylinder of radius `surfaceRadius` (angles from the unroll radius `radius`). */
function wrappedFace(
  kit: FeatureKit,
  region: SketchRegion,
  unroll: (u: number, v: number) => [number, number],
  origin: Vec3,
  axis: Vec3,
  toward: Vec3,
  surfaceRadius: number,
  radius: number,
): R.Face {
  const oc = kit.oc;
  // Native u = angle from -toward, so the wrap centre sits at u = pi, far from the seam.
  const xDir = scale(toward, -1);
  const pnt = new oc.gp_Pnt(origin[0], origin[1], origin[2]);
  const dir = new oc.gp_Dir(axis[0], axis[1], axis[2]);
  const xd = new oc.gp_Dir(xDir[0], xDir[1], xDir[2]);
  const ax3 = new oc.gp_Ax3(pnt, dir, xd);
  const cylinder = new oc.gp_Cylinder(ax3, surfaceRadius);
  const maker = new oc.BRepBuilderAPI_MakeFace(cylinder);
  let base: R.Face;
  try {
    base = new R.Face(maker.Face());
  } finally {
    maker.delete();
    cylinder.delete();
    ax3.delete();
    xd.delete();
    dir.delete();
    pnt.delete();
  }
  let drawing = loopDrawing(region.outer, unroll);
  for (const hole of region.holes) drawing = drawing.cut(loopDrawing(hole, unroll));
  // `stretch` is an affinity about an axis: [0, 1] keeps z and scales the arc length s to radians.
  const onSurface = drawing.stretch(1 / radius, [0, 1], [0, 0]).translate(Math.PI, 0);
  const sketch = onSurface.sketchOnFace(base, 'native') as R.Sketch | R.CompoundSketch;
  return sketch.face();
}

/** A closed loop as a replicad drawing in unrolled (s, z) coordinates. */
function loopDrawing(
  loop: RegionLoop,
  unroll: (u: number, v: number) => [number, number],
): R.Drawing {
  const map = (p: readonly [number, number]): [number, number] => unroll(p[0], p[1]);
  const [only] = loop.pieces;
  if (loop.pieces.length === 1 && only && only.curve.kind === 'arc' && isFullCircle(only.curve)) {
    const c = map(only.curve.c);
    return R.drawCircle(only.curve.r).translate(c[0], c[1]);
  }
  const first = loop.pieces[0];
  if (!first) throw new Error('empty profile loop');
  const start = map(first.start ?? pointAt(first.curve, 0));
  let pen = R.draw(start);
  for (const piece of loop.pieces) {
    const end = map(piece.end ?? pointAt(piece.curve, 1));
    if (piece.curve.kind === 'line') pen = pen.lineTo(end);
    else if (piece.curve.kind === 'arc')
      pen = pen.threePointsArcTo(end, map(pointAt(piece.curve, 0.5)));
    else if (piece.curve.kind === 'bezier') {
      // Spline and text-glyph chains: `unroll` is affine in the sketch plane, so each Bézier
      // segment maps exactly to the Bézier of its mapped control points.
      const segs = piece.curve.segs;
      segs.forEach((seg, i) => {
        const to = i === segs.length - 1 ? end : map(seg[seg.length - 1]!);
        if (seg.length === 4) pen = pen.cubicBezierCurveTo(to, map(seg[1]!), map(seg[2]!));
        else if (seg.length === 3) pen = pen.quadraticBezierCurveTo(to, map(seg[1]!));
        else pen = pen.lineTo(to);
      });
    } else {
      // Ellipses (and any future curve kind): a fine polyline through the curve.
      for (let i = 1; i < 64; i += 1) pen = pen.lineTo(map(pointAt(piece.curve, i / 64)));
      pen = pen.lineTo(end);
    }
  }
  return pen.close();
}

function loopExtent(
  loop: RegionLoop,
  unroll: (u: number, v: number) => [number, number],
): { minS: number; maxS: number } {
  let minS = Infinity;
  let maxS = -Infinity;
  for (const piece of loop.pieces) {
    // Bézier chains (glyph contours) carry many segments in one piece: sample each segment.
    const n = 16 * (piece.curve.kind === 'bezier' ? Math.max(1, piece.curve.segs.length) : 1);
    for (let i = 0; i <= n; i += 1) {
      const [u, v] = pointAt(piece.curve, i / n);
      const [s] = unroll(u, v);
      minS = Math.min(minS, s);
      maxS = Math.max(maxS, s);
    }
  }
  return { minS, maxS };
}

/**
 * Solid between `face` (on a cylinder) and its offset `thickness` towards
 * the axis: the offset side follows the face orientation, so both signs are
 * tried and the one reaching `innerRadius` with a positive volume is kept.
 */
function thickenInward(
  kit: FeatureKit,
  face: R.Face,
  thickness: number,
  innerRadius: number,
): Shape3D {
  const oc = kit.oc;
  for (const value of [-thickness, thickness]) {
    const maker = new oc.BRepOffsetAPI_MakeThickSolid();
    try {
      maker.MakeThickSolidBySimple(face.wrapped as never, value);
      const raw = maker.Shape();
      const shape = R.cast(raw) as Shape3D;
      raw.delete();
      const reachesInner = kit
        .describeShape(shape)
        .some((g) => g.id.type === 'cylinder' && Math.abs(g.id.radius - innerRadius) < 1e-4);
      if (reachesInner && R.measureVolume(shape) > 0) return shape;
    } catch (error) {
      if (kit.isFailure(error)) throw error;
    } finally {
      maker.delete();
    }
  }
  kit.fail('Emboss could not thicken the wrapped profile');
}

function nameTool(
  kit: FeatureKit,
  featureId: string,
  p: number,
  shape: Shape3D,
  role: (g: FaceGeom) => string,
): Tool {
  const geoms = kit.describeShape(shape);
  const keys = assignFaceKeys(geoms, [], new Map(), (i) => `${featureId}:${role(geoms[i]!)}:${p}`);
  return { shape, faces: kit.withKeys(geoms, keys) };
}
