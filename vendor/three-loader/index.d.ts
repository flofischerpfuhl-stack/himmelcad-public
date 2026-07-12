// Public type surface for the vendored @pnext/three-loader (Himmelcad fork).
//
// WHY THIS FILE EXISTS
// --------------------
// Our viewer compiles under a strict tsconfig (verbatimModuleSyntax,
// noUncheckedIndexedAccess, exactOptionalPropertyTypes, …). The upstream
// three-loader source predates several of those strict-mode options and
// pulls in a lot of internal types we don't consume. Type-checking the
// full vendored TS tree from the consumer side adds noise without
// improving safety on the surfaces we actually use.
//
// Strategy: `package.json` sets `main` → `src/index.ts` (Vite bundles
// the real source) but `types` → this file. tsc therefore sees this
// permissive surface, while the runtime still ships the full vendored
// implementation. Anything we want statically checked across the
// boundary lives here.
//
// When upstream API changes break our adapter code, update *this* file
// — not the vendored implementation — unless the change is a true bug
// we want to fix in the fork. Keep entries alphabetical by symbol name
// within each group.

import type { Camera, Material, Object3D, Ray, Vector3, WebGLRenderer } from 'three';

// ──────────────────────────────────────────────────────────────────────
// Loader plumbing
// ──────────────────────────────────────────────────────────────────────

export type GetUrlFn = (url: string) => Promise<string>;
export type XhrRequest = (input: RequestInfo, init?: RequestInit) => Promise<Response>;

// ──────────────────────────────────────────────────────────────────────
// Material
// ──────────────────────────────────────────────────────────────────────

export interface PointCloudMaterial extends Material {
  size: number;
  pointSizeType: number;
  shape: number;
  // Loose record so we don't have to model every shader uniform here.
  [k: string]: unknown;
}

// ──────────────────────────────────────────────────────────────────────
// PointCloudOctree (the on-scene wrapper)
// ──────────────────────────────────────────────────────────────────────

export interface PointCloudOctreeNode {
  geometryNode: { numPoints?: number; level?: number };
  numPoints: number;
  level: number;
  sceneNode: Object3D;
  boundingBox: { min: Vector3; max: Vector3 };
}

// PointCloudOctree is an Object3D subclass at runtime; we declare it as
// the intersection here so consumers get the full Object3D surface
// (position, name, updateMatrixWorld, …) without re-declaring 70+
// properties. When TypeScript widens this in a future release we may
// switch to a plain `class … extends Object3D { … }` declaration; the
// intersection works around its current limitations with `extends` in
// merged ambient class declarations.
export interface PointCloudOctreeFields {
  material: PointCloudMaterial;
  visibleNodes: PointCloudOctreeNode[];
  numVisiblePoints: number;
  showBoundingBox: boolean;
  minNodePixelSize: number;
  maxLevel?: number;
  disposed: boolean;
  pcoGeometry: {
    boundingBox: { min: Vector3; max: Vector3 };
    maxNumNodesLoading: number;
    offset?: Vector3;
  };
  root: PointCloudOctreeNode | null;
  initialized(): boolean;
  dispose(): void;
}
export type PointCloudOctree = Object3D & PointCloudOctreeFields;
export const PointCloudOctree: {
  new (...args: unknown[]): PointCloudOctree;
  prototype: PointCloudOctree;
};

// ──────────────────────────────────────────────────────────────────────
// Potree scheduler
// ──────────────────────────────────────────────────────────────────────

export type PotreeVersion = 'v1' | 'v2';

export interface VisibilityUpdateResult {
  visibleNodes: PointCloudOctreeNode[];
  numVisiblePoints: number;
  exceededMaxLoadsToGPU: boolean;
  nodeLoadFailed: boolean;
  nodeLoadPromises: Promise<void>[];
}

export interface PickPoint {
  position: Vector3;
  normal?: Vector3;
  pointCloud: PointCloudOctree;
  pointIndex?: number;
  [k: string]: unknown;
}

export interface PickParams {
  pickWindowSize: number;
  pickOutsideClipRegion: boolean;
  pickClipped: boolean;
  pointSizeType: number;
  onlyClampedPoints: boolean;
}

export class Potree {
  constructor(version?: PotreeVersion);
  pointBudget: number;
  maxLoadsToGPU: number;
  maxNumNodesLoading: number;
  memoryScale: number;
  loadPointCloud(
    url: string,
    getUrl: GetUrlFn,
    xhrRequest?: XhrRequest,
    loadHarmonics?: boolean,
    maxAmountOfSplats?: number,
  ): Promise<PointCloudOctree>;
  updatePointClouds(
    pointClouds: PointCloudOctree[],
    camera: Camera,
    renderer: WebGLRenderer,
    callback?: () => void,
  ): VisibilityUpdateResult;
  static pick(
    pointClouds: PointCloudOctree[],
    renderer: WebGLRenderer,
    camera: Camera,
    ray: Ray,
    params?: Partial<PickParams>,
  ): PickPoint | null;
  static maxLoaderWorkers: number;
}
