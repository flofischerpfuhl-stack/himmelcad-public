/**
 * Rib and Thicken.
 *
 * **Rib** (web, gusset) from open sketch lines: each line is extended along
 * itself and swept away from itself in the sketch plane into a large planar
 * strip, thickened symmetrically across the sketch plane and clipped to the
 * body's bounding box; the part of that slab outside the body that touches
 * the line is the rib (it fills from the line until it meets the body).
 * The fill side defaults to the side where the body is (`flip` swaps it).
 *
 * **Thicken** turns faces (or sketch profiles) into solids of a thickness
 * (`BRepOffsetAPI_MakeThickSolid::MakeThickSolidBySimple`): outwards along
 * the face normal, inwards, or half each way. Several faces are thickened
 * one by one and fused (a sharp edge between two thickened faces leaves a
 * notch on its convex side: OCCT's simple offset joins no neighbours).
 */
import '../occtArena.js';
import * as R from 'replicad';

import { MIN_FEATURE_SIZE_MM, bodyIdFor, framePoint, type Vec3 } from '../../model/document.js';
import type { RibFeature, ThickenFeature } from '../../model/printFeatures.js';
import { entityMap, pointPos } from '../../sketch/types.js';
import { assignFaceKeys, type FaceGeom, type KeyedFace } from '../naming.js';
import type { RawShape } from '../occt.js';
import type { BodyStateLike, FeatureKit, ReplayContextLike, Shape3D } from './kit.js';
import { bodyOrFail, pickTarget, profileSections } from './refs.js';
import { add, cross, dot, length, normalize, scale, sub } from './rigid.js';

interface Tool {
  shape: Shape3D;
  faces: KeyedFace[];
}

function fmt(v: number): string {
  return String(Math.round(v * 1000) / 1000);
}

function named(
  kit: FeatureKit,
  shape: Shape3D,
  role: (g: FaceGeom, index: number) => string,
): Tool {
  const geoms = kit.describeShape(shape);
  const keys = assignFaceKeys(geoms, [], new Map(), (i) => role(geoms[i]!, i));
  return { shape, faces: kit.withKeys(geoms, keys) };
}

function holderOf(tool: Tool): BodyStateLike {
  return { id: '', name: '', color: '', createdBy: '', ...tool };
}

// ---- classification helpers -----------------------------------------------------------

function solidsOf(kit: FeatureKit, shape: { wrapped: RawShape }): RawShape[] {
  const oc = kit.oc;
  const out: RawShape[] = [];
  const explorer = new oc.TopExp_Explorer(
    shape.wrapped as never,
    oc.TopAbs_ShapeEnum.TopAbs_SOLID as never,
    oc.TopAbs_ShapeEnum.TopAbs_SHAPE as never,
  );
  try {
    for (; explorer.More(); explorer.Next()) out.push(explorer.Current() as RawShape);
  } finally {
    explorer.delete();
  }
  return out;
}

/** Distance between two shapes; 0 when one lies (partly) inside a solid of the other. */
function shapeDistance(kit: FeatureKit, a: RawShape, b: RawShape): number {
  const dist = new kit.oc.BRepExtrema_DistShapeShape(a as never, b as never, 1e-7);
  try {
    if (!dist.IsDone()) return Infinity;
    return dist.InnerSolution() ? 0 : dist.Value();
  } finally {
    dist.delete();
  }
}

function insideBody(kit: FeatureKit, solids: readonly RawShape[], point: Vec3): boolean {
  const vertex = R.makeVertex(point);
  try {
    return solids.some((s) => shapeDistance(kit, vertex.wrapped as RawShape, s) === 0);
  } finally {
    vertex.delete();
  }
}

function boundsOf(shape: Shape3D): { min: Vec3; max: Vec3 } {
  const box = shape.boundingBox;
  const [min, max] = box.bounds as [Vec3, Vec3];
  box.delete();
  return { min, max };
}

// ---- Rib ---------------------------------------------------------------------------------

export function applyRib(feature: RibFeature, ctx: ReplayContextLike, kit: FeatureKit): void {
  const t = feature.thickness;
  if (!(Number.isFinite(t) && t >= MIN_FEATURE_SIZE_MM)) {
    kit.fail(`Rib thickness must be at least ${MIN_FEATURE_SIZE_MM} mm`);
  }
  if (feature.entityIds.length === 0) kit.fail('Select at least one sketch line for the rib');
  const sketchFeature = ctx.sketchFeatures.get(feature.sketchId);
  const sketch = ctx.sketches.get(feature.sketchId);
  if (!sketchFeature || !sketch) kit.fail(`Missing reference: sketch "${feature.sketchId}"`);
  const body = pickTarget(kit, ctx, feature.targetBodyId);
  if (!body) kit.fail('A rib needs a body to attach to');
  const frame = sketch.frame;
  const m = frame.normal;
  const map = entityMap(sketchFeature);
  const { min, max } = boundsOf(body.shape);
  const diagonal = kit.diagonalOf(body.shape);
  const reach = diagonal * 2 + 10;
  const solids = solidsOf(kit, body.shape);

  const ribs: Tool[] = [];
  try {
    feature.entityIds.forEach((entityId, k) => {
      const line = map.get(entityId);
      if (!line) kit.fail(`Missing reference: line "${entityId}" of "${sketchFeature.name}"`);
      if (line.kind !== 'line') kit.fail('A rib is drawn with straight sketch lines');
      const a2 = pointPos(map, line.a);
      const b2 = pointPos(map, line.b);
      if (!a2 || !b2) kit.fail(`Missing reference: line "${entityId}" of "${sketchFeature.name}"`);
      const a = framePoint(frame, a2[0], a2[1]);
      const b = framePoint(frame, b2[0], b2[1]);
      const len = length(sub(b, a));
      if (len < MIN_FEATURE_SIZE_MM) kit.fail('The rib line is too short');
      const dir = normalize(sub(b, a));
      const across = normalize(cross(m, dir));
      const mid = scale(add(a, b), 0.5);
      const side = ribSide(kit, solids, mid, across, diagonal, feature.flip);
      if (side === 0) {
        kit.fail('The rib line does not face the body in the sketch plane; move the line next to the body');
      }
      const w = scale(across, side);
      // The strip: the line extended both ways, swept away from itself towards the body.
      const p0 = sub(a, scale(dir, reach));
      const p1 = add(b, scale(dir, reach));
      const corners = [p0, p1, add(p1, scale(w, reach)), add(p0, scale(w, reach))].map((p) =>
        sub(p, scale(m, t / 2)),
      );
      const strip = R.makePolygon(corners);
      const vector = new R.Vector(scale(m, t));
      const slab = R.basicFaceExtrusion(strip, vector);
      vector.delete();
      const box = R.makeBox(min, max);
      const clipped = slab.intersect(box) as Shape3D;
      const outside = clipped.cut(body.shape) as Shape3D;
      // Keep the pieces that touch the line itself.
      const edge = R.makeLine(a, b);
      const pieces = solidsOf(kit, outside).filter(
        (solid) => shapeDistance(kit, solid, edge.wrapped as RawShape) < Math.max(1e-4, t * 1e-3),
      );
      if (pieces.length === 0) {
        kit.fail(
          'The rib does not reach the body from this line; extend the line to the body or flip the side',
        );
      }
      const piece = R.makeCompound(pieces.map((raw) => R.cast(raw as never))) as Shape3D;
      for (const raw of pieces) raw.delete();
      const rib = named(kit, piece, (g) =>
        g.normal && Math.abs(dot(g.normal, m)) > 1 - 1e-7
          ? `${feature.id}:flank:${k}`
          : `${feature.id}:edge:${k}`,
      );
      ribs.push(rib);
    });
  } finally {
    for (const s of solids) s.delete();
  }
  const holder = holderOf(ribs[0]!);
  for (const next of ribs.slice(1)) kit.combine(holder, next, 'join', feature.id, ctx.featureOrder);
  try {
    kit.combine(body, { shape: holder.shape, faces: holder.faces }, 'join', feature.id, ctx.featureOrder);
  } catch (error) {
    if (kit.isFailure(error)) throw error;
    kit.fail(`Rib failed: ${kit.describeError(error)}`);
  }
  ctx.touch(body.id);
}

/**
 * Side of the line (+1 along `across`, -1 against) where the body lies,
 * probing outwards from the line midpoint; `flip` takes the other side.
 * 0 when neither side reaches the body within the diagonal.
 */
function ribSide(
  kit: FeatureKit,
  solids: readonly RawShape[],
  mid: Vec3,
  across: Vec3,
  diagonal: number,
  flip: boolean,
): number {
  let found = 0;
  for (let i = 1; i <= 64 && found === 0; i += 1) {
    const step = (diagonal * i) / 64;
    const plus = insideBody(kit, solids, add(mid, scale(across, step)));
    const minus = insideBody(kit, solids, add(mid, scale(across, -step)));
    if (plus && !minus) found = 1;
    else if (minus && !plus) found = -1;
    else if (plus && minus) found = 1;
  }
  return flip ? -found : found;
}

// ---- Thicken ------------------------------------------------------------------------------

export function applyThicken(
  feature: ThickenFeature,
  ctx: ReplayContextLike,
  kit: FeatureKit,
): void {
  const t = feature.thickness;
  if (!(Number.isFinite(t) && t >= MIN_FEATURE_SIZE_MM / 10)) {
    kit.fail(`Thickness must be at least ${MIN_FEATURE_SIZE_MM / 10} mm`);
  }
  const faces: R.Face[] = [];
  if (feature.source.kind === 'faces') {
    const refs = feature.source.faces;
    if (refs.length === 0) kit.fail('Select at least one face to thicken');
    const bodyId = refs[0]!.bodyId;
    if (refs.some((f) => f.bodyId !== bodyId)) kit.fail('All faces must belong to one body');
    const source = bodyOrFail(kit, ctx, bodyId);
    for (const ref of refs) faces.push(kit.resolveFace(source, ref, ctx.warn).face.clone());
  } else {
    for (const section of profileSections(kit, ctx, feature.source.profile)) faces.push(section.face);
  }
  // Offsets of the two sides from the face, along its normal.
  const [low, high] =
    feature.direction === 'outside' ? [0, t] : feature.direction === 'inside' ? [-t, 0] : [-t / 2, t / 2];
  const tools = faces.map((face, i) => thickenFace(kit, feature.id, i, face, low, high));
  const holder = holderOf(tools[0]!);
  for (const next of tools.slice(1)) kit.combine(holder, next, 'join', feature.id, ctx.featureOrder);
  const tool: Tool = { shape: holder.shape, faces: holder.faces };

  const target = feature.operation === 'new' ? null : pickTarget(kit, ctx, feature.targetBodyId);
  if (feature.operation !== 'new' && target) {
    try {
      kit.combine(target, tool, feature.operation === 'cut' ? 'cut' : 'join', feature.id, ctx.featureOrder);
    } catch (error) {
      if (kit.isFailure(error)) throw error;
      kit.fail(`Thicken failed: ${kit.describeError(error)}`);
    }
    ctx.touch(target.id);
    return;
  }
  if (feature.operation === 'cut') kit.fail('Nothing to cut: the document has no body');
  kit.addBody(ctx, {
    id: bodyIdFor(feature.id),
    name: feature.resultBodyName ?? (feature.name.trim() || 'Thicken'),
    createdBy: feature.id,
    shape: tool.shape,
    faces: tool.faces,
  });
}

/** Solid between the offsets `low` and `high` (mm along the face normal) of `face`. */
function thickenFace(
  kit: FeatureKit,
  featureId: string,
  i: number,
  face: R.Face,
  low: number,
  high: number,
): Tool {
  const oc = kit.oc;
  let shape: Shape3D | null = null;
  try {
    // Thicken the upper surface back down (MakeThickSolidBySimple turns
    // positive offsets inside out), trying the other sign for faces whose
    // orientation disagrees.
    const upper = high > 1e-9 ? (R.makeOffset(face, high) as unknown as { wrapped: RawShape }) : face;
    const upperFace = high > 1e-9 ? kit.facesOf(upper)[0] : face;
    if (!upperFace) kit.fail('Thicken failed: the offset surface is empty');
    const span = high - low;
    for (const value of [-span, span]) {
      const maker = new oc.BRepOffsetAPI_MakeThickSolid();
      try {
        maker.MakeThickSolidBySimple(upperFace.wrapped as never, value);
        const raw = maker.Shape();
        const candidate = R.cast(raw) as Shape3D;
        raw.delete();
        if (R.measureVolume(candidate) > 0) {
          shape = candidate;
          break;
        }
      } catch (error) {
        if (kit.isFailure(error)) throw error;
      } finally {
        maker.delete();
      }
    }
  } catch (error) {
    if (kit.isFailure(error)) throw error;
    kit.fail(`Thicken failed: ${kit.describeError(error)}`);
  }
  if (!shape) {
    kit.fail(
      `Thicken failed on face ${i + 1}: a ${fmt(high - low)} mm offset turns the surface inside out (radius too small?)`,
    );
  }
  const src = kit.describeFace(face);
  const mid = (low + high) / 2;
  return named(kit, shape, (g) => {
    const skin = skinSide(src, g);
    if (skin === null) return `${featureId}:side:${i}`;
    return `${featureId}:${skin > mid ? 'outer' : 'inner'}:${i}`;
  });
}

/**
 * Signed offset of `g` from the source face `src` along its normal when `g`
 * is one of the thickened skins (parallel plane / coaxial cylinder), else null.
 */
function skinSide(src: FaceGeom, g: FaceGeom): number | null {
  if (src.id.type === 'plane' && g.id.type === 'plane') {
    if (Math.abs(Math.abs(dot(src.id.normal, g.id.normal)) - 1) > 1e-7) return null;
    return dot(src.id.normal, sub(g.centroid, src.centroid));
  }
  if (src.id.type === 'cylinder' && g.id.type === 'cylinder') {
    if (Math.abs(Math.abs(dot(src.id.axis, g.id.axis)) - 1) > 1e-7) return null;
    const grow = g.id.radius - src.id.radius;
    return src.id.convex ? grow : -grow;
  }
  return null;
}
