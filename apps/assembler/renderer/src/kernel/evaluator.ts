/**
 * Replays a feature list into real B-rep bodies with OCCT (via replicad),
 * names every face/edge (see `naming.ts`) and tessellates the result for the
 * viewport. Runs wherever an initialized OpenCascade instance exists: in the
 * kernel Web Worker (`kernel.worker.ts`) and in Node for tests.
 *
 * Evaluation is a deterministic fold over the features; a failing feature
 * records an error under its id and leaves the bodies exactly as they were
 * before it, and every later feature is still evaluated.
 *
 * Incremental (see `evalCache.ts`): the state after every feature is kept
 * as a checkpoint keyed by the hash of the feature prefix, so an evaluation
 * starts from the deepest checkpoint its document shares with an earlier
 * one. Tessellation is incremental per body (an unchanged body shape reuses
 * its mesh) and per face (OCCT keeps each face's triangulation). OCCT
 * objects are released deterministically (`occtArena.ts`), not by the
 * JavaScript garbage collector.
 */
import './occtArena.js';
import * as R from 'replicad';

import {
  MIN_FEATURE_SIZE_MM,
  bodyIdFor,
  frameForFace,
  frameForPlane,
  type BooleanFeature,
  type ChamferFeature,
  type EdgeRef,
  type ExtrudeFeature,
  type FaceRef,
  type Feature,
  type FilletFeature,
  type ImportStepFeature,
  type MoveFeature,
  type SetAppearanceFeature,
  type ShellFeature,
  type SketchFeature,
  type SketchFrame,
  type SurfaceKind,
  type Vec3,
} from '../model/document.js';
import { edgeRuleBodyId, edgeRuleLabel } from '../model/blendOptions.js';
import type { SketchRegion } from '../sketch/regions.js';
import { evaluateSketchGeometry, regionFace, sideFaceKey } from './sketchGeometry.js';
import {
  GEOMETRY_TOLERANCE,
  assignEdgeKeys,
  assignFaceKeys,
  assignFaceKeysFromHistory,
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
import {
  CheckpointCache,
  prefixHashes,
  type BodySnapshot,
  type Checkpoint,
  type CheckpointCacheStats,
} from './evalCache.js';
import {
  blendWithHistory,
  booleanWithHistory,
  buildTopology,
  distanceToShape,
  edgesOf,
  surfaceSample,
  faceOrigins,
  facesOf,
  heapBytes,
  isValidShape,
  meshShapeEdges,
  offsetWithHistory,
  shapeHash,
  shellWithHistory,
  type BlendOptions,
  type HistoryResult,
  type OwnedTopology,
  type RawShape,
  type Topology,
} from './occt.js';
import { closeArena, inArena, isPinned, openArena, pin, release, unpin } from './occtArena.js';
import type {
  Body,
  EdgeInfo,
  EvaluatedSketch,
  EvaluationProgress,
  EvaluationResult,
  FaceInfo,
  FeatureErrorRefs,
  TessellationQuality,
} from './types.js';
import {
  chamferReferenceFaces,
  failingBlendEdges,
  ruleEdgeIndices,
} from './features/blendRules.js';
import { offsetBodyFaces } from './features/faceOps.js';
import { applyModelingFeature, type FeatureKit } from './features/index.js';
import { rebindRegion } from './regionRebind.js';
import { FaceMeshCache } from './tessellate.js';
import { FacePropsCache } from './faceProps.js';
import { KernelFatalError, isFatalKernelError } from './fatal.js';

export { KernelFatalError, isFatalKernelError };
import type { HistorySource } from './occt.js';

type OpenCascade = ReturnType<typeof R.getOC>;
type Shape3D = R.Shape3D;

/** Raised for a feature that cannot be evaluated; caught per feature. */
class FeatureError extends Error {
  constructor(
    message: string,
    /** Geometry the error points at (highlighted in the viewport). */
    readonly refs?: FeatureErrorRefs,
  ) {
    super(message);
  }
}

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
  /** Keyed descriptors aligned with the shape's faces (explorer order). */
  faces: KeyedFace[];
}

/** Tessellation settings per quality: chordal deflection relative to the body diagonal. */
const QUALITY: Record<
  TessellationQuality,
  { relative: number; min: number; max: number; angular: number }
> = {
  final: { relative: 0.0005, min: 0.005, max: 0.2, angular: 0.15 },
  preview: { relative: 0.002, min: 0.02, max: 0.5, angular: 0.35 },
};

export interface EvaluatorOptions {
  /** Chordal tessellation tolerance (final quality) as a fraction of the body diagonal. */
  relativeTolerance?: number;
  /** Angular tessellation tolerance (final quality) in radians. */
  angularTolerance?: number;
  /** Estimated B-rep bytes the checkpoint cache may keep (default 256 MiB). */
  cacheBudgetBytes?: number;
  /** Estimated mesh bytes kept for unchanged bodies (default 128 MiB). */
  meshBudgetBytes?: number;
}

export interface EvaluateOptions {
  /** Tessellation quality: `preview` is coarser (drags), `final` for committed documents. Default `final`. */
  quality?: TessellationQuality;
  /**
   * Keep the checkpoint of the last feature (default: `true` for `final`,
   * `false` for `preview` — a tool's provisional feature is never reused).
   */
  cacheTail?: boolean;
  /** Called before every evaluated feature and before tessellation. */
  onProgress?: (progress: EvaluationProgress) => void;
  /** Record per-phase timings in `stats.phases` (bench/diagnostics). */
  profile?: boolean;
}

export interface KernelCacheInfo extends CheckpointCacheStats {
  meshBytes: number;
  meshes: number;
  /** Faces with cached triangles, and faces meshed/extracted since the evaluator started. */
  faceMeshes: number;
  facesMeshed: number;
  heapBytes: number;
}

export interface KernelEvaluator {
  /**
   * Replays `features` into evaluated bodies. Async because STEP import
   * (`ImportStepFeature`) parses the file through replicad's asynchronous
   * `importSTEP`; every other feature resolves synchronously. Calls are
   * serialized.
   */
  evaluate(features: readonly Feature[], options?: EvaluateOptions): Promise<EvaluationResult>;
  /**
   * Replays `features` and exports the resulting bodies (or a subset, by
   * body id) as one STEP file, one object per body, named and coloured.
   * Uses the exact B-rep, not the tessellated mesh.
   */
  exportStep(features: readonly Feature[], bodyIds?: readonly string[]): Promise<Uint8Array>;
  /** Sizes of the incremental-evaluation caches and of the wasm heap. */
  cacheInfo(): KernelCacheInfo;
  /** Drops every cached checkpoint and mesh (frees their OCCT shapes). */
  clearCache(): void;
}

/** Per-shape derived data, released with the shape. */
interface ShapeInfo {
  topology?: OwnedTopology;
  diagonal?: number;
  valid?: boolean;
  validMode?: 'full' | 'faces' | 'closure';
  volume?: number;
  bounds?: [Vec3, Vec3];
  edgeKeys?: { faces: KeyedFace[]; keys: string[] };
}

interface MeshEntry {
  quality: TessellationQuality;
  faces: KeyedFace[];
  body: Body;
  bytes: number;
  lastUsed: number;
}

export function createEvaluator(oc: OpenCascade, options: EvaluatorOptions = {}): KernelEvaluator {
  R.setOC(oc);
  const quality = {
    ...QUALITY,
    final: {
      ...QUALITY.final,
      relative: options.relativeTolerance ?? QUALITY.final.relative,
      angular: options.angularTolerance ?? QUALITY.final.angular,
    },
  };

  // ---- shape bookkeeping -----------------------------------------------------------

  /** Phase timings of the running evaluation when profiling (see EvaluateOptions.profile). */
  let phases: Record<string, number> | null = null;
  function timed<T>(name: string, run: () => T): T {
    if (!phases) return run();
    const t = now();
    try {
      return run();
    } finally {
      phases[name] = (phases[name] ?? 0) + now() - t;
    }
  }

  const infos = new Map<Shape3D, ShapeInfo>();
  /** Info entries created while the current feature runs (dropped unless their shape is kept). */
  let featureInfos: Shape3D[] = [];
  const meshes = new Map<Shape3D, MeshEntry>();
  let meshBytes = 0;
  let meshClock = 0;
  const meshBudget = (options.meshBudgetBytes ?? 128 * 1024 * 1024) / 2;
  const faceMeshes = new FaceMeshCache(oc, meshBudget);
  const faceProps = new FacePropsCache(oc);
  let meshSerial = 0;
  let facesMeshedTotal = 0;

  function infoOf(shape: Shape3D): ShapeInfo {
    let info = infos.get(shape);
    if (!info) {
      info = {};
      infos.set(shape, info);
      featureInfos.push(shape);
    }
    return info;
  }

  function dropInfo(shape: Shape3D): void {
    const info = infos.get(shape);
    if (!info) return;
    infos.delete(shape);
    info.topology?.dispose();
  }

  function dropMesh(shape: Shape3D): void {
    const entry = meshes.get(shape);
    if (!entry) return;
    meshes.delete(shape);
    meshBytes -= entry.bytes;
  }

  /** Deletes a shape that nothing (no checkpoint, no replay) holds any more. */
  function freeShape(shape: Shape3D): void {
    dropInfo(shape);
    dropMesh(shape);
    unpin((shape as unknown as { _wrapped: object | null })._wrapped);
    release(shape);
  }

  const cache = new CheckpointCache({
    ...(options.cacheBudgetBytes !== undefined ? { budgetBytes: options.cacheBudgetBytes } : {}),
    estimateBytes: (_shape, faces) => estimateShapeBytes(faces.length),
    onFree: freeShape,
  });

  // ---- geometry description ---------------------------------------------------------

  /** Cached topology of shape; 
euseFrom (an operation's inputs) lends descriptions of unchanged edges. */
  function topologyOf(shape: Shape3D, reuseFrom: readonly Shape3D[] = []): Topology {
    const info = infoOf(shape);
    if (!info.topology) {
      const reuse = reuseFrom
        .map((s) => infos.get(s)?.topology)
        .filter((t): t is OwnedTopology => t !== undefined);
      info.topology = timed('topology', () => buildTopology(oc, shape, reuse));
      info.topology.pinAll();
    }
    return info.topology;
  }

  function describeFace(face: R.Face): FaceGeom {
    const surface = surfaceKindOf(face.geomType);
    const props = R.measureShapeSurfaceProperties(face);
    const centroid = [...props.centerOfMass] as Vec3;
    const area = props.area;
    props.delete();
    // A point on the surface and the outward normal there (plane offset, cylinder convexity).
    const { point: samplePoint, normal: outward } = surfaceSample(oc, face);
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

  function describeShape(shape: Shape3D): FaceGeom[] {
    return topologyOf(shape).faces.map(describeFace);
  }

  function neighbourFaces(topology: Topology, faceIndex: number): number[] {
    const out = new Set<number>();
    for (const e of topology.faceEdges[faceIndex] ?? []) {
      for (const f of topology.edgeFaces[e] ?? []) if (f !== faceIndex) out.add(f);
    }
    return [...out];
  }

  function withKeys(geoms: FaceGeom[], keys: KeyedFaceKeys[]): KeyedFace[] {
    return geoms.map((g, i) => ({
      surface: g.surface,
      id: g.id,
      normal: g.normal,
      centroid: g.centroid,
      area: g.area,
      key: keys[i]!.key,
      aliases: keys[i]!.aliases,
    }));
  }

  function boundsOf(shape: Shape3D): [Vec3, Vec3] {
    const info = infoOf(shape);
    info.bounds ??= faceProps.bounds(topologyOf(shape));
    return info.bounds;
  }

  function diagonalOf(shape: Shape3D): number {
    const info = infoOf(shape);
    if (info.diagonal === undefined) {
      const [min, max] = boundsOf(shape);
      info.diagonal = Math.hypot(max[0] - min[0], max[1] - min[1], max[2] - min[2]);
    }
    return info.diagonal;
  }

  /**
   * Result face descriptors and keys of an operation, from OCCT's history
   * (reference scheme v2, `naming.ts#assignFaceKeysFromHistory`). Faces that
   * are identical to an input face reuse its descriptor (no OCCT query).
   */
  function nameResult(
    result: Shape3D,
    op: HistorySource | null,
    inputs: { shape: Shape3D; faces: readonly KeyedFace[]; reversed?: boolean }[],
    featureOrder: ReadonlyMap<string, number>,
    nameNew: (
      index: number,
      provisional: readonly (KeyedFaceKeys | null)[],
      topology: Topology,
    ) => string,
    generators: { raw: RawShape; role: string }[] = [],
  ): KeyedFace[] {
    for (const input of inputs) topologyOf(input.shape);
    const topology = topologyOf(
      result,
      inputs.map((i) => i.shape),
    );
    const inputFaces: KeyedFace[] = [];
    const rawInputs: RawShape[] = [];
    const fallback: KeyedFace[] = [];
    for (const input of inputs) {
      const topo = topologyOf(input.shape);
      topo.faces.forEach((face, i) => {
        const keyed = input.faces[i];
        if (!keyed) return;
        rawInputs.push(face.wrapped as RawShape);
        inputFaces.push(keyed);
        fallback.push(input.reversed ? reverseGeom(keyed) : keyed);
      });
    }
    const origins = timed('history', () => faceOrigins(oc, op, topology, rawInputs, generators));
    const geoms = topology.faces.map((face, j) => {
      const same = origins.identical[j]!;
      if (same >= 0) {
        const input = inputFaces[same]!;
        return origins.flipped[j] ? reverseGeom(input) : input;
      }
      return timed('describe', () => describeFace(face));
    });
    const keys = assignFaceKeysFromHistory(
      geoms,
      inputFaces,
      origins,
      featureOrder,
      (index, provisional) => nameNew(index, provisional, topology),
      fallback,
    );
    return withKeys(geoms, keys);
  }

  // ---- reference resolution ------------------------------------------------------------

  function faceProbe(topology: Topology) {
    return (index: number, point: Vec3): number => {
      const face = topology.faces[index];
      return face ? distanceToShape(oc, point, face) : Infinity;
    };
  }

  function edgeKeysOf(body: BodyState): string[] {
    const info = infoOf(body.shape);
    if (info.edgeKeys && info.edgeKeys.faces === body.faces) return info.edgeKeys.keys;
    const topology = topologyOf(body.shape);
    const keys = assignEdgeKeys(
      topology.edgeFaces.map((faces, i) => ({
        faceIndices: faces,
        midpoint: topology.edgeGeoms[i]!.midpoint,
      })),
      body.faces.map((f) => f.key),
    );
    info.edgeKeys = { faces: body.faces, keys };
    return keys;
  }

  function resolveFace(
    body: BodyState,
    ref: FaceRef,
    warn: (message: string) => void,
  ): { face: R.Face; geom: KeyedFace; topology: Topology; index: number } {
    const topology = topologyOf(body.shape);
    const resolution = resolveFaceRef(ref, body.faces, diagonalOf(body.shape), faceProbe(topology));
    if (!resolution.ok) throw new FeatureError(`${resolution.message} on "${body.name}"`);
    if (resolution.rebound) warn(`Face reference "${ref.key}" was re-bound by geometry`);
    if (resolution.note) warn(resolution.note);
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
    const edgeKeys = edgeKeysOf(body);
    const probe = (index: number, point: Vec3): number => {
      const edge = topology.edges[index];
      return edge ? distanceToShape(oc, point, edge) : Infinity;
    };
    const indices = refs.map((ref) => {
      if (ref.bodyId !== body.id) {
        throw new FeatureError('All edges of one feature must belong to the same body');
      }
      const resolution = resolveEdgeRef(ref, edges, body.faces, diagonal, { edgeKeys, probe });
      if (!resolution.ok) throw new FeatureError(`${resolution.message} on "${body.name}"`);
      if (resolution.rebound) warn(`Edge reference "${ref.key}" was re-bound by geometry`);
      if (resolution.note) warn(resolution.note);
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
  ): { evaluated: EvaluatedSketch; regions: SketchRegion[] } {
    const frame = sketchFrame(feature, bodies, warn);
    try {
      const { evaluated, regions, warnings } = evaluateSketchGeometry(feature, frame);
      for (const message of warnings) warn(message);
      return { evaluated, regions };
    } catch (error) {
      if (isFatalKernelError(error)) throw error;
      throw new FeatureError(`Sketch profiles could not be built: ${describeError(error)}`);
    }
  }

  /** Extrudes one sketch region and names the prism's faces (caps by position, sides by sketch entity). */
  function extrudeProfile(
    feature: ExtrudeFeature,
    frame: SketchFrame,
    region: SketchRegion,
    profileIndex: number,
  ): { shape: Shape3D; faces: KeyedFace[] } {
    if (region.area < MIN_FEATURE_SIZE_MM * MIN_FEATURE_SIZE_MM) {
      throw new FeatureError(`Sketch profile is too small (${region.area.toFixed(4)} mm²)`);
    }
    const face = regionFace(frame, region);
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
    const geoms = describeShape(shape);
    const caps = geoms
      .map((g, i) => ({ g, i }))
      .filter(({ g }) => g.normal !== null && Math.abs(dot(g.normal, n)) > 1 - 1e-9)
      .sort((a, b) => dot(a.g.centroid, travel) - dot(b.g.centroid, travel));
    const shapeFaces = topologyOf(shape).faces;
    const keys = geoms.map((_, i) => {
      if (caps.length === 2 && caps[0]!.i === i) return `${feature.id}:start:${profileIndex}`;
      if (caps.length === 2 && caps[1]!.i === i) return `${feature.id}:end:${profileIndex}`;
      const mid = shapeFaces[i]!.pointOnSurface(0.5, 0.5);
      const point: Vec3 = [mid.x, mid.y, mid.z];
      mid.delete();
      return sideFaceKey(feature.id, profileIndex, frame, region, point);
    });
    return { shape, faces: geoms.map((g, i) => ({ ...g, key: keys[i]!, aliases: [] })) };
  }

  /** Boolean of `tool` into `target` (in place), naming the result from OCCT's history. */
  function combine(
    target: BodyState,
    tool: { shape: Shape3D; faces: KeyedFace[] },
    operation: 'join' | 'cut' | 'intersect',
    featureId: string,
    featureOrder: ReadonlyMap<string, number>,
  ): void {
    const op = operation === 'join' ? 'fuse' : operation === 'cut' ? 'cut' : 'common';
    let built: HistoryResult;
    try {
      built = booleanWithHistory(oc, op, target.shape, tool.shape);
    } catch (error) {
      if (isFatalKernelError(error)) throw error;
      throw new FeatureError(`Boolean failed: ${describeError(error)}`);
    }
    try {
      const faces = nameResult(
        built.shape,
        built.history,
        [
          { shape: target.shape, faces: target.faces },
          { shape: tool.shape, faces: tool.faces, reversed: operation === 'cut' },
        ],
        featureOrder,
        () => `${featureId}:new`,
      );
      target.shape = built.shape;
      target.faces = faces;
    } finally {
      built.history.delete();
    }
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

  /** The detected regions an extrude-like feature reads (with best-effort rebind of redrawn ones). */
  function profileRegions(
    sketchFeature: SketchFeature,
    regions: SketchRegion[],
    keys: readonly string[] | undefined,
    warn: (message: string) => void,
  ): SketchRegion[] {
    if (!keys) return regions;
    const bound = new Set(keys.filter((key) => regions.some((r) => r.key === key)));
    return keys.map((key) => {
      const region = regions.find((r) => r.key === key);
      if (region) return region;
      const rebound = rebindRegion(key, regions, bound, sketchFeature);
      if (!rebound) {
        throw new FeatureError(`Missing reference: profile "${key}" of "${sketchFeature.name}"`);
      }
      bound.add(rebound.region.key);
      warn(rebound.message);
      return rebound.region;
    });
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
    const regions = ctx.sketchRegions.get(feature.profile.featureId);
    if (!sketchFeature || !sketch || !regions) {
      throw new FeatureError(`Missing reference: sketch "${feature.profile.featureId}"`);
    }
    if (regions.length === 0) {
      throw new FeatureError(`"${sketchFeature.name}" has no closed profile`);
    }
    const chosen = profileRegions(sketchFeature, regions, feature.profile.regions, ctx.warn);
    let tool: { shape: Shape3D; faces: KeyedFace[] } | null = null;
    for (const [index, region] of chosen.entries()) {
      const prism = extrudeProfile(feature, sketch.frame, region, index);
      if (!tool) {
        tool = prism;
      } else {
        const next: { shape: Shape3D; faces: KeyedFace[] } = {
          shape: tool.shape,
          faces: tool.faces,
        };
        const holder = { ...next, id: '', name: '', color: '', createdBy: '' };
        combine(holder, prism, 'join', feature.id, ctx.featureOrder);
        tool = { shape: holder.shape, faces: holder.faces };
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
    const faceEdgeKeys = edgeKeysOf(body);
    const sourceEdges = (topology.faceEdges[index] ?? [])
      .map((e) => ({ key: faceEdgeKeys[e]!, midpoint: topology.edgeGeoms[e]!.midpoint }))
      .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
    const travel = scale(n, Math.sign(feature.distance));
    const geoms = describeShape(prismShape);
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
    const label = feature.kind === 'fillet' ? 'Fillet' : 'Chamfer';
    if (!(size >= MIN_FEATURE_SIZE_MM / 10)) {
      throw new FeatureError(
        `${feature.kind === 'fillet' ? 'Radius' : 'Distance'} must be positive`,
      );
    }
    const rules = feature.rules ?? [];
    if (feature.edges.length === 0 && rules.length === 0) {
      throw new FeatureError('Select at least one edge');
    }
    const bodyId = feature.edges[0]?.bodyId ?? edgeRuleBodyId(rules[0]!);
    const body = ctx.bodies.get(bodyId);
    if (!body) throw new FeatureError(`Missing reference: body "${bodyId}"`);
    const picked = resolveEdges(body, feature.edges, ctx.warn);
    const topology = picked.topology;
    const ruled = rules.length > 0 ? ruleEdgeIndices(kit, body, rules, ctx.warn) : [];
    // Picked edges keep their generator index (face names); rule edges follow.
    const indices = [...picked.indices, ...ruled.filter((e) => !picked.indices.includes(e))];
    if (indices.length === 0) {
      throw new FeatureError(
        `No edge matches: ${rules.map(edgeRuleLabel).join(', ')} found nothing on "${body.name}"`,
      );
    }
    // In shape order, like the edge filter the fillet used before (same OCCT input order).
    const unique = [...new Set(indices)].sort((a, b) => a - b);
    const selected = unique.map((i) => topology.edges[i]!);
    const edgeFaceKeys = indices.map((i) =>
      (topology.edgeFaces[i] ?? []).map((f) => body.faces[f]!),
    );
    const options: BlendOptions = {};
    if (feature.kind === 'fillet' && feature.radius2 !== undefined) {
      if (!(feature.radius2 >= MIN_FEATURE_SIZE_MM / 10)) {
        throw new FeatureError('End radius must be positive');
      }
      options.size2 = feature.radius2;
    }
    if (feature.kind === 'chamfer' && feature.mode && feature.mode !== 'equal') {
      options.chamfer = feature.mode;
      options.faces = chamferReferenceFaces(topology, body.faces, unique, feature.flip === true);
      if (feature.mode === 'twoDistances') {
        const d2 = feature.distance2 ?? feature.distance;
        if (!(d2 >= MIN_FEATURE_SIZE_MM / 10))
          throw new FeatureError('Distance 2 must be positive');
        options.size2 = d2;
      } else {
        const angle = feature.angle ?? 45;
        if (!(angle > 0.5 && angle < 89.5)) {
          throw new FeatureError('Chamfer angle must be between 0.5° and 89.5°');
        }
        options.angle = (angle * Math.PI) / 180;
      }
    }
    const edgeKeys = edgeKeysOf(body);
    let built: HistoryResult;
    try {
      built = blendWithHistory(oc, feature.kind, body.shape, selected, size, options);
    } catch (error) {
      if (isFatalKernelError(error)) throw error;
      // Point at the edges that fail on their own (highlighted in the viewport).
      const failing = failingBlendEdges(kit, feature.kind, body.shape, selected, size, options);
      const keys = failing.map((i) => edgeKeys[unique[i]!]!);
      const hint =
        feature.kind === 'fillet'
          ? 'try a smaller radius, or fillet the neighbouring edges together'
          : 'try a smaller distance';
      const where =
        failing.length === 0
          ? `the edges fail together (${selected.length}); ${hint}`
          : failing.length === 1
            ? `it fails on the highlighted edge; ${hint}`
            : `it fails on ${failing.length} highlighted edges; ${hint}`;
      throw new FeatureError(`${label} failed: ${where}`, {
        bodyId: body.id,
        edgeKeys: failing.length > 0 ? keys : unique.map((i) => edgeKeys[i]!),
      });
    }
    // OCCT builds some variable fillets / asymmetric chamfers that do not fit (a self-intersecting
    // result instead of an error): check those results.
    if ((options.size2 !== undefined || options.chamfer) && !isValidShape(oc, built.shape)) {
      built.history.delete();
      throw new FeatureError(
        `${label} failed: ${feature.kind === 'fillet' ? 'an end radius' : 'a distance'} does not fit the faces next to the edge; try smaller values`,
        { bodyId: body.id, edgeKeys: unique.map((i) => edgeKeys[i]!) },
      );
    }
    const role = feature.kind === 'fillet' ? 'round' : 'chamfer';
    try {
      body.faces = nameResult(
        built.shape,
        built.history,
        [{ shape: body.shape, faces: body.faces }],
        ctx.featureOrder,
        (index, provisional, resultTopology) => {
          // v1 fallback (corner patches etc.): the new face adjacent to both faces of an edge.
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
        },
        indices.map((edgeIndex, i) => ({
          raw: topology.edges[edgeIndex]!.wrapped as RawShape,
          role: `${feature.id}:${role}:${i}`,
        })),
      );
      body.shape = built.shape;
    } finally {
      built.history.delete();
    }
    ctx.touch(body.id);
  }

  function applyShell(feature: ShellFeature, ctx: ReplayContext): void {
    if (!(feature.thickness >= MIN_FEATURE_SIZE_MM)) {
      throw new FeatureError(`Shell thickness must be at least ${MIN_FEATURE_SIZE_MM} mm`);
    }
    const body = ctx.bodies.get(feature.bodyId);
    if (!body) throw new FeatureError(`Missing reference: body "${feature.bodyId}"`);
    if (feature.faces.length === 0) throw new FeatureError('Select at least one face to open');
    const removedRefs = feature.faces.map((ref) => {
      if (ref.bodyId !== body.id)
        throw new FeatureError('Shell faces must belong to the shelled body');
      return resolveFace(body, ref, ctx.warn);
    });
    let removed = removedRefs.map((r) => r.face);
    const outward = feature.direction === 'outside';
    const clearance = feature.clearance ?? 0;
    if (clearance !== 0 && !outward) {
      throw new FeatureError(
        'A clearance applies to outward shells (a case that fits over the body)',
      );
    }
    if (!(clearance >= 0 && clearance <= 5)) {
      throw new FeatureError('Clearance must be between 0 and 5 mm');
    }
    // Per-face walls: validated before the (expensive) shell.
    const perFace = (feature.faceThickness ?? []).map((entry) => {
      if (entry.face.bodyId !== body.id) {
        throw new FeatureError('Wall thickness faces must belong to the shelled body');
      }
      if (!(entry.thickness >= MIN_FEATURE_SIZE_MM)) {
        throw new FeatureError(`Wall thickness must be at least ${MIN_FEATURE_SIZE_MM} mm`);
      }
      const resolved = resolveFace(body, entry.face, ctx.warn);
      if (removed.some((f) => f.isSame(resolved.face))) {
        throw new FeatureError('An open face has no wall; remove it from the wall thicknesses');
      }
      return { key: baseFaceKey(resolved.geom.key), thickness: entry.thickness };
    });
    // With a clearance the shell grows from the body offset by it (sharp edges): the cavity is
    // the body plus the clearance, e.g. a case or sleeve that fits over the part when printed.
    let source: { shape: Shape3D; faces: KeyedFace[] } = { shape: body.shape, faces: body.faces };
    if (clearance > 0) {
      let grown: HistoryResult;
      try {
        grown = offsetWithHistory(oc, body.shape, clearance);
      } catch (error) {
        if (isFatalKernelError(error)) throw error;
        throw new FeatureError(
          `Shell failed: the ${clearance} mm clearance offset could not be built`,
        );
      }
      try {
        // The offset faces keep the keys of the faces they were offset from (by geometry:
        // this builder's history does not report them).
        const faces = nameResult(
          grown.shape,
          grown.history,
          [{ shape: body.shape, faces: body.faces }],
          ctx.featureOrder,
          (index) => {
            const g = describeFace(topologyOf(grown.shape).faces[index]!);
            const original = body.faces.find((f) => isOutwardOffsetOf(g.id, f.id, clearance));
            return original ? baseFaceKey(original.key) : `${feature.id}:new`;
          },
        );
        const grownTopology = topologyOf(grown.shape);
        removed = removedRefs.map((r) => {
          const key = baseFaceKey(r.geom.key);
          const index = faces.findIndex((f) => baseFaceKey(f.key) === key);
          if (index < 0) {
            throw new FeatureError('Shell failed: an open face was lost by the clearance offset');
          }
          return grownTopology.faces[index]!;
        });
        source = { shape: grown.shape, faces };
      } finally {
        grown.history.delete();
      }
    }
    let built: HistoryResult;
    try {
      built = shellWithHistory(oc, source.shape, removed, feature.thickness, outward);
    } catch (error) {
      if (isFatalKernelError(error)) throw error;
      throw new FeatureError(
        `Shell failed: ${describeError(error)}. A wall of ${feature.thickness} mm may not fit here; try a thinner wall`,
      );
    }
    const t = feature.thickness;
    const role = outward ? 'outer' : 'inner';
    const topology = topologyOf(source.shape);
    try {
      body.faces = nameResult(
        built.shape,
        built.history,
        [source],
        ctx.featureOrder,
        (index) => {
          const g = describeFace(topologyOf(built.shape).faces[index]!);
          const original = source.faces.find((f) =>
            outward ? isOutwardOffsetOf(g.id, f.id, t) : isOffsetOf(g.id, f.id, t),
          );
          return original
            ? `${feature.id}:${role}:${baseFaceKey(original.key)}`
            : `${feature.id}:new`;
        },
        topology.faces.map((face, i) => ({
          raw: face.wrapped as RawShape,
          role: `${feature.id}:${role}:${baseFaceKey(source.faces[i]!.key)}`,
        })),
      );
      body.shape = built.shape;
    } finally {
      built.history.delete();
    }
    // Thicker walls: offset the wall's free side by the extra thickness (Offset Face).
    const thicker = perFace.filter((entry) => Math.abs(entry.thickness - t) > 1e-9);
    if (thicker.length > 0) {
      const walls = thicker.map((entry) => {
        const key = `${feature.id}:${role}:${entry.key}`;
        const face = body.faces.find((f) => baseFaceKey(f.key) === key);
        if (!face) {
          throw new FeatureError(
            `Shell failed: the wall of face "${entry.key}" was not found after shelling`,
          );
        }
        // Inside: the wall's free side faces the cavity; a thicker wall grows into it (+).
        // Outside: the free side is the outer skin; it grows outwards (+) as well.
        return { key: face.key, distance: entry.thickness - t };
      });
      try {
        offsetBodyFaces(kit, ctx, body, walls, feature.id);
      } catch (error) {
        if (error instanceof FeatureError || isFatalKernelError(error)) throw error;
        throw new FeatureError(`Shell failed: ${describeError(error)}`);
      }
    }
    ctx.touch(body.id);
  }

  function applyBoolean(feature: BooleanFeature, ctx: ReplayContext): void {
    const target = ctx.bodies.get(feature.targetBodyId);
    if (!target) throw new FeatureError(`Missing reference: body "${feature.targetBodyId}"`);
    if (feature.toolBodyIds.length === 0) throw new FeatureError('Select at least one tool body');
    if (new Set(feature.toolBodyIds).size !== feature.toolBodyIds.length) {
      throw new FeatureError('A tool body is listed twice');
    }
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
    if (!feature.keepTools) {
      for (const tool of tools) {
        ctx.bodies.delete(tool.id);
        ctx.order.splice(ctx.order.indexOf(tool.id), 1);
      }
    }
    ctx.touch(target.id);
  }

  function applyMove(feature: MoveFeature, ctx: ReplayContext): void {
    const body = ctx.bodies.get(feature.bodyId);
    if (!body) throw new FeatureError(`Missing reference: body "${feature.bodyId}"`);
    const delta: Vec3 = [feature.dx, feature.dy, feature.dz];
    const moved = body.faces.map((f) => translateGeom(f, delta));
    const result = body.shape.clone().translate(delta);
    const geoms = describeShape(result);
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

  /** Imports a STEP file as a new body (Shapr3D-style "Import"), naming its faces by index. */
  async function applyImportStep(feature: ImportStepFeature, ctx: ReplayContext): Promise<void> {
    let shape: Shape3D;
    try {
      const bytes = base64ToBytes(feature.data);
      const blob = new Blob([bytes.slice()], { type: 'application/step' });
      const imported = await R.importSTEP(blob);
      if (!('faces' in imported)) {
        throw new FeatureError('STEP file has no solid geometry');
      }
      shape = imported as Shape3D;
    } catch (error) {
      if (error instanceof FeatureError || isFatalKernelError(error)) throw error;
      throw new FeatureError(`STEP import failed: ${describeError(error)}`);
    }
    const geoms = describeShape(shape);
    const id = bodyIdFor(feature.id);
    const created = ctx.createdCount;
    ctx.bodies.set(id, {
      id,
      name: feature.fileName.replace(/\.step$|\.stp$/i, '') || `Import ${created + 1}`,
      color: COLOR_PALETTE[created % COLOR_PALETTE.length]!,
      createdBy: feature.id,
      shape,
      faces: geoms.map((g, i) => ({ ...g, key: `${feature.id}:face:${i}`, aliases: [] })),
    });
    ctx.createdCount += 1;
    ctx.order.push(id);
  }

  /** What the modelling-feature modules (`./features/`) may use of this evaluator. */
  const kit: FeatureKit = {
    oc,
    fail: (message, refs) => {
      throw new FeatureError(message, refs);
    },
    edgeKeysOf: (body) => edgeKeysOf(body as BodyState),
    isFailure: (error) => error instanceof FeatureError || isFatalKernelError(error),
    describeError: (error) => describeError(error),
    describeFace,
    describeShape,
    topologyOf,
    facesOf: (shape) => facesOf(oc, shape),
    edgesOf: (shape) => edgesOf(oc, shape),
    resolveFace,
    resolveEdges,
    combine,
    nameResult: (result, history, inputs, featureOrder, nameNew, generators) =>
      nameResult(result, history, inputs, featureOrder, nameNew, generators),
    withKeys,
    diagonalOf,
    addBody: (ctx, body, color) => {
      const created = ctx.createdCount;
      const state: BodyState = {
        ...body,
        color: color ?? COLOR_PALETTE[created % COLOR_PALETTE.length]!,
      };
      ctx.bodies.set(state.id, state);
      ctx.createdCount += 1;
      ctx.order.push(state.id);
      return state;
    },
  };

  // ---- output ------------------------------------------------------------------

  /** Deflection for a body: relative to its size, snapped down to a power of two so small size changes keep face meshes. */
  function deflection(
    shape: Shape3D,
    q: TessellationQuality,
  ): { tolerance: number; angular: number } {
    const settings = quality[q];
    const raw = Math.min(
      settings.max,
      Math.max(settings.min, diagonalOf(shape) * settings.relative),
    );
    const tolerance = Math.max(settings.min, 2 ** Math.floor(Math.log2(raw)));
    return { tolerance, angular: settings.angular };
  }

  function toBody(state: BodyState, q: TessellationQuality): { body: Body; triangles: number } {
    const shape = state.shape;
    const info = infoOf(shape);
    const topology = topologyOf(shape);
    const [min, max] = timed('bounds', () => boundsOf(shape));
    const { tolerance, angular } = deflection(shape, q);
    const mesh = timed('mesh', () => faceMeshes.tessellate(shape, topology, tolerance, angular));
    const edgeMesh = timed('edgeMesh', () => meshShapeEdges(oc, shape, tolerance, angular));

    const edgeByHash = new Map<number, number[]>();
    topology.edges.forEach((edge, i) => {
      const hash = shapeHash(oc, edge.wrapped as RawShape);
      const list = edgeByHash.get(hash) ?? [];
      list.push(i);
      edgeByHash.set(hash, list);
    });

    const edgeKeys = edgeKeysOf(state);
    const triangleCount = mesh.indices.length / 3;
    const triangleFaces = new Uint32Array(triangleCount);
    const faceRange = new Map<number, { start: number; count: number }>();
    mesh.faceRanges.forEach((range, faceIndex) => {
      if (range.count === 0) return;
      faceRange.set(faceIndex, range);
      triangleFaces.fill(faceIndex, range.start, range.start + range.count);
    });
    facesMeshedTotal += mesh.facesMeshed;

    const segmentsByEdge = new Map<number, Float32Array>();
    const usedEdges = new Set<number>();
    for (let g = 0; g + 2 < edgeMesh.edgeGroups.length; g += 3) {
      const edgeIndex = takeUnused(edgeByHash.get(edgeMesh.edgeGroups[g + 2]!), usedEdges);
      if (edgeIndex === null) continue;
      const start = edgeMesh.edgeGroups[g]!;
      const count = edgeMesh.edgeGroups[g + 1]!;
      segmentsByEdge.set(edgeIndex, edgeMesh.lines.slice(start * 3, (start + count) * 3));
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
      radius: g.radius,
      segments: segmentsByEdge.get(i) ?? new Float32Array(0),
    }));

    // Previews only check closure (`faceProps.ts`); a final evaluation re-checks such a body.
    const checkMode = q === 'preview' ? 'closure' : mesh.facesReused === 0 ? 'full' : 'faces';
    if (info.valid === undefined || (info.validMode === 'closure' && checkMode !== 'closure')) {
      info.valid = timed('validity', () => faceProps.valid(shape, topology, checkMode));
      info.validMode = checkMode;
    }
    info.volume ??= timed('volume', () => faceProps.volume(topology));

    meshSerial += 1;
    return {
      triangles: triangleCount,
      body: {
        id: state.id,
        name: state.name,
        color: state.color,
        createdBy: state.createdBy,
        meshId: `m${meshSerial}`,
        min: [min[0], min[1], min[2]],
        max: [max[0], max[1], max[2]],
        volume: info.volume,
        valid: info.valid,
        mesh: {
          positions: mesh.positions,
          normals: mesh.normals,
          indices: mesh.indices,
          triangleFaces,
        },
        faces,
        edges,
      },
    };
  }

  function meshBytesOf(body: Body): number {
    let bytes =
      body.mesh.positions.byteLength +
      body.mesh.normals.byteLength +
      body.mesh.indices.byteLength +
      body.mesh.triangleFaces.byteLength;
    for (const edge of body.edges) bytes += edge.segments.byteLength + 200;
    return bytes + body.faces.length * 300;
  }

  /** The tessellated body of `state`, reusing the mesh of an unchanged shape. */
  function tessellate(
    state: BodyState,
    q: TessellationQuality,
    keep: boolean,
  ): { body: Body; triangles: number; reused: boolean } {
    const cached = meshes.get(state.shape);
    if (
      cached &&
      cached.faces === state.faces &&
      (cached.quality === q || cached.quality === 'final')
    ) {
      cached.lastUsed = ++meshClock;
      const body: Body = {
        ...cached.body,
        id: state.id,
        name: state.name,
        color: state.color,
        createdBy: state.createdBy,
      };
      return { body, triangles: body.mesh.indices.length / 3, reused: true };
    }
    const out = inArena(() => toBody(state, q));
    if (keep) {
      if (cached) dropMesh(state.shape);
      const bytes = meshBytesOf(out.body);
      meshes.set(state.shape, {
        quality: q,
        faces: state.faces,
        body: out.body,
        bytes,
        lastUsed: ++meshClock,
      });
      meshBytes += bytes;
    }
    return { ...out, reused: false };
  }

  function evictMeshes(keep: ReadonlySet<Shape3D>): void {
    // Per-face caches follow the faces the checkpoints hold (plus the tessellated result).
    let liveFaces = cache.stats().faces;
    for (const shape of keep) liveFaces += infos.get(shape)?.topology?.faces.length ?? 0;
    const maxFaces = Math.max(256, 2 * liveFaces);
    faceMeshes.evict(maxFaces);
    faceProps.evict(maxFaces);
    if (meshBytes <= meshBudget) return;
    const entries = [...meshes.entries()]
      .filter(([shape]) => !keep.has(shape))
      .sort((a, b) => a[1].lastUsed - b[1].lastUsed);
    for (const [shape] of entries) {
      if (meshBytes <= meshBudget) break;
      dropMesh(shape);
    }
  }

  // ---- replay --------------------------------------------------------------------

  interface ReplayContext {
    bodies: Map<string, BodyState>;
    order: string[];
    sketches: Map<string, EvaluatedSketch>;
    sketchFeatures: Map<string, SketchFeature>;
    /** Detected regions (closed profiles) per sketch feature id. */
    sketchRegions: Map<string, SketchRegion[]>;
    featureOrder: ReadonlyMap<string, number>;
    createdCount: number;
    warn: (message: string) => void;
    touch: (bodyId: string) => void;
  }

  interface Replay {
    ctx: ReplayContext;
    creationOrder: string[];
    errors: Record<string, string>;
    warnings: Record<string, string>;
    errorRefs: Record<string, FeatureErrorRefs>;
    /** Features restored from a checkpoint / evaluated now. */
    reused: number;
    evaluated: number;
    /** Hashes of this document's checkpoints (protected from eviction). */
    hashes: string[];
  }

  function restore(checkpoint: Checkpoint | null, featureOrder: ReadonlyMap<string, number>) {
    const errors: Record<string, string> = { ...(checkpoint?.errors ?? {}) };
    const warnings: Record<string, string> = { ...(checkpoint?.warnings ?? {}) };
    const errorRefs: Record<string, FeatureErrorRefs> = { ...(checkpoint?.errorRefs ?? {}) };
    let currentId = '';
    const ctx: ReplayContext = {
      bodies: new Map(
        [...(checkpoint?.bodies.values() ?? [])].map((b) => [b.id, { ...b } as BodyState]),
      ),
      order: [...(checkpoint?.order ?? [])],
      sketches: new Map(checkpoint?.sketches ?? []),
      sketchFeatures: new Map(checkpoint?.sketchFeatures ?? []),
      sketchRegions: new Map(checkpoint?.sketchRegions ?? []),
      featureOrder,
      createdCount: checkpoint?.createdCount ?? 0,
      warn: (message) => {
        warnings[currentId] = warnings[currentId] ? `${warnings[currentId]}; ${message}` : message;
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
    return {
      ctx,
      errors,
      warnings,
      errorRefs,
      creationOrder: [...(checkpoint?.creationOrder ?? [])],
      setCurrent: (id: string) => {
        currentId = id;
      },
    };
  }

  function snapshotOf(
    hash: string,
    index: number,
    replay: {
      ctx: ReplayContext;
      creationOrder: string[];
      errors: Record<string, string>;
      warnings: Record<string, string>;
      errorRefs: Record<string, FeatureErrorRefs>;
    },
    previous: Checkpoint | null,
  ): Checkpoint {
    const bodies = new Map<string, BodySnapshot>();
    for (const [id, body] of replay.ctx.bodies) {
      const before = previous?.bodies.get(id);
      // Unchanged bodies share their snapshot object with the previous checkpoint.
      if (
        before &&
        before.shape === body.shape &&
        before.faces === body.faces &&
        before.color === body.color &&
        before.name === body.name &&
        before.createdBy === body.createdBy
      ) {
        bodies.set(id, before);
      } else {
        bodies.set(id, Object.freeze({ ...body }));
      }
    }
    return {
      hash,
      index,
      bodies,
      order: [...replay.ctx.order],
      creationOrder: [...replay.creationOrder],
      sketches: new Map(replay.ctx.sketches),
      sketchFeatures: new Map(replay.ctx.sketchFeatures),
      sketchRegions: new Map(replay.ctx.sketchRegions),
      createdCount: replay.ctx.createdCount,
      errors: { ...replay.errors },
      warnings: { ...replay.warnings },
      ...(Object.keys(replay.errorRefs).length > 0 ? { errorRefs: { ...replay.errorRefs } } : {}),
    };
  }

  async function applyFeature(feature: Feature, ctx: ReplayContext): Promise<void> {
    switch (feature.kind) {
      case 'sketch': {
        const { evaluated, regions } = evaluateSketch(feature, ctx.bodies, ctx.warn);
        ctx.sketches.set(feature.id, evaluated);
        ctx.sketchFeatures.set(feature.id, feature);
        ctx.sketchRegions.set(feature.id, regions);
        return;
      }
      case 'extrude':
        return applyExtrude(feature, ctx);
      case 'fillet':
      case 'chamfer':
        return applyBlend(feature, ctx);
      case 'shell':
        return applyShell(feature, ctx);
      case 'boolean':
        return applyBoolean(feature, ctx);
      case 'move':
        return applyMove(feature, ctx);
      case 'setAppearance':
        return applyAppearance(feature, ctx);
      case 'importStep':
        return applyImportStep(feature, ctx);
      default:
        applyModelingFeature(feature, ctx, kit);
    }
  }

  /** Replays `features` from the deepest cached checkpoint, storing new checkpoints. */
  async function replayFeatures(
    features: readonly Feature[],
    options: {
      cacheTail: boolean;
      onProgress?: ((progress: EvaluationProgress) => void) | undefined;
    },
  ): Promise<Replay> {
    const hashes = timed('hash', () => prefixHashes(features));
    let start = features.length;
    let checkpoint: Checkpoint | null = null;
    while (start > 0) {
      const found = cache.get(hashes[start - 1]!);
      if (found) {
        checkpoint = found;
        break;
      }
      start -= 1;
    }
    // Everything before the checkpoint is part of this document too.
    for (let i = 0; i < start - 1; i += 1) cache.get(hashes[i]!);

    const featureOrder = new Map(features.map((f, i) => [f.id, i]));
    const replay = restore(checkpoint, featureOrder);
    const { ctx, errors } = replay;
    let previous = checkpoint;
    const total = features.length - start;
    for (let i = start; i < features.length; i += 1) {
      const feature = features[i]!;
      replay.setCurrent(feature.id);
      options.onProgress?.({
        phase: 'model',
        done: i - start,
        total,
        featureId: feature.id,
        featureName: feature.name,
      });
      if (!feature.suppressed) {
        const snapshot = snapshotBodies(ctx.bodies);
        featureInfos = [];
        openArena();
        try {
          const t = now();
          await applyFeature(feature, ctx);
          if (phases)
            phases[`feature:${feature.kind}`] =
              (phases[`feature:${feature.kind}`] ?? 0) + now() - t;
        } catch (error) {
          if (isFatalKernelError(error)) {
            closeArena();
            throw error instanceof KernelFatalError
              ? error
              : new KernelFatalError(`CAD kernel failure: ${describeError(error)}`);
          }
          errors[feature.id] = error instanceof FeatureError ? error.message : describeError(error);
          if (error instanceof FeatureError && error.refs)
            replay.errorRefs[feature.id] = error.refs;
          restoreBodies(ctx, snapshot);
        }
        // Keep the bodies' shapes, release everything else the feature created.
        for (const body of ctx.bodies.values()) pin(body.shape.wrapped);
        for (const shape of featureInfos) {
          if (!isPinned(shape.wrapped)) dropInfo(shape);
        }
        featureInfos = [];
        timed('release', () => closeArena());
        for (const id of ctx.order)
          if (!replay.creationOrder.includes(id)) replay.creationOrder.push(id);
      }
      const isTail = i === features.length - 1;
      const next = timed('checkpoint', () => snapshotOf(hashes[i]!, i, replay, previous));
      if (!isTail || options.cacheTail) cache.put(next);
      previous = next;
    }
    return {
      ctx,
      creationOrder: replay.creationOrder,
      errors: replay.errors,
      warnings: replay.warnings,
      errorRefs: replay.errorRefs,
      reused: start,
      evaluated: features.length - start,
      hashes,
    };
  }

  /** Frees the shapes of a finished replay that no checkpoint holds (an uncached preview tail). */
  function releaseTransient(replay: Replay): void {
    for (const body of replay.ctx.bodies.values()) {
      if (!cache.holds(body.shape)) freeShape(body.shape);
    }
  }

  // Serializes evaluate/exportStep: arenas and the caches are not re-entrant.
  let queue: Promise<unknown> = Promise.resolve();
  let broken: Error | null = null;
  function serialized<T>(run: () => Promise<T>): Promise<T> {
    const next = queue.then(() => {
      if (broken) throw broken;
      return run();
    });
    queue = next.catch(() => undefined);
    return next.catch((error: unknown) => {
      if (isFatalKernelError(error)) {
        broken =
          error instanceof KernelFatalError
            ? error
            : new KernelFatalError(`CAD kernel failure: ${describeError(error)}`);
        throw broken;
      }
      throw error;
    });
  }

  return {
    evaluate(features, evaluateOptions = {}) {
      return serialized(async () => {
        const q: TessellationQuality = evaluateOptions.quality ?? 'final';
        const cacheTail = evaluateOptions.cacheTail ?? q === 'final';
        phases = evaluateOptions.profile ? {} : null;
        const t0 = now();
        const replay = await replayFeatures(features, {
          cacheTail,
          onProgress: evaluateOptions.onProgress,
        });
        const { ctx, creationOrder, errors, warnings, errorRefs } = replay;

        const t1 = now();
        evaluateOptions.onProgress?.({
          phase: 'tessellate',
          done: replay.evaluated,
          total: replay.evaluated,
          featureId: null,
          featureName: null,
        });
        const bodies: Body[] = [];
        let triangles = 0;
        let reusedBodies = 0;
        for (const id of creationOrder) {
          const state = ctx.bodies.get(id);
          if (!state) continue;
          try {
            const out = tessellate(state, q, cache.holds(state.shape));
            bodies.push(out.body);
            triangles += out.triangles;
            if (out.reused) reusedBodies += 1;
          } catch (error) {
            if (isFatalKernelError(error)) throw error;
            errors[state.createdBy] = `Tessellation failed: ${describeError(error)}`;
          }
        }
        const t2 = now();
        releaseTransient(replay);
        cache.evict(new Set(replay.hashes));
        evictMeshes(new Set([...ctx.bodies.values()].map((b) => b.shape)));
        const cacheStats = cache.stats();
        return {
          bodies,
          sketches: [...ctx.sketches.values()],
          errors,
          warnings,
          ...(Object.keys(errorRefs).length > 0 ? { errorRefs } : {}),
          stats: {
            modelMs: t1 - t0,
            tessellateMs: t2 - t1,
            triangles,
            reusedFeatures: replay.reused,
            evaluatedFeatures: replay.evaluated,
            reusedBodies,
            tessellatedBodies: bodies.length - reusedBodies,
            heapBytes: heapBytes(oc),
            cacheBytes: cacheStats.bytes + meshBytes + faceMeshes.byteSize,
            ...(phases ? { phases: roundPhases(phases) } : {}),
          },
        };
      });
    },

    exportStep(features, bodyIds) {
      return serialized(async () => {
        const replay = await replayFeatures(features, { cacheTail: true });
        try {
          const { ctx, creationOrder, errors } = replay;
          const firstError = Object.entries(errors)[0];
          if (firstError) throw new Error(`Cannot export: ${firstError[1]}`);
          const wanted = bodyIds ? new Set(bodyIds) : null;
          const shapes = creationOrder
            .map((id) => ctx.bodies.get(id))
            .filter(
              (state): state is BodyState =>
                state !== undefined && (!wanted || wanted.has(state.id)),
            )
            .map((state) => ({ shape: state.shape, color: state.color, name: state.name }));
          if (shapes.length === 0) throw new Error('Nothing to export');
          openArena();
          try {
            const blob = R.exportSTEP(shapes, { unit: 'mm', modelUnit: 'mm' });
            const buffer = await blob.arrayBuffer();
            return new Uint8Array(buffer);
          } finally {
            closeArena();
          }
        } finally {
          releaseTransient(replay);
        }
      });
    },

    cacheInfo() {
      return {
        ...cache.stats(),
        meshBytes: meshBytes + faceMeshes.byteSize,
        meshes: meshes.size,
        faceMeshes: faceMeshes.size,
        facesMeshed: facesMeshedTotal,
        heapBytes: heapBytes(oc),
      };
    },

    clearCache() {
      cache.clear();
      for (const shape of [...meshes.keys()]) dropMesh(shape);
      faceMeshes.clear();
      faceProps.clear();
    },
  };

  function describeError(error: unknown): string {
    if (error instanceof Error) return error.message;
    // OCCT throws C++ exceptions: a pointer (number) or, with native wasm
    // exceptions, a `WebAssembly.Exception` object — never show those raw.
    const wasmException =
      typeof WebAssembly !== 'undefined' &&
      'Exception' in WebAssembly &&
      error instanceof (WebAssembly as unknown as { Exception: new () => object }).Exception;
    if (typeof error === 'number' || wasmException) {
      try {
        const message = (
          oc as unknown as { getExceptionMessage?: (e: unknown) => unknown }
        ).getExceptionMessage?.(error);
        const text = Array.isArray(message)
          ? message.filter((m) => typeof m === 'string' && m).join(': ')
          : typeof message === 'string'
            ? message
            : '';
        if (text) return `the kernel could not build this geometry (OCCT ${text})`;
      } catch {
        // fall through
      }
      return 'the kernel could not build this geometry';
    }
    return String(error);
  }
}

/**
 * Estimated wasm-heap bytes of a B-rep with `faces` faces (surfaces,
 * p-curves, edges, vertices; triangulations are counted by the mesh cache).
 * Calibrated on this kernel build with the bench parts.
 */
export function estimateShapeBytes(faces: number): number {
  return 4096 + faces * 6144;
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

/** `outer` is `inner` moved `thickness` outwards (outward shell skin): same normal/convexity. */
function isOutwardOffsetOf(outer: SurfaceId, inner: SurfaceId, thickness: number): boolean {
  const tol = GEOMETRY_TOLERANCE * 10;
  if (inner.type === 'plane' && outer.type === 'plane') {
    return (
      dot(inner.normal, outer.normal) > 1 - 1e-7 &&
      Math.abs(outer.offset - (inner.offset + thickness)) < tol
    );
  }
  if (inner.type === 'cylinder' && outer.type === 'cylinder') {
    return (
      inner.convex === outer.convex &&
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

function roundPhases(phases: Record<string, number>): Record<string, number> {
  return Object.fromEntries(
    Object.entries(phases)
      .sort((a, b) => b[1] - a[1])
      .map(([k, v]) => [k, Math.round(v * 10) / 10]),
  );
}

function now(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}

/** Decodes base64 to bytes in the worker/browser and in Node (test) contexts alike. */
function base64ToBytes(base64: string): Uint8Array {
  const g = globalThis as {
    atob?: (s: string) => string;
    Buffer?: { from(s: string, enc: string): Uint8Array };
  };
  if (typeof g.atob === 'function') {
    const binary = g.atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    return bytes;
  }
  if (g.Buffer) return new Uint8Array(g.Buffer.from(base64, 'base64'));
  throw new Error('No base64 decoder available');
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
