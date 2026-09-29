/**
 * Direct face edits: Offset Face and Delete Face.
 *
 * This OCCT build (replicad-opencascadejs 1.1.0) does not bind
 * `BRepOffset_MakeOffset` (per-face offsets) nor
 * `BRepAlgoAPI_Defeaturing`, so both are built from what is bound:
 *
 * - **Offset Face** thickens each face into a slab
 *   (`BRepOffsetAPI_MakeThickSolid::MakeThickSolidBySimple`) and joins it
 *   (positive distance, outward) or cuts it (negative, into the material).
 *   Works on planar, cylindrical and other smooth faces; neighbours are not
 *   re-extended, so a face whose neighbours are not perpendicular to it
 *   gets a step instead of a longer neighbour (see KERNEL-SPIKE.md).
 * - **Delete Face** rebuilds the removed material for the cases that
 *   matter for printed parts: a hole wall (full concave cylinder) is filled,
 *   a fillet (partial cylinder) or chamfer (plane) between two planar
 *   neighbours is replaced by the sharp corner of the extended neighbours.
 *   Anything else fails with a clear message.
 */
import '../occtArena.js';
import * as R from 'replicad';

import { MIN_FEATURE_SIZE_MM, type FaceRef, type Vec3 } from '../../model/document.js';
import type { DeleteFaceFeature, OffsetFaceFeature } from '../../model/features.js';
import { assignFaceKeys, baseFaceKey, type FaceGeom, type KeyedFace } from '../naming.js';
import type { BodyStateLike, FeatureKit, ReplayContextLike, ResolvedFace, Shape3D } from './kit.js';
import { alongLine, bodyOrFail, sampleEdges, type Line3 } from './refs.js';
import { add, cross, dot, length, normalize, scale, sub } from './rigid.js';

interface Tool {
  shape: Shape3D;
  faces: KeyedFace[];
}

function facesOfOneBody(
  kit: FeatureKit,
  ctx: ReplayContextLike,
  refs: readonly FaceRef[],
): { body: BodyStateLike; resolved: ResolvedFace[] } {
  if (refs.length === 0) kit.fail('Select at least one face');
  const bodyId = refs[0]!.bodyId;
  if (refs.some((r) => r.bodyId !== bodyId)) kit.fail('All faces must belong to one body');
  const body = bodyOrFail(kit, ctx, bodyId);
  const resolved = refs.map((ref) => kit.resolveFace(body, ref, ctx.warn));
  const indices = new Set(resolved.map((r) => r.index));
  if (indices.size !== resolved.length) kit.fail('A face is listed twice');
  return { body, resolved };
}

// ---- Offset Face -------------------------------------------------------------------

export function applyOffsetFace(
  feature: OffsetFaceFeature,
  ctx: ReplayContextLike,
  kit: FeatureKit,
): void {
  const d = feature.distance;
  if (!Number.isFinite(d) || Math.abs(d) < MIN_FEATURE_SIZE_MM / 10) {
    kit.fail(`Offset must be at least ${MIN_FEATURE_SIZE_MM / 10} mm in magnitude`);
  }
  const { body, resolved } = facesOfOneBody(kit, ctx, feature.faces);
  const slabs = resolved.map((r, i) => {
    if (r.geom.id.type === 'cylinder' && !r.geom.id.convex && d >= r.geom.id.radius - 1e-6) {
      kit.fail(`Offset of ${fmt(d)} mm closes the hole (radius ${fmt(r.geom.id.radius)} mm)`);
    }
    if (r.geom.id.type === 'cylinder' && r.geom.id.convex && -d >= r.geom.id.radius - 1e-6) {
      kit.fail(
        `Offset of ${fmt(d)} mm removes the whole round face (radius ${fmt(r.geom.id.radius)} mm)`,
      );
    }
    return slab(kit, feature.id, i, r, d);
  });
  const tool = { id: '', name: '', color: '', createdBy: '', ...slabs[0]! };
  for (const next of slabs.slice(1)) {
    kit.combine(tool, next, 'join', feature.id, ctx.featureOrder);
  }
  try {
    kit.combine(body, tool, d > 0 ? 'join' : 'cut', feature.id, ctx.featureOrder);
  } catch (error) {
    kit.fail(`Offset Face failed: ${kit.describeError(error)}`);
  }
  ctx.touch(body.id);
}

/**
 * The material between face `r` and its offset by `d` (along the outward
 * normal), as a positive-volume solid. The offset surface's face inherits
 * the offset face's key; the slab's side walls are `:side:<i>:<n>`.
 */
function slab(kit: FeatureKit, featureId: string, i: number, r: ResolvedFace, d: number): Tool {
  const oc = kit.oc;
  let shape: Shape3D;
  try {
    // MakeThickSolidBySimple offsets along the face normal; a positive value
    // yields an inside-out solid, so thicken the offset face back instead.
    let base = r.face.wrapped;
    let value = d;
    let offsetShape: R.AnyShape | null = null;
    if (d > 0) {
      offsetShape = R.makeOffset(r.face, d);
      const offsetFace = kit.facesOf(offsetShape as Shape3D)[0];
      if (!offsetFace) kit.fail('Offset Face failed: the offset surface is empty');
      base = offsetFace.wrapped;
      value = -d;
    }
    const maker = new oc.BRepOffsetAPI_MakeThickSolid();
    try {
      maker.MakeThickSolidBySimple(base, value);
      const raw = maker.Shape();
      shape = R.cast(raw) as Shape3D;
      raw.delete();
    } finally {
      maker.delete();
    }
  } catch (error) {
    if (kit.isFailure(error)) throw error;
    kit.fail(`Offset Face failed: ${kit.describeError(error)}`);
  }
  if (!(R.measureVolume(shape) > 0))
    kit.fail('Offset Face failed: the offset face turns inside out');
  const geoms = kit.describeShape(shape);
  const offsetIndex = offsetFaceIndex(r.geom, geoms, Math.abs(d));
  let side = 0;
  const keys = assignFaceKeys(geoms, [], new Map(), (index) => {
    if (index === offsetIndex) return baseFaceKey(r.geom.key);
    side += 1;
    return `${featureId}:side:${i}:${side - 1}`;
  });
  return { shape, faces: kit.withKeys(geoms, keys) };
}

/** Index of the slab face that lies on the offset surface of `source`. */
function offsetFaceIndex(source: FaceGeom, geoms: FaceGeom[], d: number): number {
  const tol = 1e-4;
  const scored = geoms.map((g, index) => {
    const id = g.id;
    const s = source.id;
    let score = Infinity;
    if (s.type === 'plane' && id.type === 'plane') {
      if (Math.abs(Math.abs(dot(s.normal, id.normal)) - 1) < 1e-7) {
        const shift = Math.abs(dot(s.normal, scale(id.normal, id.offset)) - s.offset);
        score = Math.abs(shift - d);
      }
    } else if (s.type === 'cylinder' && id.type === 'cylinder') {
      if (Math.abs(Math.abs(dot(s.axis, id.axis)) - 1) < 1e-7) {
        score = Math.abs(Math.abs(id.radius - s.radius) - d);
      }
    } else if (s.type === 'other' && id.type === 'other' && id.kind === s.kind) {
      score = Math.abs(length(sub(id.centroid, s.centroid)) - d);
    }
    return { index, score };
  });
  const best = scored
    .filter((s) => s.score < Math.max(tol, d * 0.05))
    .sort((a, b) => a.score - b.score)[0];
  return best?.index ?? -1;
}

// ---- Delete Face -------------------------------------------------------------------

const DELETE_FACE_LIMIT =
  'Delete Face can remove holes, and fillets or chamfers between two planar faces. ' +
  "Other faces need OCCT's general defeaturing (BRepAlgoAPI_Defeaturing), which is not part of this kernel build";

export function applyDeleteFace(
  feature: DeleteFaceFeature,
  ctx: ReplayContextLike,
  kit: FeatureKit,
): void {
  const { body, resolved } = facesOfOneBody(kit, ctx, feature.faces);
  const fills: Tool[] = [];
  const removals: Tool[] = [];
  resolved.forEach((r, i) => {
    const patch = healingPatch(kit, body, r);
    const tool = namedTool(kit, feature.id, i, patch.shape);
    (patch.add ? fills : removals).push(tool);
  });
  for (const [tools, operation] of [
    [fills, 'join'],
    [removals, 'cut'],
  ] as const) {
    for (const tool of tools) {
      try {
        kit.combine(body, tool, operation, feature.id, ctx.featureOrder);
      } catch (error) {
        kit.fail(`Delete Face failed: ${kit.describeError(error)}`);
      }
    }
  }
  ctx.touch(body.id);
  const removedKeys = resolved.map((r) => baseFaceKey(r.geom.key));
  if (body.faces.some((f) => removedKeys.includes(baseFaceKey(f.key)))) {
    kit.fail('Delete Face failed: the face could not be healed away');
  }
}

function namedTool(kit: FeatureKit, featureId: string, i: number, shape: Shape3D): Tool {
  const geoms = kit.describeShape(shape);
  const keys = assignFaceKeys(geoms, [], new Map(), () => `${featureId}:fill:${i}`);
  return { shape, faces: kit.withKeys(geoms, keys) };
}

/** Solid that removes the face when joined (`add`) or cut from the body. */
function healingPatch(
  kit: FeatureKit,
  body: BodyStateLike,
  r: ResolvedFace,
): { shape: Shape3D; add: boolean } {
  const { geom, topology, index } = r;
  const id = geom.id;
  const edges = topology.faceEdges[index] ?? [];
  const neighbourPlaneAcross = (edgeIndex: number): FaceGeom | null => {
    const other = (topology.edgeFaces[edgeIndex] ?? []).find((f) => f !== index);
    const face = other !== undefined ? body.faces[other] : undefined;
    return face && face.id.type === 'plane' ? face : null;
  };

  if (id.type === 'cylinder') {
    const axis: Line3 = { point: id.point, dir: id.axis };
    const samples = sampleEdges(
      kit,
      edges.map((e) => topology.edges[e]!),
    );
    const along = samples.map((p) => alongLine(axis, p));
    const t0 = Math.min(...along);
    const t1 = Math.max(...along);
    if (!(t1 - t0 > 1e-6)) kit.fail(DELETE_FACE_LIMIT);
    const fullTurn = Math.abs(geom.area - 2 * Math.PI * id.radius * (t1 - t0)) < 1e-3 * geom.area;
    if (!id.convex && fullTurn) {
      // A hole wall: fill the hole along the face's axial extent.
      const base = add(axis.point, scale(axis.dir, t0));
      return { shape: R.makeCylinder(id.radius, t1 - t0, base, axis.dir), add: true };
    }
    if (fullTurn) kit.fail('Deleting the wall of a round boss would remove the whole boss');
    // A fillet: the two straight edges along the axis, each with a planar neighbour.
    const straight = edges.filter((e) => {
      const g = topology.edgeGeoms[e]!;
      return (
        g.curve === 'line' &&
        g.direction &&
        Math.abs(Math.abs(dot(g.direction, id.axis)) - 1) < 1e-6
      );
    });
    if (straight.length !== 2) kit.fail(DELETE_FACE_LIMIT);
    const planes = straight.map(neighbourPlaneAcross);
    if (planes.some((p) => p === null)) kit.fail(DELETE_FACE_LIMIT);
    const wedge = cornerWedge(
      kit,
      axis.dir,
      t0,
      t1,
      axis,
      straight.map((e) => topology.edgeGeoms[e]!.midpoint),
      planes as FaceGeom[],
      {
        center: id.point,
        radius: id.radius,
      },
    );
    return { shape: wedge, add: id.convex };
  }

  if (id.type === 'plane' && geom.normal) {
    // A chamfer: two parallel straight edges with planar neighbours.
    const lines = edges.filter((e) => topology.edgeGeoms[e]!.curve === 'line');
    for (let a = 0; a < lines.length; a += 1) {
      for (let b = a + 1; b < lines.length; b += 1) {
        const ga = topology.edgeGeoms[lines[a]!]!;
        const gb = topology.edgeGeoms[lines[b]!]!;
        if (!ga.direction || !gb.direction) continue;
        if (Math.abs(Math.abs(dot(ga.direction, gb.direction)) - 1) > 1e-6) continue;
        const pa = neighbourPlaneAcross(lines[a]!);
        const pb = neighbourPlaneAcross(lines[b]!);
        if (!pa || !pb || !pa.normal || !pb.normal) continue;
        if (Math.abs(Math.abs(dot(pa.normal, pb.normal)) - 1) < 1e-6) continue; // parallel neighbours
        const dir = normalize(ga.direction);
        const axis: Line3 = { point: ga.midpoint, dir };
        const samples = sampleEdges(kit, [topology.edges[lines[a]!]!, topology.edges[lines[b]!]!]);
        const along = samples.map((p) => alongLine(axis, p));
        const wedge = cornerWedge(
          kit,
          dir,
          Math.min(...along),
          Math.max(...along),
          axis,
          [ga.midpoint, gb.midpoint],
          [pa, pb],
          null,
        );
        // Convex chamfer: the corner lies outside the material (on the chamfer's outward side).
        const corner = cornerPoint(axis, [ga.midpoint, gb.midpoint], [pa, pb], 0);
        const outward = dot(sub(corner, geom.centroid), geom.normal) > 0;
        return { shape: wedge, add: outward };
      }
    }
  }
  kit.fail(DELETE_FACE_LIMIT);
}

/** Point in the cross-section at `t` where the two neighbour planes meet. */
function cornerPoint(axis: Line3, edgePoints: Vec3[], planes: FaceGeom[], t: number): Vec3 {
  const n1 = planes[0]!.normal!;
  const n2 = planes[1]!.normal!;
  const d1 = dot(n1, edgePoints[0]!);
  const d2 = dot(n2, edgePoints[1]!);
  const d3 = dot(axis.dir, add(axis.point, scale(axis.dir, t)));
  return solve3([n1, n2, axis.dir], [d1, d2, d3]);
}

/**
 * Prism between the removed face and the corner where its two planar
 * neighbours meet, spanning `t0..t1` along `dir`. With `arc` the face side
 * is the fillet's circular arc, else a straight chamfer line.
 */
function cornerWedge(
  kit: FeatureKit,
  dir: Vec3,
  t0: number,
  t1: number,
  axis: Line3,
  edgePoints: Vec3[],
  planes: FaceGeom[],
  arc: { center: Vec3; radius: number } | null,
): Shape3D {
  const at = (p: Vec3): Vec3 => add(p, scale(dir, t0 - alongLine(axis, p)));
  const p1 = at(edgePoints[0]!);
  const p2 = at(edgePoints[1]!);
  const corner = cornerPoint(axis, edgePoints, planes, t0);
  const onArc = arc
    ? add(
        at(arc.center),
        scale(normalize(sub(scale(add(p1, p2), 0.5), at(arc.center))), arc.radius),
      )
    : null;
  // Wind the section counter-clockwise about the extrusion direction, else
  // the prism comes out inside-out (negative volume) and a boolean ignores it.
  const counterClockwise = dot(cross(sub(p2, p1), sub(corner, p1)), dir) > 0;
  const [a, b] = counterClockwise ? [p1, p2] : [p2, p1];
  try {
    const edges: R.Edge[] = [
      onArc ? R.makeThreePointArc(a, onArc, b) : R.makeLine(a, b),
      R.makeLine(b, corner),
      R.makeLine(corner, a),
    ];
    const face = R.makeFace(R.assembleWire(edges));
    const vector = new R.Vector(scale(dir, t1 - t0));
    const prism = R.basicFaceExtrusion(face, vector);
    vector.delete();
    if (!(R.measureVolume(prism) > 0))
      kit.fail('Delete Face failed: the corner patch is degenerate');
    return prism;
  } catch (error) {
    if (kit.isFailure(error)) throw error;
    kit.fail(`Delete Face failed: ${kit.describeError(error)}`);
  }
}

function solve3(rows: Vec3[], rhs: number[]): Vec3 {
  const [a, b, c] = rows as [Vec3, Vec3, Vec3];
  const det = dot(a, cross(b, c));
  if (Math.abs(det) < 1e-12) return [NaN, NaN, NaN];
  const x = add(
    add(scale(cross(b, c), rhs[0]!), scale(cross(c, a), rhs[1]!)),
    scale(cross(a, b), rhs[2]!),
  );
  return scale(x, 1 / det);
}

function fmt(value: number): string {
  return String(Math.round(value * 1000) / 1000);
}
