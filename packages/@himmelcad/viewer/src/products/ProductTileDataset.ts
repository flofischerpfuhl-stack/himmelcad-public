import type { Bounds3, GeometryDatasetKind } from '@himmelcad/data';
import { Box3, Frustum, Group, Matrix4, Vector3 } from 'three';
import type { Object3D } from 'three';

import type {
  ScreenSpaceErrorContext,
  Tile,
  TiledDataset,
  TileId,
  TileLoadState,
} from '../streaming/TiledDataset.js';

export interface ProductTile extends Tile {
  readonly worldBounds: Bounds3;
}

/** Shared lifecycle and precision contract for prepared PhotoLab product tiles. */
export abstract class ProductTileDataset implements TiledDataset {
  readonly root = new Group();
  readonly id: string;
  readonly kind: GeometryDatasetKind;
  readonly rootTile: TileId;
  /** World `[Easting, Northing, Height]` represented by this dataset's local origin. */
  readonly renderOffset: readonly [number, number, number];
  protected readonly states = new Map<TileId, TileLoadState>();
  protected readonly objects = new Map<TileId, Object3D>();
  protected readonly abortControllers = new Map<TileId, AbortController>();
  private readonly frustum = new Frustum();
  private readonly projectionView = new Matrix4();
  private readonly testBox = new Box3();

  protected constructor(options: {
    id: string;
    kind: GeometryDatasetKind;
    rootTile: TileId;
    renderOffset: readonly [number, number, number];
  }) {
    this.id = options.id;
    this.kind = options.kind;
    this.rootTile = options.rootTile;
    this.renderOffset = options.renderOffset;
    this.root.name = `product:${options.id}`;
  }

  abstract getTile(id: TileId): ProductTile | null;
  abstract loadTile(id: TileId): Promise<void>;

  getLoadedTileIds(): readonly TileId[] {
    return Array.from(this.objects.keys());
  }

  getTileLoadState(id: TileId): TileLoadState {
    return this.states.get(id) ?? 'unloaded';
  }

  prepareFrame(ctx: ScreenSpaceErrorContext): void {
    ctx.camera.updateMatrixWorld();
    this.root.updateMatrixWorld(true);
    this.projectionView.multiplyMatrices(
      ctx.camera.projectionMatrix,
      ctx.camera.matrixWorldInverse,
    );
    this.frustum.setFromProjectionMatrix(this.projectionView);
  }

  isTileVisible(tile: Tile): boolean {
    const bounds = tile.bounds;
    this.testBox.min.set(bounds.min.x, bounds.min.y, bounds.min.z);
    this.testBox.max.set(bounds.max.x, bounds.max.y, bounds.max.z);
    this.testBox.applyMatrix4(this.root.matrixWorld);
    return this.frustum.intersectsBox(this.testBox);
  }

  computeScreenSpaceError(tile: Tile, ctx: ScreenSpaceErrorContext): number {
    const bounds = tile.bounds;
    const centerX = (bounds.min.x + bounds.max.x) * 0.5 + this.root.position.x;
    const centerY = (bounds.min.y + bounds.max.y) * 0.5 + this.root.position.y;
    const centerZ = (bounds.min.z + bounds.max.z) * 0.5 + this.root.position.z;
    const dx = ctx.camera.position.x - centerX;
    const dy = ctx.camera.position.y - centerY;
    const dz = ctx.camera.position.z - centerZ;
    const distance = Math.max(Math.sqrt(dx * dx + dy * dy + dz * dz), tile.geometricError);
    return (tile.geometricError * ctx.viewportHeight) / (2 * distance * Math.tan(ctx.fovY * 0.5));
  }

  isLoaded(id: TileId): boolean {
    return this.states.get(id) === 'loaded';
  }

  setTileVisible(id: TileId, visible: boolean): void {
    const object = this.objects.get(id);
    if (object) object.visible = visible;
  }

  unloadTile(id: TileId): void {
    this.abortControllers.get(id)?.abort();
    this.abortControllers.delete(id);
    const object = this.objects.get(id);
    if (object) {
      this.root.remove(object);
      disposeObject(object);
      this.objects.delete(id);
    }
    this.states.set(id, 'unloaded');
  }

  dispose(): void {
    for (const controller of this.abortControllers.values()) controller.abort();
    this.abortControllers.clear();
    for (const id of Array.from(this.objects.keys())) this.unloadTile(id);
  }

  protected beginLoad(id: TileId): AbortSignal | null {
    const state = this.getTileLoadState(id);
    if (state === 'loaded' || state === 'loading') return null;
    const controller = new AbortController();
    this.abortControllers.set(id, controller);
    this.states.set(id, 'loading');
    return controller.signal;
  }

  protected commitLoad(id: TileId, object: Object3D): void {
    this.abortControllers.delete(id);
    object.visible = false;
    this.objects.set(id, object);
    this.root.add(object);
    this.states.set(id, 'loaded');
  }

  protected failLoad(id: TileId, error: unknown): never {
    this.abortControllers.delete(id);
    this.states.set(id, isAbortError(error) ? 'unloaded' : 'failed');
    throw error;
  }

  protected localBounds(world: Bounds3): Bounds3 {
    return {
      min: {
        x: world.min.x - this.renderOffset[0],
        y: world.min.y - this.renderOffset[1],
        z: world.min.z - this.renderOffset[2],
      },
      max: {
        x: world.max.x - this.renderOffset[0],
        y: world.max.y - this.renderOffset[1],
        z: world.max.z - this.renderOffset[2],
      },
    };
  }
}

export function asTileId(value: string): TileId {
  return value as TileId;
}

export function resolveAssetUrl(baseUrl: string, relative: string): string {
  if (/^[a-z][a-z0-9+.-]*:/i.test(relative)) return relative;
  return new URL(relative, baseUrl).toString();
}

export function substituteTileUrl(
  baseUrl: string,
  template: string,
  level: number,
  column: number,
  row: number,
): string {
  return resolveAssetUrl(
    baseUrl,
    template
      .replaceAll('{level}', String(level))
      .replaceAll('{z}', String(level))
      .replaceAll('{x}', String(column))
      .replaceAll('{y}', String(row)),
  );
}

export async function fetchChecked(url: string, signal: AbortSignal): Promise<Response> {
  const response = await fetch(url, { signal, cache: 'force-cache' });
  if (!response.ok) throw new Error(`Tile request failed (${response.status}): ${url}`);
  return response;
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError';
}

function disposeObject(root: Object3D): void {
  root.traverse((object) => {
    const candidate = object as Object3D & {
      geometry?: { dispose(): void };
      material?:
        | { dispose(): void; map?: DisposableTexture | null }
        | readonly { dispose(): void; map?: DisposableTexture | null }[];
    };
    candidate.geometry?.dispose();
    const materials = candidate.material
      ? Array.isArray(candidate.material)
        ? candidate.material
        : [candidate.material]
      : [];
    for (const material of materials) {
      const image = material.map?.source?.data;
      if (image && typeof image === 'object' && 'close' in image) image.close();
      material.map?.dispose();
      material.dispose();
    }
  });
  root.clear();
}

interface DisposableTexture {
  dispose(): void;
  source?: { data?: { close(): void } | null };
}

export function finiteNumber(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`Invalid numeric manifest field: ${field}`);
  }
  return value;
}

export function positiveInteger(value: unknown, field: string): number {
  const number = finiteNumber(value, field);
  if (!Number.isSafeInteger(number) || number <= 0) throw new Error(`Invalid integer: ${field}`);
  return number;
}

export function record(value: unknown, field: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`Invalid object manifest field: ${field}`);
  }
  return value as Record<string, unknown>;
}

export function stringValue(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`Invalid string manifest field: ${field}`);
  }
  return value;
}

export const TILE_CENTER = new Vector3();
