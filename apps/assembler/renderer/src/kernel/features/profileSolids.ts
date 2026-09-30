/**
 * Solids built from profiles — Revolve, Sweep, Loft — with Extrude's
 * New/Join/Cut semantics. Faces are named from OCCT's own generation
 * history (`Generated(edge)` / `GeneratedFace(edge)`, first/last shapes):
 * `<feature>:side:<p>:<entityId>` for the face swept by a boundary piece of
 * sketch region `p` (the extrude naming; a face profile uses the edge index), `:start:<p>` / `:end:<p>` for the caps; a face OCCT does not
 * report falls back to the segment lying on its surface, else `:new`.
 */
import '../occtArena.js';
import * as R from 'replicad';

import {
  MIN_FEATURE_SIZE_MM,
  bodyIdFor,
  type ExtrudeOperation,
  type Vec3,
} from '../../model/document.js';
import type { LoftFeature, RevolveFeature, SweepFeature } from '../../model/features.js';
import { assignFaceKeys, type FaceGeom, type KeyedFace } from '../naming.js';
import { edgePointAt, type RawShape } from '../occt.js';
import type { FeatureKit, ReplayContextLike, Shape3D } from './kit.js';
import {
  bodyOrFail,
  distance,
  listShapes,
  pickTarget,
  profileSections,
  resolveAxis,
  type Line3,
  type ProfileSection,
} from './refs.js';
import { cross, dot, normalize, sub } from './rigid.js';

interface Tool {
  shape: Shape3D;
  faces: KeyedFace[];
}

// ---- Revolve ---------------------------------------------------------------------

export function applyRevolve(
  feature: RevolveFeature,
  ctx: ReplayContextLike,
  kit: FeatureKit,
): void {
  const degrees = feature.angle;
  if (!Number.isFinite(degrees) || Math.abs(degrees) < 0.1 || Math.abs(degrees) > 360) {
    kit.fail('Revolve angle must be between 0.1° and 360°');
  }
  const full = Math.abs(degrees) >= 360 - 1e-9;
  const axis = resolveAxis(kit, ctx, feature.axis);
  const sections = profileSections(kit, ctx, feature.profile);
  const tools = sections.map((section) => {
    checkAxisOutsideProfile(kit, axis, section);
    const dir = degrees < 0 ? negate(axis.dir) : axis.dir;
    const oc = kit.oc;
    const p = new oc.gp_Pnt(axis.point[0], axis.point[1], axis.point[2]);
    const d = new oc.gp_Dir(dir[0], dir[1], dir[2]);
    const ax = new oc.gp_Ax1(p, d);
    let builder: InstanceType<typeof oc.BRepPrimAPI_MakeRevol>;
    try {
      builder = full
        ? new oc.BRepPrimAPI_MakeRevol(section.face.wrapped, ax, false)
        : new oc.BRepPrimAPI_MakeRevol(
            section.face.wrapped,
            ax,
            (Math.abs(degrees) * Math.PI) / 180,
            false,
          );
    } catch (error) {
      kit.fail(`Revolve failed: ${kit.describeError(error)}`);
    } finally {
      for (const o of [ax, d, p]) o.delete();
    }
    try {
      const shape = asSolid(kit, castRaw(builder.Shape()), 'Revolve');
      const first = full ? null : safeShape(() => builder.FirstShape());
      const last = full ? null : safeShape(() => builder.LastShape());
      return nameGenerated(kit, feature.id, shape, section, {
        generated: (edge) => listShapes(kit, builder.Generated(edge.wrapped)),
        first,
        last,
      });
    } finally {
      builder.delete();
    }
  });
  finishProfileSolid(kit, ctx, feature, fuseTools(kit, ctx, feature.id, tools), 'Revolve');
}

/** replicad wrapper of a raw builder result (the raw handle is deleted). */
function castRaw(raw: RawShape): R.AnyShape {
  try {
    return R.cast(raw as never);
  } finally {
    raw.delete();
  }
}

/**
 * A profile point `p` moves with velocity `dir × (p − point)`; its component
 * along the profile normal, `(p − point) · (n × dir)`, is linear in `p`. If
 * it changes sign inside the profile, part of the profile sweeps back
 * through space it already swept: a self-intersecting (invalid) solid. For
 * an axis in the sketch plane that is "the profile crosses the axis"; for an
 * axis parallel to or oblique to the plane it is the line of the plane that
 * the axis passes over (fuzzer finding F2, `assembler/ROBUSTNESS.md`: such
 * revolves used to give an invalid body without an error).
 */
function checkAxisOutsideProfile(kit: FeatureKit, axis: Line3, section: ProfileSection): void {
  const n = section.normal;
  const inPlane =
    Math.abs(dot(axis.dir, n)) < 1e-6 && Math.abs(dot(sub(axis.point, section.center), n)) < 1e-6;
  const across = cross(n, axis.dir);
  if (Math.hypot(across[0], across[1], across[2]) < 1e-6) {
    kit.fail('The revolve axis must not be perpendicular to the profile');
  }
  const side = normalize(across);
  let min = Infinity;
  let max = -Infinity;
  for (const p of section.outline) {
    const s = dot(sub(p, axis.point), side);
    min = Math.min(min, s);
    max = Math.max(max, s);
  }
  const tol = 1e-6;
  if (min < -tol && max > tol) {
    kit.fail(
      inPlane
        ? 'The profile crosses the revolve axis'
        : 'The profile would revolve through itself (the axis passes over it); move the axis beside the profile or into the sketch plane',
    );
  }
  if (inPlane && Math.max(Math.abs(min), Math.abs(max)) < tol) {
    kit.fail('The profile lies on the axis');
  }
}

// ---- Sweep -----------------------------------------------------------------------

export function applySweep(feature: SweepFeature, ctx: ReplayContextLike, kit: FeatureKit): void {
  const spine = sweepPath(kit, ctx, feature);
  const sections = profileSections(kit, ctx, feature.profile);
  const tools = sections.map((section) => {
    const oc = kit.oc;
    const wire = outerWire(kit, section.face);
    const builder = new oc.BRepOffsetAPI_MakePipeShell(spine.wrapped);
    try {
      builder.SetMode(false);
      builder.Add(wire.wrapped, false, false);
      builder.Build();
      if (!builder.IsDone()) kit.fail('Sweep failed: the profile cannot follow this path');
      builder.MakeSolid();
      const shape = asSolid(kit, castRaw(builder.Shape()), 'Sweep');
      return nameGenerated(kit, feature.id, shape, section, {
        generated: (edge) => listShapes(kit, builder.Generated(edge.wrapped)),
        first: safeShape(() => builder.FirstShape()),
        last: safeShape(() => builder.LastShape()),
      });
    } catch (error) {
      if (kit.isFailure(error)) throw error;
      kit.fail(`Sweep failed: ${kit.describeError(error)}`);
    } finally {
      builder.delete();
    }
  });
  finishProfileSolid(kit, ctx, feature, fuseTools(kit, ctx, feature.id, tools), 'Sweep');
}

function sweepPath(kit: FeatureKit, ctx: ReplayContextLike, feature: SweepFeature): R.Wire {
  const path = feature.path;
  if (path.kind === 'line') {
    if (distance(path.start, path.end) < MIN_FEATURE_SIZE_MM) {
      kit.fail(`The sweep path must be at least ${MIN_FEATURE_SIZE_MM} mm long`);
    }
    return R.assembleWire([R.makeLine(path.start, path.end)]);
  }
  if (path.kind === 'sketch') {
    const [section] = profileSections(kit, ctx, {
      kind: 'sketch',
      featureId: path.featureId,
      regions: [path.region],
    });
    return outerWire(kit, section!.face);
  }
  if (path.edges.length === 0) kit.fail('Select at least one path edge');
  const bodyId = path.edges[0]!.bodyId;
  if (path.edges.some((e) => e.bodyId !== bodyId)) kit.fail('Path edges must belong to one body');
  const body = bodyOrFail(kit, ctx, bodyId);
  const { topology, indices } = kit.resolveEdges(body, path.edges, ctx.warn);
  const edges = chainEdges(
    kit,
    indices.map((i) => topology.edges[i]!.clone()),
  );
  try {
    return R.assembleWire(edges);
  } catch (error) {
    kit.fail(`Path edges must form one connected chain (${kit.describeError(error)})`);
  }
}

/** Orders edges into a connected chain (endpoint to endpoint). */
function chainEdges(kit: FeatureKit, edges: R.Edge[]): R.Edge[] {
  if (edges.length < 2) return edges;
  const ends = edges.map(
    (e) => [edgePointAt(kit.oc, e, 0), edgePointAt(kit.oc, e, 1)] as [Vec3, Vec3],
  );
  const tol = 1e-4;
  const touches = (i: number, j: number) =>
    ends[i]!.some((p) => ends[j]!.some((q) => distance(p, q) < tol));
  // Start at an edge with only one neighbour (an open chain end), else anywhere.
  const degree = edges.map((_, i) => edges.filter((__, j) => j !== i && touches(i, j)).length);
  let current = degree.findIndex((d) => d <= 1);
  if (current < 0) current = 0;
  const order = [current];
  const used = new Set(order);
  while (order.length < edges.length) {
    const next = edges.findIndex((_, j) => !used.has(j) && touches(current, j));
    if (next < 0) kit.fail('Path edges must form one connected chain');
    order.push(next);
    used.add(next);
    current = next;
  }
  return order.map((i) => edges[i]!);
}

// ---- Loft ------------------------------------------------------------------------

export function applyLoft(feature: LoftFeature, ctx: ReplayContextLike, kit: FeatureKit): void {
  if (feature.profiles.length < 2) kit.fail('Select at least two profiles to loft');
  const sections = feature.profiles.map((ref, i) => {
    const found = profileSections(kit, ctx, ref);
    if (found.length !== 1) kit.fail(`Loft profile ${i + 1} must be a single closed profile`);
    return found[0]!;
  });
  for (let i = 1; i < sections.length; i += 1) {
    const a = sections[i - 1]!;
    const b = sections[i]!;
    const parallel = Math.abs(Math.abs(dot(a.normal, b.normal)) - 1) < 1e-9;
    if (parallel && Math.abs(dot(sub(b.center, a.center), a.normal)) < 1e-6) {
      kit.fail(`Loft profiles ${i} and ${i + 1} lie on the same plane`);
    }
  }
  const oc = kit.oc;
  const builder = new oc.BRepOffsetAPI_ThruSections(true, feature.ruled, 1e-6);
  try {
    const wires = sections.map((s) => outerWire(kit, s.face));
    wires.forEach((w) => builder.AddWire(w.wrapped));
    builder.CheckCompatibility(true);
    builder.Build();
    if (!builder.IsDone()) kit.fail('Loft failed: the profiles cannot be connected');
    const shape = asSolid(kit, castRaw(builder.Shape()), 'Loft');
    const first = sections[0]!;
    const tool = nameGenerated(kit, feature.id, shape, first, {
      generated: (edge) => {
        try {
          return [builder.GeneratedFace(edge.wrapped) as RawShape];
        } catch {
          return [];
        }
      },
      first: safeShape(() => builder.FirstShape()),
      last: safeShape(() => builder.LastShape()),
    });
    finishProfileSolid(kit, ctx, feature, tool, 'Loft');
  } catch (error) {
    if (kit.isFailure(error)) throw error;
    kit.fail(`Loft failed: ${kit.describeError(error)}`);
  } finally {
    builder.delete();
  }
}

// ---- shared ------------------------------------------------------------------------

/** Names the faces of a profile-generated solid (see the module comment). */
function nameGenerated(
  kit: FeatureKit,
  featureId: string,
  shape: Shape3D,
  section: ProfileSection,
  history: {
    generated: (edge: R.Edge) => RawShape[];
    first: RawShape | null;
    last: RawShape | null;
  },
): Tool {
  const topology = kit.topologyOf(shape);
  const geoms = kit.describeShape(shape);
  const keys: (string | null)[] = geoms.map(() => null);
  const p = section.profileIndex;
  for (const [raw, role] of [
    [history.first, 'start'],
    [history.last, 'end'],
  ] as const) {
    if (!raw) continue;
    const index = topology.faceIndexOf(raw);
    raw.delete();
    if (index >= 0) keys[index] = `${featureId}:${role}:${p}`;
  }
  for (const { edge, segment } of section.segments) {
    for (const raw of history.generated(edge)) {
      const index = topology.faceIndexOf(raw);
      raw.delete();
      if (index >= 0 && keys[index] === null) keys[index] = `${featureId}:side:${p}:${segment}`;
    }
  }
  // Faces OCCT did not report: the profile segment lying on the face's surface.
  geoms.forEach((g, i) => {
    if (keys[i] !== null) return;
    const segment = section.segments.find((s) => pointOnSurface(g, s.midpoint));
    keys[i] = segment ? `${featureId}:side:${p}:${segment.segment}` : `${featureId}:new`;
  });
  const named = assignFaceKeys(geoms, [], new Map(), (i) => keys[i]!);
  return { shape, faces: kit.withKeys(geoms, named) };
}

function pointOnSurface(g: FaceGeom, p: Vec3): boolean {
  const tol = 1e-4;
  if (g.id.type === 'plane') return Math.abs(dot(g.id.normal, p) - g.id.offset) < tol;
  if (g.id.type === 'cylinder') {
    const rel = sub(p, g.id.point);
    const k = dot(rel, g.id.axis);
    const radial = sub(rel, [g.id.axis[0] * k, g.id.axis[1] * k, g.id.axis[2] * k]);
    return Math.abs(Math.hypot(...radial) - g.id.radius) < tol;
  }
  return false;
}

function fuseTools(
  kit: FeatureKit,
  ctx: ReplayContextLike,
  featureId: string,
  tools: Tool[],
): Tool {
  const first = tools[0];
  if (!first) kit.fail('Nothing to build: the profile is empty');
  const holder = { id: '', name: '', color: '', createdBy: '', ...first };
  for (const next of tools.slice(1)) {
    kit.combine(holder, next, 'join', featureId, ctx.featureOrder);
  }
  return { shape: holder.shape, faces: holder.faces };
}

/** New body, or join/cut into the target body (the extrude rule). */
function finishProfileSolid(
  kit: FeatureKit,
  ctx: ReplayContextLike,
  feature: {
    id: string;
    name: string;
    operation: ExtrudeOperation;
    targetBodyId?: string;
    resultBodyName?: string;
  },
  tool: Tool,
  label: string,
): void {
  const target = feature.operation === 'new' ? null : pickTarget(kit, ctx, feature.targetBodyId);
  if (feature.operation === 'cut') {
    if (!target) kit.fail('Nothing to cut: the document has no body');
    kit.combine(target, tool, 'cut', feature.id, ctx.featureOrder);
    ctx.touch(target.id);
    return;
  }
  if (feature.operation === 'join' && target) {
    kit.combine(target, tool, 'join', feature.id, ctx.featureOrder);
    ctx.touch(target.id);
    return;
  }
  if (feature.operation === 'intersect') {
    if (!target) kit.fail('Nothing to intersect: the document has no body');
    const before = { shape: target.shape, faces: target.faces };
    kit.combine(target, tool, 'intersect', feature.id, ctx.featureOrder);
    if (!(R.measureVolume(target.shape) > 1e-9)) {
      target.shape = before.shape;
      target.faces = before.faces;
      kit.fail(`Intersect: the ${label.toLowerCase()} does not overlap "${target.name}"`);
    }
    ctx.touch(target.id);
    return;
  }
  kit.addBody(ctx, {
    id: bodyIdFor(feature.id),
    // Named after its creating feature ("Revolve 1"), not the global body count.
    name: feature.resultBodyName ?? (feature.name.trim() || label),
    createdBy: feature.id,
    shape: tool.shape,
    faces: tool.faces,
  });
}

function asSolid(kit: FeatureKit, shape: R.AnyShape, label: string): Shape3D {
  if (!('faces' in shape) || !(shape instanceof R.Solid || shape instanceof R.Compound)) {
    kit.fail(`${label} did not produce a solid`);
  }
  const volume = R.measureVolume(shape as Shape3D);
  if (!(volume > 1e-9)) kit.fail(`${label} did not produce a closed solid (self-intersection?)`);
  return shape as Shape3D;
}

function outerWire(kit: FeatureKit, face: R.Face): R.Wire {
  if (wireCount(kit, face) > 1) kit.fail('Profiles with holes are not supported yet');
  // replicad's outerWire() deletes the face it is called on.
  return face.clone().outerWire();
}

/** Number of wires of a face (1 = no holes), without replicad's leaking wire getters. */
function wireCount(kit: FeatureKit, face: R.Face): number {
  const oc = kit.oc;
  const explorer = new oc.TopExp_Explorer(
    face.wrapped as never,
    oc.TopAbs_ShapeEnum.TopAbs_WIRE as never,
    oc.TopAbs_ShapeEnum.TopAbs_SHAPE as never,
  );
  let count = 0;
  try {
    for (; explorer.More(); explorer.Next()) {
      explorer.Current().delete();
      count += 1;
    }
  } finally {
    explorer.delete();
  }
  return count;
}

function safeShape(get: () => unknown): RawShape | null {
  try {
    return (get() as RawShape | null) ?? null;
  } catch {
    return null;
  }
}

function negate(v: Vec3): Vec3 {
  return [-v[0], -v[1], -v[2]];
}
