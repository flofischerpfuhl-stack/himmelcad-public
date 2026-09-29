/**
 * Data the CAD kernel returns for one evaluated feature list. Everything is
 * structured-clone safe (typed arrays are transferred from the worker), so
 * the same shape flows from the Web Worker, from the in-process test adapter
 * and into the store and viewport.
 */
import type { CurveKind, Feature, SketchFrame, SurfaceKind, Vec3 } from '../model/document.js';

export type KernelStatus = 'loading' | 'ready' | 'error';

export interface KernelStatusInfo {
  status: KernelStatus;
  /** Human-readable progress or error text for the UI. */
  message: string;
  /** Load progress 0..1 while `status === 'loading'`, when known. */
  progress: number | null;
  /** Wall-clock load time (download + compile + init) once ready, ms. */
  loadMs: number | null;
}

/** One B-rep face after evaluation, with its stable naming key. */
export interface FaceInfo {
  /** Naming key (generating feature + role); unique within the body. */
  key: string;
  /** Other keys that name the same face (e.g. merged coplanar faces). */
  aliases: string[];
  surface: SurfaceKind;
  /** Outward unit normal for planar faces, else `null`. */
  normal: Vec3 | null;
  centroid: Vec3;
  area: number;
  /** First triangle (index into `BodyMesh.indices / 3`) and triangle count of this face. */
  triangleStart: number;
  triangleCount: number;
  /** Indices into `Body.edges` of this face's boundary edges. */
  edgeIndices: number[];
  /** Number of distinct neighbouring faces. */
  adjacentFaces: number;
}

/** One B-rep edge after evaluation. */
export interface EdgeInfo {
  /** `"<faceKeyA>|<faceKeyB>"` (sorted), `~n`-suffixed when ambiguous. */
  key: string;
  /** Indices into `Body.faces` of the (usually two) adjacent faces. */
  faceIndices: number[];
  curve: CurveKind;
  midpoint: Vec3;
  length: number;
  direction: Vec3 | null;
  /** Radius of circular edges (full circles and arcs), else `null`. Optional for older results. */
  radius?: number | null;
  /** Line-segment pairs (x, y, z, x, y, z, ...) approximating the edge. */
  segments: Float32Array;
}

/** Indexed triangle mesh of a body; per-vertex normals are per face (crisp planes, smooth curved faces). */
export interface BodyMesh {
  positions: Float32Array;
  normals: Float32Array;
  indices: Uint32Array;
  /** Face index (into `Body.faces`) of every triangle. */
  triangleFaces: Uint32Array;
}

/** A solid body resulting from evaluating a feature history. */
export interface Body {
  /** Derived from the creating feature's id (`body:<featureId>`), stable across re-evaluation. */
  id: string;
  name: string;
  /** Theme-independent sRGB hex color. */
  color: string;
  /** The id of the feature that created this body. */
  createdBy: string;
  /**
   * Identity of the tessellation (`mesh`, edge `segments`): equal ids carry
   * the very same mesh, so consumers can skip re-uploading unchanged bodies.
   * Absent in results of older kernels.
   */
  meshId?: string;
  /** Axis-aligned bounding box of the exact B-rep. */
  min: Vec3;
  max: Vec3;
  /** Exact B-rep volume in mm^3. */
  volume: number;
  /** `BRepCheck_Analyzer` verdict. */
  valid: boolean;
  mesh: BodyMesh;
  faces: FaceInfo[];
  edges: EdgeInfo[];
}

/**
 * A sketch after evaluation: its frame, every closed profile (detected
 * region) and every curve, in world coordinates.
 */
export interface EvaluatedSketch {
  featureId: string;
  frame: SketchFrame;
  profiles: {
    /** Stable region key (`sketch/regions.ts`), what extrudes reference. */
    key: string;
    /** Closed outer outline in world coordinates (first point not repeated). */
    outline: Vec3[];
    /** Closed hole outlines. */
    holes: Vec3[][];
    /** Triangulated region (holes excluded): flat `x, y, z` triples, 3 vertices per triangle. */
    triangles: number[];
    /** A point inside the region (not in a hole). */
    center: Vec3;
    /** Net area, mm². */
    area: number;
  }[];
  /** Every curve (construction included) as a world polyline. */
  curves: {
    entityId: string;
    kind: 'line' | 'circle' | 'arc';
    construction: boolean;
    points: Vec3[];
  }[];
}

export interface EvaluationStats {
  /** Modelling time (feature replay), ms. */
  modelMs: number;
  /** Tessellation + topology extraction time, ms. */
  tessellateMs: number;
  triangles: number;
  /** Features restored from the prefix cache instead of being evaluated. */
  reusedFeatures?: number;
  /** Features evaluated by this request. */
  evaluatedFeatures?: number;
  /** Bodies whose mesh was reused (shape unchanged) / tessellated now. */
  reusedBodies?: number;
  tessellatedBodies?: number;
  /** wasm heap size after the evaluation (a high-water mark), bytes. */
  heapBytes?: number;
  /** Estimated bytes held by the kernel's incremental caches. */
  cacheBytes?: number;
  /** Per-phase milliseconds, only when profiling was requested. */
  phases?: Record<string, number>;
}

/** Mesh density: `preview` (coarser, during drags and tool previews) or `final` (committed). */
export type TessellationQuality = 'preview' | 'final';

/** Progress of a running evaluation, reported between features. */
export interface EvaluationProgress {
  phase: 'model' | 'tessellate';
  /** Features evaluated so far / features this request evaluates (cached ones excluded). */
  done: number;
  total: number;
  featureId: string | null;
  featureName: string | null;
}

/** Result of replaying a feature list. */
export interface EvaluationResult {
  /** Bodies in creation order. */
  bodies: Body[];
  /** Evaluated sketches, in feature order. */
  sketches: EvaluatedSketch[];
  /** Per-feature error message, keyed by feature id. Absent = no error. */
  errors: Record<string, string>;
  /** Per-feature warnings (e.g. a reference re-bound by geometry). */
  warnings: Record<string, string>;
  stats: EvaluationStats;
}

export const EMPTY_EVALUATION: EvaluationResult = {
  bodies: [],
  sketches: [],
  errors: {},
  warnings: {},
  stats: { modelMs: 0, tessellateMs: 0, triangles: 0 },
};

/** Evaluation channels: a newer request supersedes an older queued one on the same channel. */
export type EvaluationChannel = 'document' | 'preview';

export interface EvaluationRequest {
  channel: EvaluationChannel;
  /** Caller-owned revision; echoed back so stale results can be discarded. */
  revision: number;
  features: Feature[];
  /**
   * Tessellation quality. Default `final`; tool previews ask for `preview`
   * (coarser mesh, the provisional feature is not kept in the prefix cache).
   */
  quality?: TessellationQuality;
}

export type EvaluationOutcome =
  | { kind: 'done'; revision: number; result: EvaluationResult }
  | { kind: 'superseded'; revision: number }
  | { kind: 'cancelled'; revision: number }
  | { kind: 'failed'; revision: number; message: string };
