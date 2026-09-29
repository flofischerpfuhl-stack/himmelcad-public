/**
 * Replays a feature list into real B-rep bodies with OCCT (via replicad),
 * names every face/edge (see `naming.ts`) and tessellates the result for the
 * viewport. Runs wherever an initialized OpenCascade instance exists: in the
 * kernel Web Worker (`kernel.worker.ts`) and in Node for tests.
 *
 * Evaluation is a deterministic fold over the features; a failing feature
 * records an error under its id and leaves the bodies exactly as they were
 * before it, and every later feature is still evaluated.
 */
import * as R from 'replicad';

import {
  MIN_FEATURE_SIZE_MM,
  bodyIdFor,
  frameForFace,
  frameForPlane,
  framePoint,
  frameUv,
  profileCenterUv,
  profileOutlineUv,
  profileSizeError,
  type BooleanFeature,
  type ChamferFeature,
  type CurveKind,
  type EdgeRef,
  type ExtrudeFeature,
  type FaceRef,
  type Feature,
  type FilletFeature,
  type MoveFeature,
  type SetAppearanceFeature,
  type ShellFeature,
  type SketchFeature,
  type SketchFrame,
  type SketchProfile,
  type SurfaceKind,
  type Vec3,
} from '../model/document.js';
import {
  GEOMETRY_TOLERANCE,
  assignEdgeKeys,
  assignFaceKeys,
  baseFaceKey,
  cylinderId,
  resolveEdgeRef,
  resolveFaceRef,
  reverseGeom,
  translateGeom,
  type FaceGeom,
  type KeyedFace,
  type KeyedFaceKeys,
  type SurfaceId,
} from './naming.js';
import type { Body, EdgeInfo, EvaluatedSketch, EvaluationResult, FaceInfo } from './types.js';

type OpenCascade = ReturnType<typeof R.getOC>;
type Shape3D = R.Shape3D;

/** Raised for a feature that cannot be evaluated; caught per feature. */
class FeatureError extends Error {}

/**
 * Body appearance colors, assigned by creation order. `[0]` is the neutral
 * light-grey default; the rest are desaturated so none reads as the
 * viewport's selection orange or hover blue (see `viewport/theme.ts`).
 */
const COLOR_PALETTE: readonly string[] = [
  '#B8BCC2',
  '#9AAE9B',
  '#C7AE8E',
  '#AEA6B6',
  '#B79690',
  '#A0B0A6',
  '#C2B79E',
  '#A8A29A',
];

interface BodyState {
  id: string;
  name: string;
  color: string;
  createdBy: string;
  shape: Shape3D;
  /** Keyed descriptors aligned with `shape.faces` order. */
  faces: KeyedFace[];
}

interface Topology {
  faces: R.Face[];
  edges: R.Edge[];
  /** Edge indices per face. */
  faceEdges: number[][];
  /** Face indices per edge. */
  edgeFaces: number[][];
  edgeGeoms: { curve: CurveKind; midpoint: Vec3; length: number; direction: Vec3 | null }[];
}

export interface EvaluatorOptions {
  /** Chordal tessellation tolerance as a fraction of the body diagonal (clamped to [0.005, 0.2] mm). */
  relativeTolerance?: number;
  /** Angular tessellation tolerance in radians. */
  angularTolerance?: number;
}

export interface KernelEvaluator {
  evaluate(features: readonly Feature[]): EvaluationResult;
}

export function createEvaluator(oc: OpenCascade, options: EvaluatorOptions = {}): KernelEvaluator {
  R.setOC(oc);
  const relativeTolerance = options.relativeTolerance ?? 0.0005;
  const angularTolerance = options.angularTolerance ?? 0.15;

  // ---- geometry description ---------------------------------------------------

  function describeFace(face: R.Face): FaceGeom {
    const surface = surfaceKindOf(face.geomType);
    const props = R.measureShapeSurfaceProperties(face);
    const centroid = [...props.centerOfMass] as Vec3;
    const area = props.area;
    props.delete();
    const samplePoint = firstVertexOf(face) ?? centroid;
    const rawNormal = face.normalAt(samplePoint);
    const outward = normalize([rawNormal.x, rawNormal.y, rawNormal.z]);
    rawNormal.delete();
    let id: SurfaceId;
    let normal: Vec3 | null = null;
    const adaptor = new oc.BRepAdaptor_Surface(face.wrapped, false);
    try {
      if (surface === 'plane') {
        normal = outward;
        id = { type: 'plane', normal, offset: dot(normal, samplePoint) };
      } else if (surface === 'cylinder') {
        const cylinder = adaptor.Cylinder();
        const ax = cylinder.Axis();
        const loc = ax.Location();
        const dir = ax.Direction();
        const axis: Vec3 = [dir.X(), dir.Y(), dir.Z()];
        const point: Vec3 = [loc.X(), loc.Y(), loc.Z()];
        const radius = cylinder.Radius();
        for (const o of [loc, dir, ax, cylinder]) o.delete();
        const rel = sub(samplePoint, point);
        const k = dot(rel, normalize(axis));
        const radial = sub(rel, scale(normalize(axis), k));
        id = cylinderId(axis, point, radius, dot(radial, outward) > 0);
      } else {
        id = { type: 'other', kind: surface, centroid, area };
      }
    } finally {
      adaptor.delete();
    }
    return { surface, id, normal, centroid, area };
  }

  function firstVertexOf(face: R.Face): Vec3 | null {
    const edges = face.edges;
    const edge = edges[0];
    if (!edge) return null;
    const p = edge.startPoint;
    const out: Vec3 = [p.x, p.y, p.z];
    p.delete();
    return out;
  }

  function topologyOf(shape: Shape3D): Topology {
    const faces = shape.faces;
    const edges = shape.edges;
    const byHash = new Map<number, number[]>();
    edges.forEach((edge, index) => {
      const list = byHash.get(edge.hashCode) ?? [];
      list.push(index);
      byHash.set(edge.hashCode, list);
    });
    const faceEdges: number[][] = faces.map(() => []);
    const edgeFaces: number[][] = edges.map(() => []);
    faces.forEach((face, faceIndex) => {
      for (const edge of face.edges) {
        const candidates = byHash.get(edge.hashCode) ?? [];
        const match = candidates.find((i) => edges[i]!.isSame(edge));
        if (match === undefined) continue;
        if (!faceEdges[faceIndex]!.includes(match)) faceEdges[faceIndex]!.push(match);
        if (!edgeFaces[match]!.includes(faceIndex)) edgeFaces[match]!.push(faceIndex);
      }
    });
    const edgeGeoms = edges.map((edge) => {
      const curve = curveKindOf(edge.geomType);
      const mid = edge.pointAt(0.5);
      const midpoint: Vec3 = [mid.x, mid.y, mid.z];
      mid.delete();
      let direction: Vec3 | null = null;
      if (curve === 'line') {
        const t = edge.tangentAt(0.5);
        direction = normalize([t.x, t.y, t.z]);
        t.delete();
      }
      return { curve, midpoint, length: edge.length, direction };
    });
    return { faces, edges, faceEdges, edgeFaces, edgeGeoms };
  }

  function neighbourFaces(topology: Topology, faceIndex: number): number[] {
    const out = new Set<number>();
    for (const e of topology.faceEdges[faceIndex] ?? []) {
      for (const f of topology.edgeFaces[e] ?? []) if (f !== faceIndex) out.add(f);
    }
    return [...out];
  }

  function withKeys(geoms: FaceGeom[], keys: KeyedFaceKeys[]): KeyedFace[] {
    return geoms.map((g, i) => ({ ...g, key: keys[i]!.key, aliases: keys[i]!.aliases }));
  }

  // ---- reference resolution ------------------------------------------------------

  function diagonalOf(shape: Shape3D): number {
    const [min, max] = shape.boundingBox.bounds;
    return Math.hypot(max[0] - min[0], max[1] - min[1], max[2] - min[2]);
  }

  function resolveFace(
    body: BodyState,
    ref: FaceRef,
    warn: (message: string) => void,
  ): { face: R.Face; geom: KeyedFace; topology: Topology; index: number } {
    const topology = topologyOf(body.shape);
    const resolvable = body.faces;
    const resolution = resolveFaceRef(ref, resolvable, diagonalOf(body.shape));
    if (!resolution.ok) throw new FeatureError(`${resolution.message} on "${body.name}"`);
    if (resolution.rebound) warn(`Face reference "${ref.key}" was re-bound by geometry`);
    return {
      face: topology.faces[resolution.index]!,
      geom: body.faces[resolution.index]!,
      topology,
      index: resolution.index,
    };
  }

  function resolveEdges(
    body: BodyState,
    refs: readonly EdgeRef[],
    warn: (message: string) => void,
  ): { topology: Topology; indices: number[] } {
    const topology = topologyOf(body.shape);
    const edges = topology.edgeGeoms.map((g, i) => ({ ...g, faceIndices: topology.edgeFaces[i]! }));
    const diagonal = diagonalOf(body.shape);
    const indices = refs.map((ref) => {
      if (ref.bodyId !== body.id) {
        throw new FeatureError('All edges of one feature must belong to the same body');
      }
      const resolution = resolveEdgeRef(ref, edges, body.faces, diagonal);
      if (!resolution.ok) throw new FeatureError(`${resolution.message} on "${body.name}"`);
      if (resolution.rebound) warn(`Edge reference "${ref.key}" was re-bound by geometry`);
      return resolution.index;
    });
    return { topology, indices };
  }

  // ---- feature operations --------------------------------------------------------

  function sketchFrame(
    feature: SketchFeature,
    bodies: Map<string, BodyState>,
    warn: (message: string) => void,
  ): SketchFrame {
    if (feature.plane.kind === 'plane')
      return frameForPlane(feature.plane.plane, feature.plane.offset);
    const ref = feature.plane.face;
    const body = bodies.get(ref.bodyId);
    if (!body) throw new FeatureError(`Missing reference: body "${ref.bodyId}"`);
    const { geom } = resolveFace(body, ref, warn);
    if (geom.surface !== 'plane' || !geom.normal) {
      throw new FeatureError('A sketch needs a planar face');
    }
    return frameForFace(geom.normal, geom.centroid);
  }

  function evaluateSketch(
    feature: SketchFeature,
    bodies: Map<string, BodyState>,
    warn: (message: string) => void,
  ): EvaluatedSketch {
    if (feature.profiles.length === 0) throw new FeatureError('Sketch has no profile');
    for (const profile of feature.profiles) {
      const error = profileSizeError(profile);
      if (error) throw new FeatureError(error);
    }
    const frame = sketchFrame(feature, bodies, warn);
    return {
      featureId: feature.id,
      frame,
      profiles: feature.profiles.map((profile) => {
        const [cu, cv] = profileCenterUv(profile);
        return {
          kind: profile.kind,
          outline: profileOutlineUv(profile).map(([u, v]) => framePoint(frame, u, v)),
          center: framePoint(frame, cu, cv),
        };
      }),
    };
  }

  function profileFace(frame: SketchFrame, profile: SketchProfile): R.Face {
    if (profile.kind === 'rectangle') {
      const points = profileOutlineUv(profile).map(([u, v]) => framePoint(frame, u, v));
      return R.makePolygon(points);
    }
    const center = framePoint(frame, profile.cx, profile.cy);
    return R.makeFace(R.assembleWire([R.makeCircle(profile.radius, center, frame.normal)]));
  }

  /** Extrudes one sketch profile and names the prism's faces (caps by position, sides by profile segment). */
  function extrudeProfile(
    feature: ExtrudeFeature,
    frame: SketchFrame,
    profile: SketchProfile,
    profileIndex: number,
  ): { shape: Shape3D; faces: KeyedFace[] } {
    const face = profileFace(frame, profile);
    const n = frame.normal;
    let base = face;
    let length = feature.distance;
    if (feature.symmetric) {
      base = face.translate(scale(n, -Math.abs(feature.distance)));
      length = 2 * Math.abs(feature.distance);
    }
    const vector = new R.Vector(scale(n, length));
    const shape = R.basicFaceExtrusion(base, vector);
    vector.delete();
    const travel = scale(n, Math.sign(length) || 1);
    const geoms = shape.faces.map(describeFace);
    const caps = geoms
      .map((g, i) => ({ g, i }))
      .filter(({ g }) => g.normal !== null && Math.abs(dot(g.normal, n)) > 1 - 1e-9)
      .sort((a, b) => dot(a.g.centroid, travel) - dot(b.g.centroid, travel));
    const keys = geoms.map((g, i) => {
      if (caps.length === 2 && caps[0]!.i === i) return `${feature.id}:start:${profileIndex}`;
      if (caps.length === 2 && caps[1]!.i === i) return `${feature.id}:end:${profileIndex}`;
      if (profile.kind === 'circle') return `${feature.id}:side:${profileIndex}:0`;
      const uv = frameUv(frame, g.centroid);
      const outline = profileOutlineUv(profile);
      let best = 0;
      let bestDistance = Infinity;
      outline.forEach((p, s) => {
        const q = outline[(s + 1) % outline.length]!;
        const d = Math.hypot((p[0] + q[0]) / 2 - uv.u, (p[1] + q[1]) / 2 - uv.v);
        if (d < bestDistance) {
          bestDistance = d;
          best = s;
        }
      });
      return `${feature.id}:side:${profileIndex}:${best}`;
    });
    return { shape, faces: geoms.map((g, i) => ({ ...g, key: keys[i]!, aliases: [] })) };
  }

  function combine(
    target: BodyState,
    tool: { shape: Shape3D; faces: KeyedFace[] },
    operation: 'join' | 'cut' | 'intersect',
    featureId: string,
    featureOrder: ReadonlyMap<string, number>,
  ): void {
    let result: Shape3D;
    if (operation === 'join') result = target.shape.fuse(tool.shape);
    else if (operation === 'cut') result = target.shape.cut(tool.shape);
    else result = target.shape.intersect(tool.shape);
    const toolFaces = operation === 'cut' ? tool.faces.map(reverseGeom) : tool.faces;
    const geoms = result.faces.map(describeFace);
    const keys = assignFaceKeys(
      geoms,
      [...target.faces, ...toolFaces],
      featureOrder,
      () => `${featureId}:new`,
    );
    target.shape = result;
    target.faces = withKeys(geoms, keys);
  }

  function pickTarget(
    feature: { targetBodyId?: string },
    bodies: Map<string, BodyState>,
    order: string[],
  ): BodyState | null {
    if (feature.targetBodyId !== undefined) {
      const body = bodies.get(feature.targetBodyId);
      if (!body) throw new FeatureError(`Missing reference: body "${feature.targetBodyId}"`);
      return body;
    }
    const last = order[order.length - 1];
    return last ? (bodies.get(last) ?? null) : null;
  }

  function applyExtrude(feature: ExtrudeFeature, ctx: ReplayContext): void {
    if (Math.abs(feature.distance) < MIN_FEATURE_SIZE_MM) {
      throw new FeatureError(
        `Extrude distance must be at least ${MIN_FEATURE_SIZE_MM} mm in magnitude`,
      );
    }
    if (feature.profile.kind === 'face') {
      applyFaceExtrude(feature, feature.profile.face, ctx);
      return;
    }
    const sketchFeature = ctx.sketchFeatures.get(feature.profile.featureId);
    const sketch = ctx.sketches.get(feature.profile.featureId);
    if (!sketchFeature || !sketch) {
      throw new FeatureError(`Missing reference: sketch "${feature.profile.featureId}"`);
    }
    const indices =
      feature.profile.profileIndex !== undefined
        ? [feature.profile.profileIndex]
        : sketchFeature.profiles.map((_, i) => i);
    let tool: { shape: Shape3D; faces: KeyedFace[] } | null = null;
    for (const index of indices) {
      const profile = sketchFeature.profiles[index];
      if (!profile)
        throw new FeatureError(`Missing reference: profile ${index} of "${sketchFeature.name}"`);
      const prism = extrudeProfile(feature, sketch.frame, profile, index);
      if (!tool) {
        tool = prism;
      } else {
        const fused: Shape3D = tool.shape.fuse(prism.shape);
        const geoms: FaceGeom[] = fused.faces.map(describeFace);
        const keys: KeyedFaceKeys[] = assignFaceKeys(
          geoms,
          [...tool.faces, ...prism.faces],
          ctx.featureOrder,
          () => `${feature.id}:new`,
        );
        tool = { shape: fused, faces: withKeys(geoms, keys) };
      }
    }
    if (!tool) throw new FeatureError('Nothing to extrude');

    const target = feature.operation === 'new' ? null : pickTarget(feature, ctx.bodies, ctx.order);
    if (feature.operation === 'cut') {
      if (!target) throw new FeatureError('Nothing to cut: the document has no body');
      combine(target, tool, 'cut', feature.id, ctx.featureOrder);
      ctx.touch(target.id);
      return;
    }
    if (feature.operation === 'join' && target) {
      combine(target, tool, 'join', feature.id, ctx.featureOrder);
      ctx.touch(target.id);
      return;
    }
    const id = bodyIdFor(feature.id);
    const created = ctx.createdCount;
    ctx.bodies.set(id, {
      id,
      name: feature.resultBodyName ?? `Body ${created + 1}`,
      color: COLOR_PALETTE[created % COLOR_PALETTE.length]!,
      createdBy: feature.id,
      shape: tool.shape,
      faces: tool.faces,
    });
    ctx.createdCount += 1;
    ctx.order.push(id);
  }

  /** Shapr3D-style push/pull of a planar face: positive distance joins, negative cuts. */
  function applyFaceExtrude(feature: ExtrudeFeature, ref: FaceRef, ctx: ReplayContext): void {
    const body = ctx.bodies.get(ref.bodyId);
    if (!body) throw new FeatureError(`Missing reference: body "${ref.bodyId}"`);
    const { face, geom, topology, index } = resolveFace(body, ref, ctx.warn);
    if (geom.surface !== 'plane' || !geom.normal) {
      throw new FeatureError('Only planar faces can be extruded');
    }
    const n = geom.normal;
    const vector = new R.Vector(scale(n, feature.distance));
    const prismShape = R.basicFaceExtrusion(face.clone(), vector);
    vector.delete();
    const faceEdgeKeys = assignEdgeKeys(
      topology.edgeFaces.map((faces, i) => ({
        faceIndices: faces,
        midpoint: topology.edgeGeoms[i]!.midpoint,
      })),
      body.faces.map((f) => f.key),
    );
    const sourceEdges = (topology.faceEdges[index] ?? [])
      .map((e) => ({ key: faceEdgeKeys[e]!, midpoint: topology.edgeGeoms[e]!.midpoint }))
      .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
    const travel = scale(n, Math.sign(feature.distance));
    const geoms = prismShape.faces.map(describeFace);
    const caps = geoms
      .map((g, i) => ({ g, i }))
      .filter(({ g }) => g.normal !== null && Math.abs(dot(g.normal, n)) > 1 - 1e-9)
      .sort((a, b) => dot(a.g.centroid, travel) - dot(b.g.centroid, travel));
    const keys = geoms.map((g, i) => {
      if (caps.length === 2 && caps[0]!.i === i) return `${feature.id}:start:0`;
      // The moved face keeps its identity (and so do references to it).
      if (caps.length === 2 && caps[1]!.i === i) return baseFaceKey(geom.key);
      let best = 0;
      let bestDistance = Infinity;
      sourceEdges.forEach((edge, s) => {
        const d = distance(edge.midpoint, g.centroid);
        if (d < bestDistance) {
          bestDistance = d;
          best = s;
        }
      });
      return `${feature.id}:side:0:${best}`;
    });
    const tool = {
      shape: prismShape,
      faces: geoms.map((g, i) => ({ ...g, key: keys[i]!, aliases: [] })),
    };
    combine(body, tool, feature.distance > 0 ? 'join' : 'cut', feature.id, ctx.featureOrder);
    ctx.touch(body.id);
  }

  function applyBlend(feature: FilletFeature | ChamferFeature, ctx: ReplayContext): void {
    const size = feature.kind === 'fillet' ? feature.radius : feature.distance;
    if (!(size >= MIN_FEATURE_SIZE_MM / 10)) {
      throw new FeatureError(
        `${feature.kind === 'fillet' ? 'Radius' : 'Distance'} must be positive`,
      );
    }
    if (feature.edges.length === 0) throw new FeatureError('Select at least one edge');
    const bodyId = feature.edges[0]!.bodyId;
    const body = ctx.bodies.get(bodyId);
    if (!body) throw new FeatureError(`Missing reference: body "${bodyId}"`);
    const { topology, indices } = resolveEdges(body, feature.edges, ctx.warn);
    const selected = indices.map((i) => topology.edges[i]!);
    const edgeFaceKeys = indices.map((i) =>
      (topology.edgeFaces[i] ?? []).map((f) => body.faces[f]!),
    );
    const pick = (edge: R.Edge): number | null =>
      selected.some((s) => s.isSame(edge)) ? size : null;
    let result: Shape3D;
    try {
      result = feature.kind === 'fillet' ? body.shape.fillet(pick) : body.shape.chamfer(pick);
    } catch (error) {
      throw new FeatureError(
        `${feature.kind === 'fillet' ? 'Fillet' : 'Chamfer'} failed: ${describeError(error)}`,
      );
    }
    const resultTopology = topologyOf(result);
    const geoms = resultTopology.faces.map(describeFace);
    const role = feature.kind === 'fillet' ? 'round' : 'chamfer';
    const keys = assignFaceKeys(geoms, body.faces, ctx.featureOrder, (index, provisional) => {
      const neighbours = neighbourFaces(resultTopology, index)
        .map((f) => provisional[f])
        .filter((k): k is KeyedFaceKeys => k !== null);
      const has = (face: KeyedFace): boolean =>
        neighbours.some(
          (k) => k.key === baseFaceKey(face.key) || k.aliases.includes(baseFaceKey(face.key)),
        );
      const edgeIndex = edgeFaceKeys.findIndex(
        (faces) => faces.length === 2 && faces.every((f) => has(f)),
      );
      return edgeIndex >= 0 ? `${feature.id}:${role}:${edgeIndex}` : `${feature.id}:new`;
    });
    body.shape = result;
    body.faces = withKeys(geoms, keys);
    ctx.touch(body.id);
  }

  function applyShell(feature: ShellFeature, ctx: ReplayContext): void {
    if (!(feature.thickness >= MIN_FEATURE_SIZE_MM)) {
      throw new FeatureError(`Shell thickness must be at least ${MIN_FEATURE_SIZE_MM} mm`);
    }
    const body = ctx.bodies.get(feature.bodyId);
    if (!body) throw new FeatureError(`Missing reference: body "${feature.bodyId}"`);
    if (feature.faces.length === 0) throw new FeatureError('Select at least one face to open');
    const removed = feature.faces.map((ref) => {
      if (ref.bodyId !== body.id)
        throw new FeatureError('Shell faces must belong to the shelled body');
      return resolveFace(body, ref, ctx.warn).face;
    });
    let result: Shape3D;
    try {
      result = body.shape.shell(feature.thickness, (finder) =>
        finder.when(({ element }) => removed.some((face) => face.isSame(element))),
      );
    } catch (error) {
      throw new FeatureError(`Shell failed: ${describeError(error)}`);
    }
    const geoms = result.faces.map(describeFace);
    const t = feature.thickness;
    const keys = assignFaceKeys(geoms, body.faces, ctx.featureOrder, (index) => {
      const g = geoms[index]!;
      const original = body.faces.find((f) => isOffsetOf(g.id, f.id, t));
      return original ? `${feature.id}:inner:${baseFaceKey(original.key)}` : `${feature.id}:new`;
    });
    body.shape = result;
    body.faces = withKeys(geoms, keys);
    ctx.touch(body.id);
  }

  function applyBoolean(feature: BooleanFeature, ctx: ReplayContext): void {
    const target = ctx.bodies.get(feature.targetBodyId);
    if (!target) throw new FeatureError(`Missing reference: body "${feature.targetBodyId}"`);
    if (feature.toolBodyIds.length === 0) throw new FeatureError('Select at least one tool body');
    const tools = feature.toolBodyIds.map((id) => {
      if (id === target.id) throw new FeatureError('A body cannot be combined with itself');
      const body = ctx.bodies.get(id);
      if (!body) throw new FeatureError(`Missing reference: body "${id}"`);
      return body;
    });
    const operation =
      feature.operation === 'union'
        ? 'join'
        : feature.operation === 'subtract'
          ? 'cut'
          : 'intersect';
    for (const tool of tools) {
      combine(target, tool, operation, feature.id, ctx.featureOrder);
    }
    for (const tool of tools) {
      ctx.bodies.delete(tool.id);
      ctx.order.splice(ctx.order.indexOf(tool.id), 1);
    }
    ctx.touch(target.id);
  }

  function applyMove(feature: MoveFeature, ctx: ReplayContext): void {
    const body = ctx.bodies.get(feature.bodyId);
    if (!body) throw new FeatureError(`Missing reference: body "${feature.bodyId}"`);
    const delta: Vec3 = [feature.dx, feature.dy, feature.dz];
    const moved = body.faces.map((f) => translateGeom(f, delta));
    const result = body.shape.clone().translate(delta);
    const geoms = result.faces.map(describeFace);
    const keys = assignFaceKeys(geoms, moved, ctx.featureOrder, () => `${feature.id}:new`);
    body.shape = result;
    body.faces = withKeys(geoms, keys);
    ctx.touch(body.id);
  }

  function applyAppearance(feature: SetAppearanceFeature, ctx: ReplayContext): void {
    const body = ctx.bodies.get(feature.bodyId);
    if (!body) throw new FeatureError(`Missing reference: body "${feature.bodyId}"`);
    body.color = feature.color;
  }

  // ---- output ------------------------------------------------------------------

  function toBody(state: BodyState): { body: Body; triangles: number } {
    const shape = state.shape;
    const topology = topologyOf(shape);
    const [min, max] = shape.boundingBox.bounds as [Vec3, Vec3];
    const diagonal = Math.hypot(max[0] - min[0], max[1] - min[1], max[2] - min[2]);
    const tolerance = Math.min(0.2, Math.max(0.005, diagonal * relativeTolerance));
    const mesh = shape.mesh({ tolerance, angularTolerance });
    const edgeMesh = shape.meshEdges({ tolerance, angularTolerance });

    const faceByHash = new Map<number, number[]>();
    topology.faces.forEach((face, i) => {
      const list = faceByHash.get(face.hashCode) ?? [];
      list.push(i);
      faceByHash.set(face.hashCode, list);
    });
    const edgeByHash = new Map<number, number[]>();
    topology.edges.forEach((edge, i) => {
      const list = edgeByHash.get(edge.hashCode) ?? [];
      list.push(i);
      edgeByHash.set(edge.hashCode, list);
    });

    const faceKeys = state.faces.map((f) => f.key);
    const edgeKeys = assignEdgeKeys(
      topology.edgeFaces.map((faces, i) => ({
        faceIndices: faces,
        midpoint: topology.edgeGeoms[i]!.midpoint,
      })),
      faceKeys,
    );

    const triangleCount = mesh.triangles.length / 3;
    const triangleFaces = new Uint32Array(triangleCount);
    const faceRange = new Map<number, { start: number; count: number }>();
    const usedFaces = new Set<number>();
    for (const group of mesh.faceGroups) {
      const faceIndex = takeUnused(faceByHash.get(group.faceId), usedFaces);
      if (faceIndex === null) continue;
      const start = group.start / 3;
      const count = group.count / 3;
      faceRange.set(faceIndex, { start, count });
      triangleFaces.fill(faceIndex, start, start + count);
    }

    const segmentsByEdge = new Map<number, Float32Array>();
    const usedEdges = new Set<number>();
    for (const group of edgeMesh.edgeGroups) {
      const edgeIndex = takeUnused(edgeByHash.get(group.edgeId), usedEdges);
      if (edgeIndex === null) continue;
      segmentsByEdge.set(
        edgeIndex,
        Float32Array.from(edgeMesh.lines.slice(group.start * 3, (group.start + group.count) * 3)),
      );
    }

    const faces: FaceInfo[] = state.faces.map((f, i) => ({
      key: f.key,
      aliases: f.aliases,
      surface: f.surface,
      normal: f.normal,
      centroid: f.centroid,
      area: f.area,
      triangleStart: faceRange.get(i)?.start ?? 0,
      triangleCount: faceRange.get(i)?.count ?? 0,
      edgeIndices: topology.faceEdges[i] ?? [],
      adjacentFaces: neighbourFaces(topology, i).length,
    }));
    const edges: EdgeInfo[] = topology.edgeGeoms.map((g, i) => ({
      key: edgeKeys[i]!,
      faceIndices: topology.edgeFaces[i] ?? [],
      curve: g.curve,
      midpoint: g.midpoint,
      length: g.length,
      direction: g.direction,
      segments: segmentsByEdge.get(i) ?? new Float32Array(0),
    }));

    const analyzer = new oc.BRepCheck_Analyzer(shape.wrapped, true, false, false);
    const valid = analyzer.IsValid();
    analyzer.delete();

    return {
      triangles: triangleCount,
      body: {
        id: state.id,
        name: state.name,
        color: state.color,
        createdBy: state.createdBy,
        min: [min[0], min[1], min[2]],
        max: [max[0], max[1], max[2]],
        volume: R.measureVolume(shape),
        valid,
        mesh: {
          positions: Float32Array.from(mesh.vertices),
          normals: Float32Array.from(mesh.normals),
          indices: Uint32Array.from(mesh.triangles),
          triangleFaces,
        },
        faces,
        edges,
      },
    };
  }

  interface ReplayContext {
    bodies: Map<string, BodyState>;
    order: string[];
    sketches: Map<string, EvaluatedSketch>;
    sketchFeatures: Map<string, SketchFeature>;
    featureOrder: ReadonlyMap<string, number>;
    createdCount: number;
    warn: (message: string) => void;
    touch: (bodyId: string) => void;
  }

  return {
    evaluate(features) {
      const t0 = now();
      const errors: Record<string, string> = {};
      const warnings: Record<string, string> = {};
      const featureOrder = new Map(features.map((f, i) => [f.id, i]));
      let currentId = '';
      const ctx: ReplayContext = {
        bodies: new Map(),
        order: [],
        sketches: new Map(),
        sketchFeatures: new Map(),
        featureOrder,
        createdCount: 0,
        warn: (message) => {
          warnings[currentId] = warnings[currentId]
            ? `${warnings[currentId]}; ${message}`
            : message;
        },
        // "Most recently changed body" is the default join/cut target.
        touch: (bodyId) => {
          const index = ctx.order.indexOf(bodyId);
          if (index >= 0) {
            ctx.order.splice(index, 1);
            ctx.order.push(bodyId);
          }
        },
      };
      const creationOrder: string[] = [];

      for (const feature of features) {
        if (feature.suppressed) continue;
        currentId = feature.id;
        const snapshot = snapshotBodies(ctx.bodies);
        try {
          switch (feature.kind) {
            case 'sketch':
              ctx.sketches.set(feature.id, evaluateSketch(feature, ctx.bodies, ctx.warn));
              ctx.sketchFeatures.set(feature.id, feature);
              break;
            case 'extrude':
              applyExtrude(feature, ctx);
              break;
            case 'fillet':
            case 'chamfer':
              applyBlend(feature, ctx);
              break;
            case 'shell':
              applyShell(feature, ctx);
              break;
            case 'boolean':
              applyBoolean(feature, ctx);
              break;
            case 'move':
              applyMove(feature, ctx);
              break;
            case 'setAppearance':
              applyAppearance(feature, ctx);
              break;
          }
        } catch (error) {
          errors[feature.id] = error instanceof FeatureError ? error.message : describeError(error);
          restoreBodies(ctx, snapshot);
        }
        for (const id of ctx.order) if (!creationOrder.includes(id)) creationOrder.push(id);
      }

      const t1 = now();
      const bodies: Body[] = [];
      let triangles = 0;
      for (const id of creationOrder) {
        const state = ctx.bodies.get(id);
        if (!state) continue;
        try {
          const out = toBody(state);
          bodies.push(out.body);
          triangles += out.triangles;
        } catch (error) {
          errors[state.createdBy] = `Tessellation failed: ${describeError(error)}`;
        }
      }
      const t2 = now();
      return {
        bodies,
        sketches: [...ctx.sketches.values()],
        errors,
        warnings,
        stats: { modelMs: t1 - t0, tessellateMs: t2 - t1, triangles },
      };
    },
  };

  function describeError(error: unknown): string {
    if (error instanceof Error) return error.message;
    if (typeof error === 'number') {
      try {
        const message = (
          oc as unknown as { getExceptionMessage?: (e: number) => unknown }
        ).getExceptionMessage?.(error);
        if (Array.isArray(message)) return `OCCT ${message.filter(Boolean).join(': ')}`;
        if (typeof message === 'string' && message) return `OCCT ${message}`;
      } catch {
        // fall through
      }
      return 'OCCT raised an exception';
    }
    return String(error);
  }
}

interface BodiesSnapshot {
  entries: [string, { shape: Shape3D; faces: KeyedFace[]; color: string }][];
}

function snapshotBodies(bodies: Map<string, BodyState>): BodiesSnapshot {
  return {
    entries: [...bodies.entries()].map(([id, b]) => [
      id,
      { shape: b.shape, faces: b.faces, color: b.color },
    ]),
  };
}

/** Restores bodies after a failed feature: operations never mutate an input shape in place. */
function restoreBodies(
  ctx: { bodies: Map<string, BodyState>; order: string[] },
  snapshot: BodiesSnapshot,
): void {
  const keep = new Set(snapshot.entries.map(([id]) => id));
  for (const id of [...ctx.bodies.keys()]) {
    if (!keep.has(id)) {
      ctx.bodies.delete(id);
      const index = ctx.order.indexOf(id);
      if (index >= 0) ctx.order.splice(index, 1);
    }
  }
  for (const [id, saved] of snapshot.entries) {
    const body = ctx.bodies.get(id);
    if (body) Object.assign(body, saved);
  }
}

function takeUnused(candidates: number[] | undefined, used: Set<number>): number | null {
  for (const c of candidates ?? []) {
    if (!used.has(c)) {
      used.add(c);
      return c;
    }
  }
  return null;
}

function isOffsetOf(inner: SurfaceId, outer: SurfaceId, thickness: number): boolean {
  const tol = GEOMETRY_TOLERANCE * 10;
  if (inner.type === 'plane' && outer.type === 'plane') {
    // Inner wall faces the cavity: opposite normal, moved `thickness` inwards.
    return (
      dot(inner.normal, outer.normal) < -1 + 1e-7 &&
      Math.abs(-inner.offset - (outer.offset - thickness)) < tol
    );
  }
  if (inner.type === 'cylinder' && outer.type === 'cylinder') {
    return (
      inner.convex !== outer.convex &&
      Math.abs(Math.abs(inner.radius - outer.radius) - thickness) < tol &&
      Math.abs(dot(inner.axis, outer.axis)) > 1 - 1e-7 &&
      distance(inner.point, outer.point) < tol
    );
  }
  return false;
}

function surfaceKindOf(type: R.SurfaceType): SurfaceKind {
  switch (type) {
    case 'PLANE':
      return 'plane';
    case 'CYLINDRE':
      return 'cylinder';
    case 'CONE':
      return 'cone';
    case 'SPHERE':
      return 'sphere';
    case 'TORUS':
      return 'torus';
    default:
      return 'other';
  }
}

function curveKindOf(type: R.CurveType): CurveKind {
  switch (type) {
    case 'LINE':
      return 'line';
    case 'CIRCLE':
      return 'circle';
    case 'ELLIPSE':
      return 'ellipse';
    default:
      return 'other';
  }
}

function now(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}

function dot(a: Vec3, b: Vec3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

function sub(a: Vec3, b: Vec3): Vec3 {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}

function scale(a: Vec3, k: number): Vec3 {
  return [a[0] * k, a[1] * k, a[2] * k];
}

function distance(a: Vec3, b: Vec3): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}

function normalize(v: Vec3): Vec3 {
  const len = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / len, v[1] / len, v[2] / len];
}
