/**
 * Move Edge and Move Face in any direction (Shapr3D Move/Rotate on edges
 * and faces; GAP-INVENTORY MOD-16/DIR-03). Kernel part of the direct-edit
 * module, registered by `kernel.ts`.
 *
 * Neither kernel build has a general "replace this face by that surface"
 * operation (`LocOpe`/`BRepFeat` face replacement is not bound and needs
 * healing beyond what OCCT does on its own). Both edits are therefore
 * reduced to OCCT's draft (`BRepOffsetAPI_DraftAngle`, bound in both
 * builds), which replaces planar faces by tilted planes and recomputes the
 * edges and vertices around them exactly:
 *
 * - **Move Edge** — a straight edge between two planar faces: each face
 *   tilts about its *far side* (the line through its boundary point
 *   farthest from the edge, parallel to the edge) so that it passes through
 *   the moved edge. The two tilts together place the edge exactly at
 *   `edge + vector` (the part along the edge changes nothing).
 * - **Move Face** — the part along the normal is Offset Face (re-extended
 *   neighbours on the HimmelCAD build); the part in the face's plane tilts
 *   every planar neighbour that shares a straight edge with the face about
 *   its far side, so it follows the moved edge.
 *
 * Limits (refused with a reason): curved faces or curved shared edges
 * where a tilt is needed; a move past a face's far side; tilts OCCT's draft
 * cannot rebuild (neighbours that would have to change topology).
 */
import { type Vec3 } from '../../foundation/document/document.js';
import type { FeatureOf } from '../../foundation/document/featureKinds.js';
import { baseFaceKey } from '../../foundation/geometry-kernel/naming.js';
import { isValidShape } from '../../foundation/geometry-kernel/occt.js';
import type {
  BodyStateLike,
  FeatureKit,
  ReplayContextLike,
  TopologyLike,
} from '../../foundation/geometry-kernel/features/kit.js';
import { bodyOrFail, sampleEdges } from '../../foundation/geometry-kernel/features/refs.js';
import {
  add,
  cross,
  dot,
  length,
  normalize,
  scale,
  sub,
} from '../../foundation/geometry-kernel/features/rigid.js';
import { draftFaces, type DraftItem } from '../../foundation/geometry-kernel/features/taper.js';
import { offsetResolvedFaces } from './faceEdits.js';

type MoveEdgeFeature = FeatureOf<'moveEdge'>;
type MoveFaceFeature = FeatureOf<'moveFace'>;

/** Moves shorter than this (mm) leave the geometry as it is. */
const NO_MOVE_MM = 1e-6;

/** A straight edge as a line: a point on it and its unit direction. */
interface EdgeLine {
  point: Vec3;
  dir: Vec3;
}

const MESSAGES = {
  add: 'The neighbouring face cannot be tilted to follow this move (OCCT draft refused it); try a smaller move',
  build:
    'The tilted faces do not meet their neighbours any more; try a smaller move, or move a face instead',
  empty: 'The move turns the body inside out; try a smaller move',
  prefix: 'Move failed',
};

/**
 * The draft that tilts planar face `index` of `body` about its far side so
 * that it passes through `edge` moved by `v`; `null` when it need not tilt.
 */
function tiltThrough(
  kit: FeatureKit,
  body: BodyStateLike,
  topology: TopologyLike,
  index: number,
  edge: EdgeLine,
  v: Vec3,
  what: string,
): DraftItem | null {
  const geom = body.faces[index]!;
  if (geom.surface !== 'plane' || !geom.normal) {
    kit.fail(`${what} must be planar to tilt with the move (it is ${geom.surface})`, {
      bodyId: body.id,
      faceKeys: [geom.key],
    });
  }
  const n = geom.normal;
  const e = normalize(edge.dir);
  // In the face, perpendicular to the edge, pointing from the face's interior to the edge.
  let u = normalize(cross(e, n));
  if (dot(sub(edge.point, geom.centroid), u) < 0) u = scale(u, -1);
  const samples = sampleEdges(
    kit,
    (topology.faceEdges[index] ?? []).map((i) => topology.edges[i]!),
  );
  const far = Math.min(...samples.map((p) => dot(sub(p, edge.point), u)));
  const h = -far;
  if (!(h > 1e-6)) kit.fail(`${what} has no far side to tilt about`);
  const hinge = add(edge.point, scale(u, far));
  // Where the moved edge lies relative to the hinge line, in the face's (u, n) plane.
  const a = h + dot(v, u);
  const b = dot(v, n);
  if (Math.abs(b) < NO_MOVE_MM && Math.abs(a - h) < NO_MOVE_MM) return null;
  if (!(a > 1e-3)) {
    kit.fail(`The move goes past the far side of ${what.toLowerCase()}; move less`, {
      bodyId: body.id,
      faceKeys: [geom.key],
    });
  }
  const outward = Math.atan2(b, a);
  if (Math.abs(outward) < 1e-9) return null;
  // A positive draft angle removes material on the pull side (tilts the face inwards).
  return { index, pull: u, neutralPoint: hinge, angle: -outward };
}

function applyTilts(
  kit: FeatureKit,
  ctx: ReplayContextLike,
  body: BodyStateLike,
  items: DraftItem[],
  featureId: string,
): void {
  if (items.length === 0) return;
  const result = draftFaces(
    kit,
    ctx.featureOrder,
    featureId,
    { shape: body.shape, faces: body.faces },
    items,
    MESSAGES,
  );
  if (!isValidShape(kit.oc, result.shape)) {
    kit.fail('The move gives an invalid body (faces would cross); try a smaller move');
  }
  body.shape = result.shape;
  body.faces = result.faces;
  ctx.touch(body.id);
}

function finiteVector(kit: FeatureKit, v: Vec3): Vec3 {
  if (!Array.isArray(v) || v.length !== 3 || !v.every(Number.isFinite)) {
    kit.fail('The move must be a vector of three numbers');
  }
  return [v[0], v[1], v[2]];
}

// ---- Move Edge -------------------------------------------------------------------------

export function applyMoveEdge(
  feature: MoveEdgeFeature,
  ctx: ReplayContextLike,
  kit: FeatureKit,
): void {
  const v = finiteVector(kit, feature.vector);
  const body = bodyOrFail(kit, ctx, feature.edge.bodyId);
  const { topology, indices } = kit.resolveEdges(body, [feature.edge], ctx.warn);
  const index = indices[0]!;
  const geom = topology.edgeGeoms[index]!;
  if (geom.curve !== 'line' || !geom.direction) {
    kit.fail('Only straight edges can be moved', { bodyId: body.id, edgeKeys: [feature.edge.key] });
  }
  const faces = topology.edgeFaces[index] ?? [];
  if (faces.length !== 2) kit.fail('The edge must lie between two faces');
  const line: EdgeLine = { point: geom.midpoint, dir: geom.direction };
  const across = sub(v, scale(line.dir, dot(v, line.dir)));
  if (length(across) < NO_MOVE_MM) return;
  const items = faces
    .map((f, i) =>
      tiltThrough(
        kit,
        body,
        topology,
        f,
        line,
        across,
        i === 0 ? 'The first face' : 'The second face',
      ),
    )
    .filter((item): item is DraftItem => item !== null);
  applyTilts(kit, ctx, body, items, feature.id);
}

// ---- Move Face ---------------------------------------------------------------------------

export function applyMoveFace(
  feature: MoveFaceFeature,
  ctx: ReplayContextLike,
  kit: FeatureKit,
): void {
  const v = finiteVector(kit, feature.vector);
  const body = bodyOrFail(kit, ctx, feature.face.bodyId);
  const first = kit.resolveFace(body, feature.face, ctx.warn);
  if (first.geom.surface !== 'plane' || !first.geom.normal) {
    kit.fail('Only planar faces can be moved sideways; use Offset Face to move a curved face', {
      bodyId: body.id,
      faceKeys: [first.geom.key],
    });
  }
  const n = first.geom.normal;
  const along = dot(v, n);
  const slide = sub(v, scale(n, along));
  const key = baseFaceKey(first.geom.key);
  // The sideways part needs the neighbours' tilts known before the offset moves the edges.
  if (length(slide) >= NO_MOVE_MM) checkSlidable(kit, body, first.topology, first.index, slide);
  if (Math.abs(along) >= NO_MOVE_MM) {
    offsetResolvedFaces(kit, ctx, body, [first], along, feature.id);
  }
  if (length(slide) >= NO_MOVE_MM) slideFace(kit, ctx, body, key, slide, feature.id);
  if (feature.rotation && Math.abs(feature.rotation.angle) >= 1e-9) {
    rotateFace(kit, ctx, body, key, feature.rotation, v, feature.id);
  }
}

/** Largest face rotation, degrees (a face turned onto its neighbours cannot be rebuilt). */
export const MAX_FACE_ROTATION = 80;

/**
 * Turns the planar face `key` by `rotation.angle` degrees about the line
 * through `rotation.point` (moved along with the face by `moved`) along
 * `rotation.axis` (projected into the face's plane); the neighbours are
 * trimmed or extended to meet it (OCCT's draft about that line).
 */
function rotateFace(
  kit: FeatureKit,
  ctx: ReplayContextLike,
  body: BodyStateLike,
  key: string,
  rotation: { point: Vec3; axis: Vec3; angle: number },
  moved: Vec3,
  featureId: string,
): void {
  const { angle } = rotation;
  if (!Number.isFinite(angle) || Math.abs(angle) > MAX_FACE_ROTATION) {
    kit.fail(`A face turns by at most ${MAX_FACE_ROTATION}°`);
  }
  if (![...rotation.point, ...rotation.axis].every(Number.isFinite)) {
    kit.fail('The rotation needs a point and an axis');
  }
  const index = body.faces.findIndex((f) => baseFaceKey(f.key) === key);
  if (index < 0) kit.fail('Move Face failed: the moved face could not be found again');
  const geom = body.faces[index]!;
  const n = geom.normal;
  if (geom.surface !== 'plane' || !n) kit.fail('Only planar faces can be turned');
  // The axis in the face's plane, through the (moved) point dropped onto the plane.
  const raw = sub(rotation.axis, scale(n, dot(rotation.axis, n)));
  if (length(raw) < 1e-6) kit.fail('The rotation axis must lie in the face (not along its normal)');
  const a = normalize(raw);
  const p0 = add(rotation.point, moved);
  const point = sub(p0, scale(n, dot(sub(p0, geom.centroid), n)));
  // Right-hand rotation about `a`: the side `n × a` moves outwards for a positive angle;
  // a positive draft angle tilts that side inwards, so the draft angle is the negative.
  const pull = cross(n, a);
  applyTilts(
    kit,
    ctx,
    body,
    [{ index, pull, neutralPoint: point, angle: (-angle * Math.PI) / 180 }],
    featureId,
  );
}

/** Slides the planar face `key` in its plane: every planar neighbour tilts to follow. */
function slideFace(
  kit: FeatureKit,
  ctx: ReplayContextLike,
  body: BodyStateLike,
  key: string,
  slide: Vec3,
  featureId: string,
): void {
  // The face (moved along its normal, same key) and its edges as they are now.
  const topology = kit.topologyOf(body.shape);
  const index = body.faces.findIndex((f) => baseFaceKey(f.key) === key);
  if (index < 0) kit.fail('Move Face failed: the moved face could not be found again');
  const items: DraftItem[] = [];
  for (const e of topology.faceEdges[index] ?? []) {
    const neighbour = (topology.edgeFaces[e] ?? []).find((f) => f !== index);
    if (neighbour === undefined) continue;
    const g = topology.edgeGeoms[e]!;
    const dir = g.direction;
    if (g.curve !== 'line' || !dir) continue; // checked above: needs no tilt
    const across = sub(slide, scale(dir, dot(slide, dir)));
    if (length(across) < NO_MOVE_MM) continue;
    const item = tiltThrough(
      kit,
      body,
      topology,
      neighbour,
      { point: g.midpoint, dir },
      across,
      'A neighbouring face',
    );
    if (item && !items.some((i) => i.index === item.index)) items.push(item);
  }
  applyTilts(kit, ctx, body, items, featureId);
}

/** Refuses a sideways move a neighbour cannot follow (a curved shared edge across the move). */
function checkSlidable(
  kit: FeatureKit,
  body: BodyStateLike,
  topology: TopologyLike,
  index: number,
  slide: Vec3,
): void {
  for (const e of topology.faceEdges[index] ?? []) {
    const g = topology.edgeGeoms[e]!;
    if (g.curve === 'line' && g.direction) continue;
    kit.fail(
      'Sliding a face needs straight edges with planar neighbours; this face has a curved edge — move it along its normal instead',
      { bodyId: body.id, faceKeys: [body.faces[index]!.key] },
    );
  }
  void slide;
}
