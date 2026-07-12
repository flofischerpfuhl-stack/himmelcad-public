import type { Bounds3 } from '@himmelcad/data';
import {
  BufferAttribute,
  BufferGeometry,
  ClampToEdgeWrapping,
  DoubleSide,
  LinearFilter,
  Mesh,
  MeshBasicMaterial,
  SRGBColorSpace,
  Texture,
} from 'three';

import type { TileId } from '../streaming/TiledDataset.js';
import {
  asTileId,
  fetchChecked,
  finiteNumber,
  positiveInteger,
  ProductTileDataset,
  record,
  resolveAssetUrl,
  stringValue,
} from './ProductTileDataset.js';
import type { ProductTile } from './ProductTileDataset.js';

export interface PreparedMeshTileManifest {
  readonly id: string;
  readonly parent: string | null;
  readonly children: readonly string[];
  readonly bounds: Bounds3;
  /** World-space f64 anchor; position buffers are f32 relative to this origin. */
  readonly origin: readonly [number, number, number];
  readonly geometricError: number;
  readonly vertexCount: number;
  readonly indexCount: number;
  readonly positionUrl: string;
  readonly indexUrl: string;
  readonly indexComponentType: 'uint16' | 'uint32';
  readonly normalUrl?: string;
  readonly uvUrl?: string;
  readonly textureUrl?: string;
  readonly bvh: { readonly url: string; readonly version: number };
}

export interface TiledMeshManifest {
  readonly schemaVersion: 1;
  readonly rootTileId: string;
  readonly tiles: readonly PreparedMeshTileManifest[];
}

export interface TiledMeshDatasetOptions {
  readonly id: string;
  readonly renderOffset: readonly [number, number, number];
  readonly opacity?: number;
}

/** Prepared binary mesh tiles with persisted BVH references for exact core revalidation. */
export class TiledMeshDataset extends ProductTileDataset {
  readonly manifest: TiledMeshManifest;
  readonly manifestUrl: string;
  private readonly baseUrl: string;
  private readonly options: TiledMeshDatasetOptions;
  private readonly manifests = new Map<TileId, PreparedMeshTileManifest>();
  private readonly tiles = new Map<TileId, ProductTile>();

  static async load(
    manifestUrl: string,
    options: TiledMeshDatasetOptions,
  ): Promise<TiledMeshDataset> {
    const response = await fetch(manifestUrl, { cache: 'force-cache' });
    if (!response.ok) throw new Error(`Mesh manifest request failed (${response.status})`);
    return new TiledMeshDataset(
      manifestUrl,
      parseTiledMeshManifest(await response.json()),
      options,
    );
  }

  constructor(manifestUrl: string, manifest: TiledMeshManifest, options: TiledMeshDatasetOptions) {
    super({
      id: options.id,
      kind: 'textured-mesh',
      rootTile: asTileId(manifest.rootTileId),
      renderOffset: options.renderOffset,
    });
    this.manifest = manifest;
    this.manifestUrl = manifestUrl;
    this.options = options;
    this.baseUrl = new URL('.', manifestUrl).toString();
    for (const item of manifest.tiles) {
      const id = asTileId(item.id);
      this.manifests.set(id, item);
      this.tiles.set(id, {
        id,
        worldBounds: item.bounds,
        bounds: this.localBounds(item.bounds),
        geometricError: item.geometricError,
        content: {
          triangles: Math.floor(item.indexCount / 3),
          textureBytes: item.textureUrl ? 4 * 1024 * 1024 : 0,
          gpuBytes:
            item.vertexCount * (3 + (item.normalUrl ? 3 : 0) + (item.uvUrl ? 2 : 0)) * 4 +
            item.indexCount * (item.indexComponentType === 'uint16' ? 2 : 4),
          drawCalls: 1,
          hasTransparency: (options.opacity ?? 1) < 1,
          transparencyMode: (options.opacity ?? 1) < 1 ? 'layer-opacity' : 'opaque',
        },
        pickIndex: {
          kind: 'triangle-bvh',
          status: 'ready',
          version: item.bvh.version,
          url: resolveAssetUrl(this.baseUrl, item.bvh.url),
        },
        children: item.children.map(asTileId),
        parent: item.parent ? asTileId(item.parent) : null,
      });
    }
  }

  getTile(id: TileId): ProductTile | null {
    return this.tiles.get(id) ?? null;
  }

  async loadTile(id: TileId): Promise<void> {
    const signal = this.beginLoad(id);
    if (!signal) return;
    let acquiredTexture: Texture | null = null;
    let textureLoadPromise: Promise<Texture | null> | null = null;
    try {
      const tile = this.manifests.get(id);
      if (!tile) throw new Error(`Unknown mesh tile: ${String(id)}`);
      textureLoadPromise = tile.textureUrl
        ? loadMeshTexture(resolveAssetUrl(this.baseUrl, tile.textureUrl), signal).then(
            (texture) => {
              acquiredTexture = texture;
              return texture;
            },
          )
        : Promise.resolve(null);
      const requests = [
        fetchArrayBuffer(this.baseUrl, tile.positionUrl, signal),
        fetchArrayBuffer(this.baseUrl, tile.indexUrl, signal),
        tile.normalUrl
          ? fetchArrayBuffer(this.baseUrl, tile.normalUrl, signal)
          : Promise.resolve(null),
        tile.uvUrl ? fetchArrayBuffer(this.baseUrl, tile.uvUrl, signal) : Promise.resolve(null),
        textureLoadPromise,
      ] as const;
      const [positionBuffer, indexBuffer, normalBuffer, uvBuffer, texture] =
        await Promise.all(requests);
      validateByteLength(positionBuffer, tile.vertexCount * 3 * 4, 'positions');
      validateByteLength(
        indexBuffer,
        tile.indexCount * (tile.indexComponentType === 'uint16' ? 2 : 4),
        'indices',
      );
      if (normalBuffer) validateByteLength(normalBuffer, tile.vertexCount * 3 * 4, 'normals');
      if (uvBuffer) validateByteLength(uvBuffer, tile.vertexCount * 2 * 4, 'uvs');
      if (signal.aborted) {
        texture?.dispose();
        throw new DOMException('Tile load aborted', 'AbortError');
      }
      const geometry = new BufferGeometry();
      const positions = new Float32Array(positionBuffer);
      geometry.setAttribute('position', new BufferAttribute(positions, 3));
      if (normalBuffer)
        geometry.setAttribute('normal', new BufferAttribute(new Float32Array(normalBuffer), 3));
      if (uvBuffer) geometry.setAttribute('uv', new BufferAttribute(new Float32Array(uvBuffer), 2));
      geometry.setIndex(
        new BufferAttribute(
          tile.indexComponentType === 'uint16'
            ? new Uint16Array(indexBuffer)
            : new Uint32Array(indexBuffer),
          1,
        ),
      );
      const material = new MeshBasicMaterial({
        map: texture,
        color: texture ? 0xffffff : 0xa7aaad,
        opacity: Math.max(0, Math.min(1, this.options.opacity ?? 1)),
        transparent: (this.options.opacity ?? 1) < 1 || texture !== null,
        alphaTest: texture ? 0.005 : 0,
        side: DoubleSide,
      });
      const mesh = new Mesh(geometry, material);
      mesh.position.set(
        tile.origin[0] - this.renderOffset[0],
        tile.origin[1] - this.renderOffset[1],
        tile.origin[2] - this.renderOffset[2],
      );
      mesh.name = `mesh:${this.id}:${String(id)}`;
      // Dataset-level f64-aware bounds avoid an O(N) runtime bounds pass.
      mesh.frustumCulled = false;
      mesh.userData['hcadBvh'] = this.tiles.get(id)?.pickIndex;
      this.commitLoad(id, mesh);
      acquiredTexture = null;
    } catch (error) {
      if (textureLoadPromise) await Promise.allSettled([textureLoadPromise]);
      disposeDecodedTexture(acquiredTexture);
      this.failLoad(id, error);
    }
  }
}

function disposeDecodedTexture(texture: Texture | null): void {
  if (!texture) return;
  const image: unknown = texture.source.data;
  if (typeof image === 'object' && image !== null && 'close' in image) {
    (image as { close(): void }).close();
  }
  texture.dispose();
}

async function fetchArrayBuffer(
  baseUrl: string,
  relativeUrl: string,
  signal: AbortSignal,
): Promise<ArrayBuffer> {
  return (await fetchChecked(resolveAssetUrl(baseUrl, relativeUrl), signal)).arrayBuffer();
}

async function loadMeshTexture(url: string, signal: AbortSignal): Promise<Texture> {
  const response = await fetchChecked(url, signal);
  const bitmap = await createImageBitmap(await response.blob(), { premultiplyAlpha: 'none' });
  if (signal.aborted) {
    bitmap.close();
    throw new DOMException('Tile load aborted', 'AbortError');
  }
  const texture = new Texture(bitmap);
  texture.needsUpdate = true;
  texture.colorSpace = SRGBColorSpace;
  texture.minFilter = LinearFilter;
  texture.magFilter = LinearFilter;
  texture.wrapS = ClampToEdgeWrapping;
  texture.wrapT = ClampToEdgeWrapping;
  texture.generateMipmaps = false;
  return texture;
}

function validateByteLength(buffer: ArrayBuffer, expected: number, field: string): void {
  if (buffer.byteLength !== expected) {
    throw new Error(`Mesh ${field} has ${buffer.byteLength} bytes; expected ${expected}`);
  }
}

export function parseTiledMeshManifest(value: unknown): TiledMeshManifest {
  const root = record(value, 'mesh manifest');
  if (positiveInteger(root['schemaVersion'], 'schemaVersion') !== 1) {
    throw new Error('Unsupported mesh manifest schema version');
  }
  const rootTileId = stringValue(root['rootTileId'], 'rootTileId');
  if (!Array.isArray(root['tiles']) || root['tiles'].length === 0) {
    throw new Error('Mesh manifest has no tiles');
  }
  const tiles = root['tiles'].map((entry, index) => parseMeshTile(entry, index));
  const ids = new Set(tiles.map((tile) => tile.id));
  if (!ids.has(rootTileId) || ids.size !== tiles.length) {
    throw new Error('Mesh tile ids are duplicated or root is missing');
  }
  for (const tile of tiles) {
    if (tile.parent && !ids.has(tile.parent))
      throw new Error(`Missing mesh parent: ${tile.parent}`);
    for (const child of tile.children)
      if (!ids.has(child)) throw new Error(`Missing mesh child: ${child}`);
  }
  return { schemaVersion: 1, rootTileId, tiles };
}

function parseMeshTile(value: unknown, index: number): PreparedMeshTileManifest {
  const tile = record(value, `tiles[${index}]`);
  const component = stringValue(tile['indexComponentType'], `tiles[${index}].indexComponentType`);
  if (component !== 'uint16' && component !== 'uint32') {
    throw new Error(`Unsupported mesh index component: ${component}`);
  }
  const children = tile['children'];
  if (!Array.isArray(children) || !children.every((child) => typeof child === 'string')) {
    throw new Error(`Invalid mesh children: tiles[${index}]`);
  }
  const parentValue = tile['parent'];
  if (parentValue !== null && typeof parentValue !== 'string') {
    throw new Error(`Invalid mesh parent: tiles[${index}]`);
  }
  const bvh = record(tile['bvh'], `tiles[${index}].bvh`);
  const origin = tile['origin'];
  if (!Array.isArray(origin) || origin.length !== 3) {
    throw new Error(`Invalid mesh origin: tiles[${index}]`);
  }
  return {
    id: stringValue(tile['id'], `tiles[${index}].id`),
    parent: parentValue,
    children,
    bounds: parseBounds(tile['bounds'], `tiles[${index}].bounds`),
    origin: [
      finiteNumber(origin[0], `tiles[${index}].origin[0]`),
      finiteNumber(origin[1], `tiles[${index}].origin[1]`),
      finiteNumber(origin[2], `tiles[${index}].origin[2]`),
    ],
    geometricError: finiteNumber(tile['geometricError'], `tiles[${index}].geometricError`),
    vertexCount: positiveInteger(tile['vertexCount'], `tiles[${index}].vertexCount`),
    indexCount: positiveInteger(tile['indexCount'], `tiles[${index}].indexCount`),
    positionUrl: stringValue(tile['positionUrl'], `tiles[${index}].positionUrl`),
    indexUrl: stringValue(tile['indexUrl'], `tiles[${index}].indexUrl`),
    indexComponentType: component,
    ...optionalString(tile, 'normalUrl'),
    ...optionalString(tile, 'uvUrl'),
    ...optionalString(tile, 'textureUrl'),
    bvh: {
      url: stringValue(bvh['url'], `tiles[${index}].bvh.url`),
      version: positiveInteger(bvh['version'], `tiles[${index}].bvh.version`),
    },
  };
}

function parseBounds(value: unknown, field: string): Bounds3 {
  const bounds = record(value, field);
  const min = record(bounds['min'], `${field}.min`);
  const max = record(bounds['max'], `${field}.max`);
  const parsed = {
    min: {
      x: finiteNumber(min['x'], `${field}.min.x`),
      y: finiteNumber(min['y'], `${field}.min.y`),
      z: finiteNumber(min['z'], `${field}.min.z`),
    },
    max: {
      x: finiteNumber(max['x'], `${field}.max.x`),
      y: finiteNumber(max['y'], `${field}.max.y`),
      z: finiteNumber(max['z'], `${field}.max.z`),
    },
  };
  if (parsed.max.x < parsed.min.x || parsed.max.y < parsed.min.y || parsed.max.z < parsed.min.z) {
    throw new Error(`Invalid bounds: ${field}`);
  }
  return parsed;
}

function optionalString<K extends 'normalUrl' | 'uvUrl' | 'textureUrl'>(
  value: Record<string, unknown>,
  key: K,
): Partial<Record<K, string>> {
  const item = value[key];
  if (item === undefined || item === null) return {};
  return { [key]: stringValue(item, key) } as Partial<Record<K, string>>;
}
