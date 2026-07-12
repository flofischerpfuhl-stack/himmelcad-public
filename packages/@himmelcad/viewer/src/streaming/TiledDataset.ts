import type { Camera } from 'three';

import type { Bounds3, GeometryDatasetKind } from '@himmelcad/data';

export type TileId = string & { readonly __brand: 'TileId' };

export type TileLoadState = 'unloaded' | 'queued' | 'loading' | 'loaded' | 'failed';

export type TileTransparencyMode =
  | 'opaque'
  | 'alpha-test'
  | 'layer-opacity'
  | 'sorted-alpha'
  | 'weighted-oit';

export interface TileContentStats {
  readonly points?: number;
  readonly triangles?: number;
  readonly splats?: number;
  readonly textureBytes?: number;
  readonly gpuBytes?: number;
  readonly drawCalls?: number;
  readonly hasTransparency?: boolean;
  readonly transparencyMode?: TileTransparencyMode;
}

export type TileSpatialIndexKind =
  | 'none'
  | 'point-octree'
  | 'triangle-bvh'
  | 'grid'
  | 'splat-tree'
  | 'cad-direct';

export interface TileSpatialIndexRef {
  readonly kind: TileSpatialIndexKind;
  readonly status: 'ready' | 'missing' | 'runtime-fallback';
  readonly version?: number;
  readonly url?: string;
}

export interface Tile {
  readonly id: TileId;
  readonly bounds: Bounds3;
  readonly geometricError: number;
  readonly content: TileContentStats;
  readonly pickIndex: TileSpatialIndexRef;
  readonly children: TileId[];
  readonly parent: TileId | null;
}

export interface ScreenSpaceErrorContext {
  readonly camera: Camera;
  readonly viewportHeight: number;
  readonly fovY: number;
}

/**
 * Common contract for any tile-based large dataset: point clouds (octrees),
 * tiled meshes (BVH/3D Tiles), tiled textures (mipmap pyramid), Gaussian splat
 * trees. The streaming service operates on this contract without knowing the
 * concrete data type, which keeps the budget logic and eviction unified.
 */
export interface TiledDataset {
  readonly id: string;
  readonly kind: GeometryDatasetKind;
  readonly rootTile: TileId;

  getTile(id: TileId): Tile | null;
  getLoadedTileIds(): readonly TileId[];
  getTileLoadState(id: TileId): TileLoadState;
  computeScreenSpaceError(tile: Tile, ctx: ScreenSpaceErrorContext): number;
  /** Called once per throttled scheduler update before visibility traversal. */
  prepareFrame?(ctx: ScreenSpaceErrorContext): void;
  /** Cheap frustum/viewport rejection performed before hierarchy refinement. */
  isTileVisible?(tile: Tile, ctx: ScreenSpaceErrorContext): boolean;
  loadTile(id: TileId): Promise<void>;
  unloadTile(id: TileId): void;
  isLoaded(id: TileId): boolean;
  /** Scheduler-selected visibility; loaded fallback parents remain available but hidden. */
  setTileVisible?(id: TileId, visible: boolean): void;
  /** Optional camera-dependent, tile/block-level ordering. Never performs per-primitive work. */
  updateForCamera?(ctx: ScreenSpaceErrorContext): void;
  /** Product layers switch presentation without replacing their immutable tile data. */
  setNavigationMode?(mode: 'orbit3d' | 'lockedTopDown2d'): void;
  dispose?(): void;
}
