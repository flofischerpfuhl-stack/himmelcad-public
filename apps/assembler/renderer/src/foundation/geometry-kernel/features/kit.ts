/**
 * The evaluator internals the modelling-feature modules in this folder may
 * use. `evaluator.ts` builds one {@link FeatureKit} per evaluator and hands
 * it, with its replay context, to {@link applyModelingFeature}
 * (`./index.ts`). The shapes here are structural mirrors of the
 * evaluator's private types, so the evaluator stays the single owner of
 * body state, profile construction and reference resolution.
 *
 * Memory: every OCCT object a feature creates is released when the feature
 * ends (`../occtArena.ts`) unless it became a body's shape. Use
 * `topologyOf`/`facesOf`/`edgesOf` instead of replicad's `shape.faces` /
 * `shape.edges` getters (those leak raw handles) and delete raw OCCT
 * objects created with `new kit.oc.…` yourself.
 */
import type * as R from 'replicad';

import type { EdgeRef, FaceRef, SketchFeature } from '../../document/document.js';
import type { SketchRegion } from '../../sketch-solver/regions.js';
import type { FaceGeom, KeyedFace, KeyedFaceKeys } from '../naming.js';
import type { HistorySource, RawShape, Topology } from '../occt.js';
import type { EvaluatedDatum, EvaluatedSketch, FeatureErrorRefs } from '../types.js';

export type OpenCascade = ReturnType<typeof R.getOC>;
export type Shape3D = R.Shape3D;

export interface BodyStateLike {
  id: string;
  name: string;
  color: string;
  createdBy: string;
  shape: Shape3D;
  faces: KeyedFace[];
}

export type TopologyLike = Topology;

export interface ReplayContextLike {
  bodies: Map<string, BodyStateLike>;
  order: string[];
  sketches: Map<string, EvaluatedSketch>;
  sketchFeatures: Map<string, SketchFeature>;
  /** Detected regions (closed profiles) per sketch feature id. */
  sketchRegions: Map<string, SketchRegion[]>;
  /** Construction planes/axes per feature id (`construction.ts`). */
  datums: Map<string, EvaluatedDatum>;
  featureOrder: ReadonlyMap<string, number>;
  createdCount: number;
  warn: (message: string) => void;
  touch: (bodyId: string) => void;
}

export interface ResolvedFace {
  face: R.Face;
  geom: KeyedFace;
  topology: TopologyLike;
  index: number;
}

export interface FeatureKit {
  oc: OpenCascade;
  /**
   * Throws the evaluator's per-feature error (shown on the history card /
   * tool pill); `refs` names the geometry to highlight.
   */
  fail(message: string, refs?: FeatureErrorRefs): never;
  /** Naming keys of the body's edges, in topology order. */
  edgeKeysOf(body: BodyStateLike): string[];
  /** `true` for an error raised by {@link fail} or a fatal kernel error (so wrappers don't re-wrap it). */
  isFailure(error: unknown): boolean;
  /** Readable text for an OCCT/JS exception. */
  describeError(error: unknown): string;
  describeFace(face: R.Face): FaceGeom;
  /** Descriptors of every face of `shape`, in the shape's face order. */
  describeShape(shape: Shape3D): FaceGeom[];
  /** Cached topology of `shape` (released with the shape; do not dispose). */
  topologyOf(shape: Shape3D): TopologyLike;
  facesOf(shape: { wrapped: RawShape }): R.Face[];
  edgesOf(shape: { wrapped: RawShape }): R.Edge[];
  resolveFace(body: BodyStateLike, ref: FaceRef, warn: (message: string) => void): ResolvedFace;
  resolveEdges(
    body: BodyStateLike,
    refs: readonly EdgeRef[],
    warn: (message: string) => void,
  ): { topology: TopologyLike; indices: number[] };
  /** Boolean of `tool` into `target` (in place), naming faces from OCCT's history. */
  combine(
    target: BodyStateLike,
    tool: { shape: Shape3D; faces: KeyedFace[] },
    operation: 'join' | 'cut' | 'intersect',
    featureId: string,
    featureOrder: ReadonlyMap<string, number>,
  ): void;
  /**
   * Keyed faces of an operation result (reference scheme v2): from the
   * builder's history (`null`: identity and surface identity only), then
   * `nameNew` for faces nothing explains.
   */
  nameResult(
    result: Shape3D,
    history: HistorySource | null,
    inputs: { shape: Shape3D; faces: readonly KeyedFace[]; reversed?: boolean }[],
    featureOrder: ReadonlyMap<string, number>,
    nameNew: (
      index: number,
      provisional: readonly (KeyedFaceKeys | null)[],
      topology: TopologyLike,
    ) => string,
    generators?: { raw: RawShape; role: string }[],
  ): KeyedFace[];
  withKeys(geoms: FaceGeom[], keys: KeyedFaceKeys[]): KeyedFace[];
  diagonalOf(shape: Shape3D): number;
  /** Cached bounding box `[min, max]` of `shape` (world, mm). */
  boundsOf(shape: Shape3D): [[number, number, number], [number, number, number]];
  /** Adds a body to the replay (creation order, default colour from the palette unless given). */
  addBody(
    ctx: ReplayContextLike,
    body: { id: string; name: string; createdBy: string; shape: Shape3D; faces: KeyedFace[] },
    color?: string,
  ): BodyStateLike;
}
