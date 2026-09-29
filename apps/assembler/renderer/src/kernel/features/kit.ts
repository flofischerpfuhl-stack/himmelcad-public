/**
 * The evaluator internals the modelling-feature modules in this folder may
 * use. `evaluator.ts` builds one {@link FeatureKit} per evaluator and hands
 * it, with its replay context, to {@link applyModelingFeature}
 * (`./index.ts`). The shapes here are structural mirrors of the
 * evaluator's private types, so the evaluator stays the single owner of
 * body state, profile construction and reference resolution.
 */
import type * as R from 'replicad';

import type { CurveKind, EdgeRef, FaceRef, SketchFeature, Vec3 } from '../../model/document.js';
import type { SketchRegion } from '../../sketch/regions.js';
import type { FaceGeom, KeyedFace, KeyedFaceKeys } from '../naming.js';
import type { EvaluatedSketch } from '../types.js';

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

export interface TopologyLike {
  faces: R.Face[];
  edges: R.Edge[];
  faceEdges: number[][];
  edgeFaces: number[][];
  edgeGeoms: {
    curve: CurveKind;
    midpoint: Vec3;
    length: number;
    direction: Vec3 | null;
    radius: number | null;
  }[];
}

export interface ReplayContextLike {
  bodies: Map<string, BodyStateLike>;
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

export interface ResolvedFace {
  face: R.Face;
  geom: KeyedFace;
  topology: TopologyLike;
  index: number;
}

export interface FeatureKit {
  oc: OpenCascade;
  /** Throws the evaluator's per-feature error (shown on the history card / tool pill). */
  fail(message: string): never;
  /** `true` for an error raised by {@link fail} (so wrappers don't re-wrap it). */
  isFailure(error: unknown): boolean;
  /** Readable text for an OCCT/JS exception. */
  describeError(error: unknown): string;
  describeFace(face: R.Face): FaceGeom;
  topologyOf(shape: Shape3D): TopologyLike;
  resolveFace(body: BodyStateLike, ref: FaceRef, warn: (message: string) => void): ResolvedFace;
  resolveEdges(
    body: BodyStateLike,
    refs: readonly EdgeRef[],
    warn: (message: string) => void,
  ): { topology: TopologyLike; indices: number[] };
  /** Boolean of `tool` into `target` (in place), propagating face keys. */
  combine(
    target: BodyStateLike,
    tool: { shape: Shape3D; faces: KeyedFace[] },
    operation: 'join' | 'cut' | 'intersect',
    featureId: string,
    featureOrder: ReadonlyMap<string, number>,
  ): void;
  withKeys(geoms: FaceGeom[], keys: KeyedFaceKeys[]): KeyedFace[];
  diagonalOf(shape: Shape3D): number;
  /** Adds a body to the replay (creation order, default colour from the palette unless given). */
  addBody(
    ctx: ReplayContextLike,
    body: { id: string; name: string; createdBy: string; shape: Shape3D; faces: KeyedFace[] },
    color?: string,
  ): BodyStateLike;
}
