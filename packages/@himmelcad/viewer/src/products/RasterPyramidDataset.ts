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
  stringValue,
  substituteTileUrl,
} from './ProductTileDataset.js';
import type { ProductTile } from './ProductTileDataset.js';

export type RasterProductKind = 'orthomosaic' | 'dem';
export type RasterNoData =
  | { readonly kind: 'numeric'; readonly value: number }
  | { readonly kind: 'nan' }
  | { readonly kind: 'alphaMask' };

export interface RasterBoundsManifest {
  readonly minimumEast: number;
  readonly minimumNorth: number;
  readonly maximumEast: number;
  readonly maximumNorth: number;
}

export interface RasterViewLayerManifest {
  readonly name: string;
  readonly format:
    | { readonly kind: 'rgbaPng' }
    | {
        readonly kind: 'grayscalePng';
        readonly minimumElevation: number;
        readonly maximumElevation: number;
      }
    | {
        readonly kind: 'float32Raw';
        readonly byteOrder: 'littleEndian' | 'bigEndian';
        readonly width: number;
        readonly height: number;
      };
  readonly urlTemplate: string;
}

export interface RasterLevelManifest {
  readonly level: number;
  readonly columns: number;
  readonly rows: number;
  readonly bounds: RasterBoundsManifest;
  readonly gsd: number;
  readonly viewLayers: readonly RasterViewLayerManifest[];
}

export interface RasterPyramidManifest {
  readonly schemaVersion: 1;
  readonly tileSizePixels: number;
  readonly grid: {
    readonly bounds: RasterBoundsManifest;
    readonly widthPixels: number;
    readonly heightPixels: number;
    readonly gsd: number;
    readonly noData: RasterNoData;
  };
  readonly levels: readonly RasterLevelManifest[];
}

export interface RasterPyramidDatasetOptions {
  readonly id: string;
  readonly kind: RasterProductKind;
  readonly renderOffset: readonly [number, number, number];
  readonly surfaceElevation?: number;
  readonly terrainManifestUrl?: string;
  readonly opacity?: number;
}

interface RasterTileAddress {
  level: number;
  column: number;
  row: number;
}

interface TerrainSource {
  manifest: RasterPyramidManifest;
  baseUrl: string;
}

/** Browser-native GDAL-pyramid consumer for fast map and terrain presentation. */
export class RasterPyramidDataset extends ProductTileDataset {
  readonly manifest: RasterPyramidManifest;
  readonly manifestUrl: string;
  private readonly options: RasterPyramidDatasetOptions;
  private readonly baseUrl: string;
  private readonly tileCache = new Map<TileId, ProductTile>();
  private readonly highestLevel: number;
  private readonly terrainSource: TerrainSource | null;
  private navigationMode: 'orbit3d' | 'lockedTopDown2d' = 'orbit3d';

  static async load(
    manifestUrl: string,
    options: RasterPyramidDatasetOptions,
  ): Promise<RasterPyramidDataset> {
    const response = await fetch(manifestUrl, { cache: 'force-cache' });
    if (!response.ok) throw new Error(`Raster manifest request failed (${response.status})`);
    const manifest = parseRasterPyramidManifest(await response.json());
    let terrainSource: TerrainSource | null = null;
    if (options.terrainManifestUrl) {
      const terrainResponse = await fetch(options.terrainManifestUrl, { cache: 'force-cache' });
      if (!terrainResponse.ok) {
        throw new Error(`Terrain manifest request failed (${terrainResponse.status})`);
      }
      terrainSource = {
        manifest: parseRasterPyramidManifest(await terrainResponse.json()),
        // Raster manifests live in `<dataset>/pyramid/manifest.json`, while
        // their view-layer templates are rooted at `<dataset>/view/...`.
        baseUrl: new URL('../', options.terrainManifestUrl).toString(),
      };
    }
    return new RasterPyramidDataset(manifestUrl, manifest, options, terrainSource);
  }

  constructor(
    manifestUrl: string,
    manifest: RasterPyramidManifest,
    options: RasterPyramidDatasetOptions,
    terrainSource: TerrainSource | null = null,
  ) {
    const highestLevel = manifest.levels.length - 1;
    super({
      id: options.id,
      kind: options.kind === 'dem' ? 'dgm' : 'surface',
      rootTile: rasterTileId(highestLevel, 0, 0),
      renderOffset: options.renderOffset,
    });
    this.manifest = manifest;
    this.manifestUrl = manifestUrl;
    this.options = options;
    // See the manifest contract above: templates are dataset-root relative,
    // not relative to the nested `pyramid/` directory containing the JSON.
    this.baseUrl = new URL('../', manifestUrl).toString();
    this.highestLevel = highestLevel;
    this.terrainSource = terrainSource;
  }

  getTile(id: TileId): ProductTile | null {
    const cached = this.tileCache.get(id);
    if (cached) return cached;
    const address = parseRasterTileId(id);
    if (!address) return null;
    const level = this.manifest.levels[address.level];
    if (!level || address.column >= level.columns || address.row >= level.rows) return null;
    const worldBounds = rasterTileBounds(this.manifest, level, address.column, address.row);
    const zRange = this.elevationRangeFor(level);
    worldBounds.min.z = zRange[0];
    worldBounds.max.z = zRange[1];
    const localBounds = this.localBounds(worldBounds);
    const children = childTileIds(this.manifest, address);
    const parent =
      address.level < this.highestLevel
        ? rasterTileId(
            address.level + 1,
            Math.floor(address.column / 2),
            Math.floor(address.row / 2),
          )
        : null;
    const tile: ProductTile = {
      id,
      worldBounds,
      bounds: localBounds,
      geometricError: level.gsd,
      content: {
        triangles: this.usesTerrain() ? 8_192 : 2,
        textureBytes: this.manifest.tileSizePixels * this.manifest.tileSizePixels * 4,
        gpuBytes: this.usesTerrain()
          ? this.manifest.tileSizePixels * this.manifest.tileSizePixels * 8
          : this.manifest.tileSizePixels * this.manifest.tileSizePixels * 4,
        drawCalls: 1,
        hasTransparency: true,
        transparencyMode: 'alpha-test',
      },
      pickIndex: { kind: 'grid', status: this.options.kind === 'dem' ? 'ready' : 'missing' },
      children,
      parent,
    };
    this.tileCache.set(id, tile);
    return tile;
  }

  async loadTile(id: TileId): Promise<void> {
    const signal = this.beginLoad(id);
    if (!signal) return;
    let acquiredTexture: Texture | null = null;
    let textureLoadPromise: Promise<Texture | null> | null = null;
    try {
      const address = parseRasterTileId(id);
      const tile = this.getTile(id);
      if (!address || !tile) throw new Error(`Unknown raster tile: ${String(id)}`);
      const level = this.manifest.levels[address.level];
      if (!level) throw new Error(`Missing raster level: ${address.level}`);
      const colorLayer = selectColorLayer(level, this.options.kind);
      const texturePromise = colorLayer
        ? loadTexture(
            substituteTileUrl(
              this.baseUrl,
              colorLayer.urlTemplate,
              address.level,
              address.column,
              address.row,
            ),
            signal,
            this.options.kind === 'orthomosaic',
          ).then((texture) => {
            acquiredTexture = texture;
            return texture;
          })
        : Promise.resolve(null);
      textureLoadPromise = texturePromise;
      const heightSource = this.heightSourceFor(address);
      const heightPromise =
        this.navigationMode === 'orbit3d' && heightSource
          ? loadHeights(heightSource.url, heightSource.format, signal)
          : Promise.resolve(null);
      const [texture, heights] = await Promise.all([texturePromise, heightPromise]);
      if (signal.aborted) {
        texture?.dispose();
        throw new DOMException('Tile load aborted', 'AbortError');
      }
      const geometry = buildRasterGeometry(
        tile.bounds,
        heights,
        this.noDataForHeights(),
        this.navigationMode,
        this.flatSurfaceElevation(level) - this.renderOffset[2],
        this.renderOffset[2],
      );
      const material = new MeshBasicMaterial({
        map: texture,
        color: texture ? 0xffffff : 0x87909a,
        transparent: true,
        opacity: Math.max(0, Math.min(1, this.options.opacity ?? 1)),
        alphaTest: 0.005,
        depthWrite: true,
        side: DoubleSide,
      });
      const mesh = new Mesh(geometry, material);
      mesh.name = `raster:${this.id}:${String(id)}`;
      mesh.frustumCulled = true;
      mesh.userData['hcadTileId'] = id;
      this.commitLoad(id, mesh);
      acquiredTexture = null;
    } catch (error) {
      if (textureLoadPromise) await Promise.allSettled([textureLoadPromise]);
      disposeDecodedTexture(acquiredTexture);
      this.failLoad(id, error);
    }
  }

  setNavigationMode(mode: 'orbit3d' | 'lockedTopDown2d'): void {
    if (this.navigationMode === mode) return;
    this.navigationMode = mode;
    // Geometry is mode-specific. Retaining decoded full-resolution heights would
    // violate the memory budget, so tiles are cheaply re-requested from cache.
    const resident = new Set([...this.objects.keys(), ...this.abortControllers.keys()]);
    for (const id of resident) this.unloadTile(id);
  }

  private usesTerrain(): boolean {
    return this.options.kind === 'dem' || this.terrainSource !== null;
  }

  private heightSourceFor(address: RasterTileAddress): HeightSource | null {
    const source =
      this.options.kind === 'dem'
        ? { manifest: this.manifest, baseUrl: this.baseUrl }
        : this.terrainSource;
    if (!source) return null;
    const displayLevel = this.manifest.levels[address.level];
    if (!displayLevel) return null;
    const level = closestTerrainLevel(source.manifest, displayLevel.gsd);
    if (!level) return null;
    const raw = level.viewLayers.find((layer) => layer.format.kind === 'float32Raw');
    if (!raw || raw.format.kind !== 'float32Raw') return null;
    const displayBounds = rasterTileBounds(
      this.manifest,
      displayLevel,
      address.column,
      address.row,
    );
    const centerEast = (displayBounds.min.x + displayBounds.max.x) * 0.5;
    const centerNorth = (displayBounds.min.y + displayBounds.max.y) * 0.5;
    const terrainBounds = level.bounds;
    if (
      centerEast < terrainBounds.minimumEast ||
      centerEast > terrainBounds.maximumEast ||
      centerNorth < terrainBounds.minimumNorth ||
      centerNorth > terrainBounds.maximumNorth
    ) {
      return null;
    }
    const tileWidth =
      (terrainBounds.maximumEast - terrainBounds.minimumEast) / Math.max(1, level.columns);
    const tileHeight =
      (terrainBounds.maximumNorth - terrainBounds.minimumNorth) / Math.max(1, level.rows);
    const terrainColumn = Math.min(
      level.columns - 1,
      Math.max(0, Math.floor((centerEast - terrainBounds.minimumEast) / tileWidth)),
    );
    // Raster rows are north-to-south, matching rasterTileBounds().
    const terrainRow = Math.min(
      level.rows - 1,
      Math.max(0, Math.floor((terrainBounds.maximumNorth - centerNorth) / tileHeight)),
    );
    return {
      url: substituteTileUrl(
        source.baseUrl,
        raw.urlTemplate,
        level.level,
        terrainColumn,
        terrainRow,
      ),
      format: raw.format,
    };
  }

  private noDataForHeights(): RasterNoData {
    return this.options.kind === 'dem'
      ? this.manifest.grid.noData
      : (this.terrainSource?.manifest.grid.noData ?? { kind: 'nan' });
  }

  private elevationRangeFor(level: RasterLevelManifest): readonly [number, number] {
    if (this.options.kind === 'dem') return elevationRange(level);
    const terrainLevel = this.terrainSource
      ? closestTerrainLevel(this.terrainSource.manifest, level.gsd)
      : undefined;
    if (terrainLevel) return elevationRange(terrainLevel);
    const elevation = this.options.surfaceElevation ?? 0;
    return [elevation, elevation];
  }

  private flatSurfaceElevation(level: RasterLevelManifest): number {
    if (this.options.surfaceElevation !== undefined) return this.options.surfaceElevation;
    const range = this.elevationRangeFor(level);
    return (range[0] + range[1]) * 0.5;
  }
}

function closestTerrainLevel(
  manifest: RasterPyramidManifest,
  targetGsd: number,
): RasterLevelManifest | undefined {
  return manifest.levels.reduce<RasterLevelManifest | undefined>((best, candidate) => {
    if (!best) return candidate;
    return Math.abs(candidate.gsd - targetGsd) < Math.abs(best.gsd - targetGsd)
      ? candidate
      : best;
  }, undefined);
}

function disposeDecodedTexture(texture: Texture | null): void {
  if (!texture) return;
  const image: unknown = texture.source.data;
  if (typeof image === 'object' && image !== null && 'close' in image) {
    (image as { close(): void }).close();
  }
  texture.dispose();
}

interface HeightSource {
  url: string;
  format: Extract<RasterViewLayerManifest['format'], { kind: 'float32Raw' }>;
}

interface HeightGrid {
  values: Float32Array;
  width: number;
  height: number;
}

async function loadTexture(url: string, signal: AbortSignal, srgb: boolean): Promise<Texture> {
  const response = await fetchChecked(url, signal);
  const bitmap = await createImageBitmap(await response.blob(), {
    premultiplyAlpha: 'none',
    colorSpaceConversion: 'default',
  });
  if (signal.aborted) {
    bitmap.close();
    throw new DOMException('Tile load aborted', 'AbortError');
  }
  const texture = new Texture(bitmap);
  texture.needsUpdate = true;
  texture.minFilter = LinearFilter;
  texture.magFilter = LinearFilter;
  texture.wrapS = ClampToEdgeWrapping;
  texture.wrapT = ClampToEdgeWrapping;
  texture.generateMipmaps = false;
  if (srgb) texture.colorSpace = SRGBColorSpace;
  return texture;
}

async function loadHeights(
  url: string,
  format: Extract<RasterViewLayerManifest['format'], { kind: 'float32Raw' }>,
  signal: AbortSignal,
): Promise<HeightGrid> {
  const response = await fetchChecked(url, signal);
  const buffer = await response.arrayBuffer();
  const expectedBytes = format.width * format.height * Float32Array.BYTES_PER_ELEMENT;
  if (buffer.byteLength !== expectedBytes) {
    throw new Error(`Height tile has ${buffer.byteLength} bytes; expected ${expectedBytes}`);
  }
  if (format.byteOrder === hostByteOrder()) {
    return { values: new Float32Array(buffer), width: format.width, height: format.height };
  }
  const values = new Float32Array(format.width * format.height);
  const view = new DataView(buffer);
  const littleEndian = format.byteOrder === 'littleEndian';
  for (let index = 0; index < values.length; index += 1) {
    values[index] = view.getFloat32(index * 4, littleEndian);
  }
  return { values, width: format.width, height: format.height };
}

function buildRasterGeometry(
  bounds: Bounds3,
  heights: HeightGrid | null,
  noData: RasterNoData,
  mode: 'orbit3d' | 'lockedTopDown2d',
  flatZ: number,
  worldZOffset: number,
): BufferGeometry {
  const terrain = mode === 'orbit3d' && heights !== null;
  const columns = terrain ? Math.min(129, heights.width) : 2;
  const rows = terrain ? Math.min(129, heights.height) : 2;
  const positions = new Float32Array(columns * rows * 3);
  const uvs = new Float32Array(columns * rows * 2);
  const valid = new Uint8Array(columns * rows);
  for (let row = 0; row < rows; row += 1) {
    const v = row / (rows - 1);
    const sourceRow = heights
      ? Math.min(heights.height - 1, Math.round(v * (heights.height - 1)))
      : 0;
    for (let column = 0; column < columns; column += 1) {
      const u = column / (columns - 1);
      const sourceColumn = heights
        ? Math.min(heights.width - 1, Math.round(u * (heights.width - 1)))
        : 0;
      const vertex = row * columns + column;
      const height = heights?.values[sourceRow * heights.width + sourceColumn] ?? flatZ;
      const isValid = !terrain || validHeight(height, noData);
      valid[vertex] = isValid ? 1 : 0;
      positions[vertex * 3] = bounds.min.x + (bounds.max.x - bounds.min.x) * u;
      positions[vertex * 3 + 1] = bounds.max.y - (bounds.max.y - bounds.min.y) * v;
      positions[vertex * 3 + 2] = isValid ? (terrain ? height - worldZOffset : flatZ) : 0;
      uvs[vertex * 2] = u;
      uvs[vertex * 2 + 1] = 1 - v;
    }
  }
  const maximumIndices = (columns - 1) * (rows - 1) * 6;
  const indices = new Uint32Array(maximumIndices);
  let cursor = 0;
  for (let row = 0; row < rows - 1; row += 1) {
    for (let column = 0; column < columns - 1; column += 1) {
      const a = row * columns + column;
      const b = a + 1;
      const c = a + columns;
      const d = c + 1;
      if (valid[a] && valid[b] && valid[c]) {
        indices[cursor++] = a;
        indices[cursor++] = c;
        indices[cursor++] = b;
      }
      if (valid[b] && valid[c] && valid[d]) {
        indices[cursor++] = b;
        indices[cursor++] = c;
        indices[cursor++] = d;
      }
    }
  }
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(positions, 3));
  geometry.setAttribute('uv', new BufferAttribute(uvs, 2));
  geometry.setIndex(new BufferAttribute(indices.subarray(0, cursor), 1));
  geometry.computeBoundingSphere();
  return geometry;
}

function validHeight(value: number, noData: RasterNoData): boolean {
  if (!Number.isFinite(value)) return false;
  return noData.kind !== 'numeric' || value !== noData.value;
}

function rasterTileId(level: number, column: number, row: number): TileId {
  return asTileId(`L${level}/${column}/${row}`);
}

function parseRasterTileId(id: TileId): RasterTileAddress | null {
  const match = /^L(\d+)\/(\d+)\/(\d+)$/.exec(String(id));
  if (!match) return null;
  const level = Number(match[1]);
  const column = Number(match[2]);
  const row = Number(match[3]);
  return Number.isSafeInteger(level) && Number.isSafeInteger(column) && Number.isSafeInteger(row)
    ? { level, column, row }
    : null;
}

function childTileIds(manifest: RasterPyramidManifest, address: RasterTileAddress): TileId[] {
  if (address.level === 0) return [];
  const childLevel = manifest.levels[address.level - 1];
  if (!childLevel) return [];
  const children: TileId[] = [];
  const firstColumn = address.column * 2;
  const firstRow = address.row * 2;
  for (let rowOffset = 0; rowOffset < 2; rowOffset += 1) {
    for (let columnOffset = 0; columnOffset < 2; columnOffset += 1) {
      const column = firstColumn + columnOffset;
      const row = firstRow + rowOffset;
      if (column < childLevel.columns && row < childLevel.rows) {
        children.push(rasterTileId(address.level - 1, column, row));
      }
    }
  }
  return children;
}

function rasterTileBounds(
  manifest: RasterPyramidManifest,
  level: RasterLevelManifest,
  column: number,
  row: number,
): Bounds3 {
  const span = manifest.tileSizePixels * level.gsd;
  const minimumEast = level.bounds.minimumEast + column * span;
  const maximumNorth = level.bounds.maximumNorth - row * span;
  const viewRange = elevationRange(level);
  return {
    min: { x: minimumEast, y: maximumNorth - span, z: viewRange[0] },
    max: { x: minimumEast + span, y: maximumNorth, z: viewRange[1] },
  };
}

function elevationRange(level: RasterLevelManifest): readonly [number, number] {
  for (const layer of level.viewLayers) {
    if (layer.format.kind === 'grayscalePng') {
      return [layer.format.minimumElevation, layer.format.maximumElevation];
    }
  }
  return [0, 0];
}

function selectColorLayer(
  level: RasterLevelManifest,
  kind: RasterProductKind,
): RasterViewLayerManifest | null {
  return (
    level.viewLayers.find((layer) =>
      kind === 'orthomosaic'
        ? layer.format.kind === 'rgbaPng'
        : layer.format.kind === 'grayscalePng',
    ) ?? null
  );
}

let cachedHostByteOrder: 'littleEndian' | 'bigEndian' | null = null;
function hostByteOrder(): 'littleEndian' | 'bigEndian' {
  if (cachedHostByteOrder) return cachedHostByteOrder;
  const bytes = new Uint8Array(new Uint16Array([1]).buffer);
  cachedHostByteOrder = bytes[0] === 1 ? 'littleEndian' : 'bigEndian';
  return cachedHostByteOrder;
}

export function parseRasterPyramidManifest(value: unknown): RasterPyramidManifest {
  const root = record(value, 'manifest');
  if (positiveInteger(root['schemaVersion'], 'schemaVersion') !== 1) {
    throw new Error('Unsupported raster pyramid schema version');
  }
  const tileSizePixels = positiveInteger(root['tileSizePixels'], 'tileSizePixels');
  const gridRecord = record(root['grid'], 'grid');
  const bounds = parseBounds(gridRecord['bounds'], 'grid.bounds');
  const noData = parseNoData(gridRecord['noData']);
  if (!Array.isArray(root['levels']) || root['levels'].length === 0) {
    throw new Error('Raster pyramid has no levels');
  }
  const levels = root['levels'].map((entry, index) => parseLevel(entry, index));
  levels.sort((left, right) => left.level - right.level);
  for (let index = 0; index < levels.length; index += 1) {
    if (levels[index]?.level !== index)
      throw new Error('Raster levels must be contiguous from zero');
  }
  const coarsest = levels[levels.length - 1];
  if (!coarsest || coarsest.columns !== 1 || coarsest.rows !== 1) {
    throw new Error('Raster pyramid must end in one root tile');
  }
  return {
    schemaVersion: 1,
    tileSizePixels,
    grid: {
      bounds,
      widthPixels: positiveInteger(gridRecord['widthPixels'], 'grid.widthPixels'),
      heightPixels: positiveInteger(gridRecord['heightPixels'], 'grid.heightPixels'),
      gsd: finiteNumber(gridRecord['gsd'], 'grid.gsd'),
      noData,
    },
    levels,
  };
}

function parseLevel(value: unknown, index: number): RasterLevelManifest {
  const level = record(value, `levels[${index}]`);
  if (!Array.isArray(level['viewLayers'])) throw new Error(`Level ${index} has no view layers`);
  return {
    level: finiteNumber(level['level'], `levels[${index}].level`),
    columns: positiveInteger(level['columns'], `levels[${index}].columns`),
    rows: positiveInteger(level['rows'], `levels[${index}].rows`),
    bounds: parseBounds(level['bounds'], `levels[${index}].bounds`),
    gsd: finiteNumber(level['gsd'], `levels[${index}].gsd`),
    viewLayers: level['viewLayers'].map((entry, layerIndex) =>
      parseViewLayer(entry, `levels[${index}].viewLayers[${layerIndex}]`),
    ),
  };
}

function parseBounds(value: unknown, field: string): RasterBoundsManifest {
  const bounds = record(value, field);
  const parsed = {
    minimumEast: finiteNumber(bounds['minimumEast'], `${field}.minimumEast`),
    minimumNorth: finiteNumber(bounds['minimumNorth'], `${field}.minimumNorth`),
    maximumEast: finiteNumber(bounds['maximumEast'], `${field}.maximumEast`),
    maximumNorth: finiteNumber(bounds['maximumNorth'], `${field}.maximumNorth`),
  };
  if (parsed.maximumEast <= parsed.minimumEast || parsed.maximumNorth <= parsed.minimumNorth) {
    throw new Error(`Invalid raster bounds: ${field}`);
  }
  return parsed;
}

function parseNoData(value: unknown): RasterNoData {
  const noData = record(value, 'grid.noData');
  const kind = stringValue(noData['kind'], 'grid.noData.kind');
  if (kind === 'numeric') {
    return { kind, value: finiteNumber(noData['value'], 'grid.noData.value') };
  }
  if (kind === 'nan' || kind === 'alphaMask') return { kind };
  throw new Error(`Unsupported no-data kind: ${kind}`);
}

function parseViewLayer(value: unknown, field: string): RasterViewLayerManifest {
  const layer = record(value, field);
  const format = record(layer['format'], `${field}.format`);
  const kind = stringValue(format['kind'], `${field}.format.kind`);
  let parsedFormat: RasterViewLayerManifest['format'];
  if (kind === 'rgbaPng') {
    parsedFormat = { kind };
  } else if (kind === 'grayscalePng') {
    parsedFormat = {
      kind,
      minimumElevation: finiteNumber(
        format['minimumElevation'] ?? format['minimum_elevation'],
        `${field}.minimumElevation`,
      ),
      maximumElevation: finiteNumber(
        format['maximumElevation'] ?? format['maximum_elevation'],
        `${field}.maximumElevation`,
      ),
    };
  } else if (kind === 'float32Raw') {
    // Schema-v1 development builds serialized enum fields in snake_case. Keep those projects
    // readable while all newly published manifests use the canonical camelCase contract.
    const byteOrder = stringValue(
      format['byteOrder'] ?? format['byte_order'],
      `${field}.byteOrder`,
    );
    if (byteOrder !== 'littleEndian' && byteOrder !== 'bigEndian') {
      throw new Error(`Unsupported raster byte order: ${byteOrder}`);
    }
    parsedFormat = {
      kind,
      byteOrder,
      width: positiveInteger(format['width'], `${field}.width`),
      height: positiveInteger(format['height'], `${field}.height`),
    };
  } else {
    throw new Error(`Unsupported raster view format: ${kind}`);
  }
  return {
    name: stringValue(layer['name'], `${field}.name`),
    format: parsedFormat,
    urlTemplate: stringValue(layer['urlTemplate'], `${field}.urlTemplate`),
  };
}
