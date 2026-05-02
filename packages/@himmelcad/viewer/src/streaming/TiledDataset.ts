import type { Camera } from 'three';

import type { Bounds3 } from '@himmelcad/data';

export type TileId = string & { readonly __brand: 'TileId' };

export interface Tile {
  readonly id: TileId;
  readonly bounds: Bounds3;
  readonly geometricError: number;
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
  readonly rootTile: TileId;

  getTile(id: TileId): Tile | null;
  computeScreenSpaceError(tile: Tile, ctx: ScreenSpaceErrorContext): number;
  loadTile(id: TileId): Promise<void>;
  unloadTile(id: TileId): void;
  isLoaded(id: TileId): boolean;
}
