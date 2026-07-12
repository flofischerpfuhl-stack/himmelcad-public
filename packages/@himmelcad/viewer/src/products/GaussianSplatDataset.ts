import type { Bounds3 } from '@himmelcad/data';
import {
  BufferAttribute,
  InstancedBufferAttribute,
  InstancedBufferGeometry,
  Mesh,
  ShaderMaterial,
  Vector3,
} from 'three';

import type { ScreenSpaceErrorContext, TileId } from '../streaming/TiledDataset.js';
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

const SPLAT_STRIDE = 44;
const MAX_MONOLITHIC_PLY_SPLATS = 1_000_000;

export interface PreparedSplatTileManifest {
  readonly id: string;
  readonly parent: string | null;
  readonly children: readonly string[];
  readonly bounds: Bounds3;
  readonly origin: readonly [number, number, number];
  readonly geometricError: number;
  readonly splatCount: number;
  /** HCSP v1: local xyz, linear scale xyz, normalized quaternion xyzw, RGBA8. */
  readonly dataUrl: string;
}

export interface GaussianSplatManifest {
  readonly schemaVersion: 1;
  readonly format: 'hcsplatInterleavedV1';
  readonly rootTileId: string;
  readonly tiles: readonly PreparedSplatTileManifest[];
}

export interface GaussianSplatDatasetOptions {
  readonly id: string;
  readonly renderOffset: readonly [number, number, number];
  readonly opacity?: number;
  readonly sizeScale?: number;
}

interface DecodedSplatData {
  centers: Float32Array;
  scales: Float32Array;
  rotations: Float32Array;
  colors: Uint8Array;
}

/**
 * Tiled anisotropic Gaussian renderer. Splats are appearance-only: geometry
 * measurements remain on depth, point, DEM or mesh products.
 */
export class GaussianSplatDataset extends ProductTileDataset {
  readonly snapPolicy = 'appearance-only' as const;
  readonly manifest: GaussianSplatManifest;
  private readonly baseUrl: string;
  private readonly options: GaussianSplatDatasetOptions;
  private readonly manifests = new Map<TileId, PreparedSplatTileManifest>();
  private readonly tiles = new Map<TileId, ProductTile>();
  private readonly cameraPosition = new Vector3();

  static async load(
    manifestUrl: string,
    options: GaussianSplatDatasetOptions,
  ): Promise<GaussianSplatDataset> {
    const response = await fetch(manifestUrl, { cache: 'force-cache' });
    if (!response.ok) throw new Error(`Splat manifest request failed (${response.status})`);
    return new GaussianSplatDataset(
      manifestUrl,
      parseGaussianSplatManifest(await response.json()),
      options,
    );
  }

  /** Compatibility path for ordinary Brush/3DGS PLY; large products must be prepared as tiles. */
  static async loadBrushPly(
    plyUrl: string,
    options: GaussianSplatDatasetOptions,
  ): Promise<GaussianSplatDataset> {
    const response = await fetch(plyUrl, { cache: 'force-cache' });
    if (!response.ok) throw new Error(`Splat PLY request failed (${response.status})`);
    const buffer = await response.arrayBuffer();
    const decoded = await decodePlyInWorker(buffer, MAX_MONOLITHIC_PLY_SPLATS);
    const origin = decoded.origin;
    const tile: PreparedSplatTileManifest = {
      id: 'root',
      parent: null,
      children: [],
      bounds: decoded.bounds,
      origin,
      geometricError: Math.max(0.001, decoded.geometricError),
      splatCount: decoded.splatCount,
      dataUrl: 'memory://brush-ply',
    };
    const dataset = new GaussianSplatDataset(
      plyUrl,
      { schemaVersion: 1, format: 'hcsplatInterleavedV1', rootTileId: 'root', tiles: [tile] },
      options,
    );
    dataset.memoryTiles.set(asTileId('root'), decoded.packed);
    return dataset;
  }

  private readonly memoryTiles = new Map<TileId, ArrayBuffer>();

  constructor(
    manifestUrl: string,
    manifest: GaussianSplatManifest,
    options: GaussianSplatDatasetOptions,
  ) {
    super({
      id: options.id,
      kind: 'splat',
      rootTile: asTileId(manifest.rootTileId),
      renderOffset: options.renderOffset,
    });
    this.manifest = manifest;
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
          splats: item.splatCount,
          gpuBytes: item.splatCount * SPLAT_STRIDE,
          drawCalls: 1,
          hasTransparency: true,
          transparencyMode: 'sorted-alpha',
        },
        pickIndex: { kind: 'splat-tree', status: 'missing' },
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
    try {
      const tile = this.manifests.get(id);
      if (!tile) throw new Error(`Unknown splat tile: ${String(id)}`);
      const memory = this.memoryTiles.get(id);
      const buffer = memory
        ? memory.slice(0)
        : await (
            await fetchChecked(resolveAssetUrl(this.baseUrl, tile.dataUrl), signal)
          ).arrayBuffer();
      if (buffer.byteLength !== tile.splatCount * SPLAT_STRIDE) {
        throw new Error(
          `Splat tile has ${buffer.byteLength} bytes; expected ${tile.splatCount * SPLAT_STRIDE}`,
        );
      }
      const data = unpackPreparedSplats(buffer, tile.splatCount);
      if (signal.aborted) throw new DOMException('Tile load aborted', 'AbortError');
      const mesh = buildSplatMesh(data, this.options);
      mesh.position.set(
        tile.origin[0] - this.renderOffset[0],
        tile.origin[1] - this.renderOffset[1],
        tile.origin[2] - this.renderOffset[2],
      );
      mesh.name = `splat:${this.id}:${String(id)}`;
      // Dataset-level f64-aware bounds already performed the frustum test.
      mesh.frustumCulled = false;
      mesh.userData['hcadSnapPolicy'] = this.snapPolicy;
      this.commitLoad(id, mesh);
    } catch (error) {
      this.failLoad(id, error);
    }
  }

  updateForCamera(ctx: ScreenSpaceErrorContext): void {
    this.cameraPosition.copy(ctx.camera.position);
    for (const [id, object] of this.objects) {
      const tile = this.tiles.get(id);
      if (!tile) continue;
      const centerX = (tile.bounds.min.x + tile.bounds.max.x) * 0.5;
      const centerY = (tile.bounds.min.y + tile.bounds.max.y) * 0.5;
      const centerZ = (tile.bounds.min.z + tile.bounds.max.z) * 0.5;
      const dx = centerX - this.cameraPosition.x;
      const dy = centerY - this.cameraPosition.y;
      const dz = centerZ - this.cameraPosition.z;
      // Three renders lower renderOrder first; distant transparent blocks go first.
      object.renderOrder = -Math.sqrt(dx * dx + dy * dy + dz * dz);
    }
  }
}

function unpackPreparedSplats(buffer: ArrayBuffer, count: number): DecodedSplatData {
  const centers = new Float32Array(count * 3);
  const scales = new Float32Array(count * 3);
  const rotations = new Float32Array(count * 4);
  const colors = new Uint8Array(count * 4);
  const view = new DataView(buffer);
  for (let index = 0; index < count; index += 1) {
    const base = index * SPLAT_STRIDE;
    for (let axis = 0; axis < 3; axis += 1) {
      centers[index * 3 + axis] = view.getFloat32(base + axis * 4, true);
      scales[index * 3 + axis] = view.getFloat32(base + 12 + axis * 4, true);
    }
    for (let component = 0; component < 4; component += 1) {
      rotations[index * 4 + component] = view.getFloat32(base + 24 + component * 4, true);
      colors[index * 4 + component] = view.getUint8(base + 40 + component);
    }
  }
  return { centers, scales, rotations, colors };
}

function buildSplatMesh(
  data: DecodedSplatData,
  options: GaussianSplatDatasetOptions,
): Mesh<InstancedBufferGeometry, ShaderMaterial> {
  const geometry = new InstancedBufferGeometry();
  geometry.setAttribute(
    'position',
    new BufferAttribute(new Float32Array([-1, -1, 1, -1, 1, 1, -1, 1]), 2),
  );
  geometry.setIndex(new BufferAttribute(new Uint16Array([0, 1, 2, 0, 2, 3]), 1));
  geometry.setAttribute('splatCenter', new InstancedBufferAttribute(data.centers, 3));
  geometry.setAttribute('splatScale', new InstancedBufferAttribute(data.scales, 3));
  geometry.setAttribute('splatRotation', new InstancedBufferAttribute(data.rotations, 4));
  geometry.setAttribute('splatColor', new InstancedBufferAttribute(data.colors, 4, true));
  geometry.instanceCount = data.centers.length / 3;
  const material = new ShaderMaterial({
    transparent: true,
    depthWrite: false,
    depthTest: true,
    uniforms: {
      opacity: { value: Math.max(0, Math.min(1, options.opacity ?? 1)) },
      sizeScale: { value: Math.max(0.01, options.sizeScale ?? 1) },
    },
    vertexShader: SPLAT_VERTEX_SHADER,
    fragmentShader: SPLAT_FRAGMENT_SHADER,
  });
  const mesh = new Mesh(geometry, material);
  mesh.frustumCulled = false;
  return mesh;
}

const SPLAT_VERTEX_SHADER = `
attribute vec3 splatCenter;
attribute vec3 splatScale;
attribute vec4 splatRotation;
attribute vec4 splatColor;
uniform float sizeScale;
varying vec2 gaussianPosition;
varying vec4 gaussianColor;

mat3 quaternionMatrix(vec4 q) {
  q = normalize(q);
  float x = q.x, y = q.y, z = q.z, w = q.w;
  return mat3(
    1.0 - 2.0*(y*y + z*z), 2.0*(x*y + z*w), 2.0*(x*z - y*w),
    2.0*(x*y - z*w), 1.0 - 2.0*(x*x + z*z), 2.0*(y*z + x*w),
    2.0*(x*z + y*w), 2.0*(y*z - x*w), 1.0 - 2.0*(x*x + y*y)
  );
}

void main() {
  vec4 centerView4 = modelViewMatrix * vec4(splatCenter, 1.0);
  vec3 centerView = centerView4.xyz;
  mat3 rotationView = mat3(modelViewMatrix) * quaternionMatrix(splatRotation);
  mat3 covariance = rotationView * mat3(
    splatScale.x*splatScale.x, 0.0, 0.0,
    0.0, splatScale.y*splatScale.y, 0.0,
    0.0, 0.0, splatScale.z*splatScale.z
  ) * transpose(rotationView) * sizeScale * sizeScale;
  float inverseZ = 1.0 / max(0.0001, -centerView.z);
  vec3 jacobianX = vec3(
    projectionMatrix[0][0] * inverseZ,
    0.0,
    projectionMatrix[0][0] * centerView.x * inverseZ * inverseZ
  );
  vec3 jacobianY = vec3(
    0.0,
    projectionMatrix[1][1] * inverseZ,
    projectionMatrix[1][1] * centerView.y * inverseZ * inverseZ
  );
  vec3 covarianceX = covariance * jacobianX;
  vec3 covarianceY = covariance * jacobianY;
  mat2 covariance2d = mat2(
    dot(jacobianX, covarianceX), dot(jacobianY, covarianceX),
    dot(jacobianX, covarianceY), dot(jacobianY, covarianceY)
  );
  float trace = covariance2d[0][0] + covariance2d[1][1];
  float determinant = covariance2d[0][0]*covariance2d[1][1] - covariance2d[0][1]*covariance2d[1][0];
  float root = sqrt(max(0.0, trace*trace*0.25 - determinant));
  float lambda1 = max(1e-10, trace*0.5 + root);
  float lambda2 = max(1e-10, trace*0.5 - root);
  vec2 eigen1 = normalize(vec2(covariance2d[0][1], lambda1 - covariance2d[0][0]) + vec2(1e-8, 0.0));
  vec2 eigen2 = vec2(-eigen1.y, eigen1.x);
  vec2 ndcOffset = 3.0 * (eigen1 * sqrt(lambda1) * position.x + eigen2 * sqrt(lambda2) * position.y);
  gl_Position = projectionMatrix * centerView4;
  gl_Position.xy += ndcOffset * gl_Position.w;
  gaussianPosition = position;
  gaussianColor = splatColor;
}
`;

const SPLAT_FRAGMENT_SHADER = `
uniform float opacity;
varying vec2 gaussianPosition;
varying vec4 gaussianColor;
void main() {
  float radius2 = dot(gaussianPosition, gaussianPosition);
  if (radius2 > 1.0) discard;
  float alpha = exp(-4.5 * radius2) * gaussianColor.a * opacity;
  if (alpha < 0.004) discard;
  gl_FragColor = vec4(gaussianColor.rgb, alpha);
}
`;

interface WorkerPlyResult {
  packed: ArrayBuffer;
  splatCount: number;
  origin: [number, number, number];
  bounds: Bounds3;
  geometricError: number;
}

async function decodePlyInWorker(
  source: ArrayBuffer,
  maximumSplats: number,
): Promise<WorkerPlyResult> {
  const worker = new Worker(new URL('./SplatPlyDecodeWorker.ts', import.meta.url), {
    type: 'module',
  });
  return new Promise((resolve, reject) => {
    worker.onmessage = (event: MessageEvent<WorkerPlyResult | { error: string }>) => {
      worker.terminate();
      if ('error' in event.data) reject(new Error(event.data.error));
      else resolve(event.data);
    };
    worker.onerror = (event) => {
      worker.terminate();
      reject(new Error(event.message));
    };
    worker.postMessage({ source, maximumSplats }, [source]);
  });
}

export function parseGaussianSplatManifest(value: unknown): GaussianSplatManifest {
  const root = record(value, 'splat manifest');
  if (positiveInteger(root['schemaVersion'], 'schemaVersion') !== 1) {
    throw new Error('Unsupported splat schema version');
  }
  if (stringValue(root['format'], 'format') !== 'hcsplatInterleavedV1') {
    throw new Error('Unsupported prepared splat format');
  }
  const rootTileId = stringValue(root['rootTileId'], 'rootTileId');
  if (!Array.isArray(root['tiles']) || root['tiles'].length === 0) {
    throw new Error('Splat manifest has no tiles');
  }
  const tiles = root['tiles'].map((entry, index) => parseSplatTile(entry, index));
  const ids = new Set(tiles.map((tile) => tile.id));
  if (!ids.has(rootTileId) || ids.size !== tiles.length) {
    throw new Error('Splat tile ids are duplicated or root is missing');
  }
  for (const tile of tiles) {
    if (tile.parent && !ids.has(tile.parent)) {
      throw new Error(`Missing splat parent: ${tile.parent}`);
    }
    for (const child of tile.children) {
      if (!ids.has(child)) throw new Error(`Missing splat child: ${child}`);
    }
  }
  return { schemaVersion: 1, format: 'hcsplatInterleavedV1', rootTileId, tiles };
}

function parseSplatTile(value: unknown, index: number): PreparedSplatTileManifest {
  const tile = record(value, `tiles[${index}]`);
  const origin = tile['origin'];
  if (!Array.isArray(origin) || origin.length !== 3) throw new Error('Invalid splat tile origin');
  const children = tile['children'];
  if (!Array.isArray(children) || !children.every((child) => typeof child === 'string')) {
    throw new Error('Invalid splat tile children');
  }
  const parent = tile['parent'];
  if (parent !== null && typeof parent !== 'string') throw new Error('Invalid splat tile parent');
  return {
    id: stringValue(tile['id'], `tiles[${index}].id`),
    parent,
    children,
    bounds: parseSplatBounds(tile['bounds'], `tiles[${index}].bounds`),
    origin: [
      finiteNumber(origin[0], `tiles[${index}].origin[0]`),
      finiteNumber(origin[1], `tiles[${index}].origin[1]`),
      finiteNumber(origin[2], `tiles[${index}].origin[2]`),
    ],
    geometricError: finiteNumber(tile['geometricError'], `tiles[${index}].geometricError`),
    splatCount: positiveInteger(tile['splatCount'], `tiles[${index}].splatCount`),
    dataUrl: stringValue(tile['dataUrl'], `tiles[${index}].dataUrl`),
  };
}

function parseSplatBounds(value: unknown, field: string): Bounds3 {
  const bounds = record(value, field);
  const min = record(bounds['min'], `${field}.min`);
  const max = record(bounds['max'], `${field}.max`);
  return {
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
}
