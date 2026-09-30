/**
 * Direct face edits: Offset Face and Delete Face (kernel part of the
 * direct-edit module, registered by `kernel.ts`).
 *
 * On the HimmelCAD OCCT build (`HIMMELCAD_OCCT=himmelcad`, `occtExtras.ts`)
 * both first use OCCT's own algorithms (`exactFaceOps.ts`: per-face
 * `BRepOffset_MakeOffset`, `BRepAlgoAPI_Defeaturing`) and fall back to the
 * emulations below when OCCT fails. replicad-opencascadejs 1.1.0 binds
 * neither, so there only the emulations run:
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
 *
 * OCCT only through the kernel's exports (`FeatureKit`, `occtApi.ts`,
 * `faceOps.ts`, `exactFaceOps.ts`).
 */
import * as R from '../../foundation/geometry-kernel/features/occtApi.js';

import { MIN_FEATURE_SIZE_MM, type Vec3 } from '../../foundation/document/document.js';
import type { FeatureOf } from '../../foundation/document/featureKinds.js';
import {
  assignFaceKeys,
  baseFaceKey,
  sameSurface,
  type FaceGeom,
} from '../../foundation/geometry-kernel/naming.js';
import { occtExtras } from '../../foundation/geometry-kernel/occtExtras.js';
import {
  defeatureWithHistory,
  offsetFacesWithHistory,
} from '../../foundation/geometry-kernel/features/exactFaceOps.js';
import {
  applyExact,
  facesOfOneBody,
  offsetFaceIndex,
  offsetSlab,
  type FaceTool,
} from '../../foundation/geometry-kernel/features/faceOps.js';
import type {
  BodyStateLike,
  FeatureKit,
  ReplayContextLike,
  ResolvedFace,
  Shape3D,
} from '../../foundation/geometry-kernel/features/kit.js';
import {
  alongLine,
  bodyOrFail,
  sampleEdges,
  type Line3,
} from '../../foundation/geometry-kernel/features/refs.js';
import {
  add,
  cross,
  dot,
  normalize,
  scale,
  sub,
} from '../../foundation/geometry-kernel/features/rigid.js';

type OffsetFaceFeature = FeatureOf<'offsetFace'>;
type DeleteFaceFeature = FeatureOf<'deleteFace'>;
type Tool = FaceTool;
// ---- Offset Face -------------------------------------------------------------------

/** Differences below this (mm) leave the face where it is in Radius/Diameter/Total mode. */
const SAME_SIZE_MM = 1e-6;

/**
 * The signed offset along the outward normal that gives `feature`'s value in
 * its mode (DIR-01), measured on the face as it is now: Radius/Diameter of a
 * cylindrical face (a boss grows outward, a hole wall inward), Total distance
 * to the parallel `opposite` face (the side of the opposite face is kept).
 */
function modeOffset(
  kit: FeatureKit,
  ctx: ReplayContextLike,
  feature: OffsetFaceFeature,
  face: ResolvedFace,
): number {
  const mode = feature.mode ?? 'offset';
  const value = feature.distance;
  if (mode === 'offset') return value;
  if (!Number.isFinite(value) || value <= 0) {
    kit.fail(`The ${mode === 'total' ? 'total distance' : mode} must be a positive number`);
  }
  const id = face.geom.id;
  if (mode === 'radius' || mode === 'diameter') {
    if (id.type !== 'cylinder') kit.fail(`${modeLabel(mode)} needs a cylindrical face`);
    const target = mode === 'radius' ? value : value / 2;
    return id.convex ? target - id.radius : id.radius - target;
  }
  if (!feature.opposite) kit.fail('Total needs an opposite face');
  const normal = face.geom.normal;
  if (face.geom.surface !== 'plane' || !normal) kit.fail('Total needs a planar face');
  const other = kit.resolveFace(
    bodyOrFail(kit, ctx, feature.opposite.bodyId),
    feature.opposite,
    ctx.warn,
  ).geom;
  if (other.surface !== 'plane' || !other.normal) kit.fail('Total needs a planar opposite face');
  if (Math.abs(dot(normal, other.normal)) < 1 - 1e-6) {
    kit.fail('Total needs an opposite face parallel to the face');
  }
  // Signed distance of the face from the opposite plane, along the face's outward normal.
  const gap = dot(normal, sub(face.geom.centroid, other.centroid));
  if (Math.abs(gap) < SAME_SIZE_MM) kit.fail('The opposite face lies in the plane of the face');
  return Math.sign(gap) * value - gap;
}

function modeLabel(mode: 'radius' | 'diameter'): string {
  return mode === 'radius' ? 'Radius' : 'Diameter';
}

export function applyOffsetFace(
  feature: OffsetFaceFeature,
  ctx: ReplayContextLike,
  kit: FeatureKit,
): void {
  const mode = feature.mode ?? 'offset';
  if (mode !== 'offset' && feature.faces.length !== 1) {
    kit.fail('Radius, Diameter and Total apply to exactly one face');
  }
  if (mode === 'offset') {
    const value = feature.distance;
    if (!Number.isFinite(value) || Math.abs(value) < MIN_FEATURE_SIZE_MM / 10) {
      kit.fail(`Offset must be at least ${MIN_FEATURE_SIZE_MM / 10} mm in magnitude`);
    }
  }
  const { body, resolved } = facesOfOneBody(kit, ctx, feature.faces);
  const d = modeOffset(kit, ctx, feature, resolved[0]!);
  // Already at the target size/distance: nothing to move.
  if (mode !== 'offset' && Math.abs(d) < SAME_SIZE_MM) return;
  for (const r of resolved) checkOffsetFits(kit, r, d);
  // HimmelCAD OCCT build: move the faces and re-extend their neighbours.
  const exact = offsetFacesWithHistory(
    kit.oc,
    body.shape,
    resolved.map((r) => ({ face: r.face, distance: d })),
  );
  const geoms = exact ? kit.describeShape(exact.shape) : [];
  // OCCT offsets tangent-continuous neighbours (a fillet, the face beyond it)
  // together with the face. That is a different edit than "move this face",
  // so it is only accepted when every other face still lies on its own surface;
  // otherwise the slab route below runs.
  const selectedKeys = new Set(resolved.map((r) => baseFaceKey(r.geom.key)));
  if (
    exact &&
    !body.faces.every(
      (f) => selectedKeys.has(baseFaceKey(f.key)) || geoms.some((g) => sameSurface(g.id, f.id)),
    )
  ) {
    exact.history.delete(); // the shape is released by the feature arena (occtArena.ts)
  } else if (exact) {
    // OCCT's offset history does not report the moved faces as modified: find
    // each on its offset surface (it keeps the moved face's key, like push/pull).
    const moved = new Map<number, string>();
    for (const r of resolved) {
      const index = offsetFaceIndex(r.geom, geoms, Math.abs(d));
      if (index >= 0) moved.set(index, baseFaceKey(r.geom.key));
    }
    applyExact(kit, body, exact, feature.id, ctx, (index) => moved.get(index));
    return;
  }
  const slabs = resolved.map((r, i) => offsetSlab(kit, feature.id, i, r, d));
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

function checkOffsetFits(kit: FeatureKit, r: ResolvedFace, d: number): void {
  if (r.geom.id.type === 'cylinder' && !r.geom.id.convex && d >= r.geom.id.radius - 1e-6) {
    kit.fail(`Offset of ${fmt(d)} mm closes the hole (radius ${fmt(r.geom.id.radius)} mm)`);
  }
  if (r.geom.id.type === 'cylinder' && r.geom.id.convex && -d >= r.geom.id.radius - 1e-6) {
    kit.fail(
      `Offset of ${fmt(d)} mm removes the whole round face (radius ${fmt(r.geom.id.radius)} mm)`,
    );
  }
}

// ---- Delete Face -------------------------------------------------------------------

const DELETE_FACE_LIMIT =
  'Delete Face can remove holes, and fillets or chamfers between two planar faces. ' +
  "Other faces need OCCT's general defeaturing (BRepAlgoAPI_Defeaturing), which is not part of this kernel build";
const DEFEATURE_LIMIT =
  'Delete Face could not remove this face: the neighbouring faces cannot be extended to close the gap ' +
  '(OCCT defeaturing failed), and it is not a hole, fillet or chamfer';

export function applyDeleteFace(
  feature: DeleteFaceFeature,
  ctx: ReplayContextLike,
  kit: FeatureKit,
): void {
  const { body, resolved } = facesOfOneBody(kit, ctx, feature.faces);
  // HimmelCAD OCCT build: general defeaturing (the neighbours grow over the gap).
  const exact = defeatureWithHistory(
    kit.oc,
    body.shape,
    resolved.map((r) => r.face),
  );
  if (exact) {
    applyExact(kit, body, exact, feature.id, ctx);
    const removedKeys = resolved.map((r) => baseFaceKey(r.geom.key));
    if (body.faces.some((f) => removedKeys.includes(baseFaceKey(f.key)))) {
      kit.fail('Delete Face failed: the face could not be healed away');
    }
    return;
  }
  const limit = occtExtras(kit.oc) ? DEFEATURE_LIMIT : DELETE_FACE_LIMIT;
  const fills: Tool[] = [];
  const removals: Tool[] = [];
  resolved.forEach((r, i) => {
    const patch = healingPatch(kit, body, r, limit);
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
  limit: string,
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
    if (!(t1 - t0 > 1e-6)) kit.fail(limit);
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
    if (straight.length !== 2) kit.fail(limit);
    const planes = straight.map(neighbourPlaneAcross);
    if (planes.some((p) => p === null)) kit.fail(limit);
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
  kit.fail(limit);
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
