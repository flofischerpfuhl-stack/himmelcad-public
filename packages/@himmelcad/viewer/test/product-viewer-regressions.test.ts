import assert from 'node:assert/strict';
import test from 'node:test';

import { Mesh, PerspectiveCamera } from 'three';
import type { BufferGeometry } from 'three';

import { resolvePotreeAssetUrl } from '../src/products/PotreeAssetUrl.js';
import { asTileId, resolveAssetUrl } from '../src/products/ProductTileDataset.js';
import { RasterPyramidDataset } from '../src/products/RasterPyramidDataset.js';
import type {
  RasterLevelManifest,
  RasterPyramidManifest,
} from '../src/products/RasterPyramidDataset.js';
import { RenderBudget } from '../src/streaming/RenderBudget.js';
import { TileStreamingService } from '../src/streaming/TileStreamingService.js';
import type {
  ScreenSpaceErrorContext,
  Tile,
  TiledDataset,
  TileLoadState,
} from '../src/streaming/TiledDataset.js';

void test('custom-protocol product and Potree URLs remain absolute', () => {
  const metadataUrl = 'hcad-product://alignment/sparse/metadata.json';

  assert.equal(resolvePotreeAssetUrl(metadataUrl, metadataUrl), metadataUrl);
  assert.equal(
    resolvePotreeAssetUrl(metadataUrl, 'hierarchy.bin'),
    'hcad-product://alignment/sparse/hierarchy.bin',
  );
  assert.equal(
    resolvePotreeAssetUrl(metadataUrl, 'hcad-product://alignment/sparse/octree.bin'),
    'hcad-product://alignment/sparse/octree.bin',
  );
  assert.equal(
    resolveAssetUrl(
      'hcad-product://orthomosaic/',
      'hcad-product://orthomosaic/view/rgba/L0/0/0.png',
    ),
    'hcad-product://orthomosaic/view/rgba/L0/0/0.png',
  );
});

void test('raster assets resolve from dataset roots and ortho uses the closest DEM level', async () => {
  const orthoManifestUrl = 'hcad-product://orthomosaic/pyramid/manifest.json';
  const terrainManifestUrl = 'hcad-product://dem/pyramid/manifest.json';
  const ortho = rasterManifest([
    rasterLevel(0, 4, 4, 1, rgbaLayer()),
    rasterLevel(1, 2, 2, 2, rgbaLayer()),
    rasterLevel(2, 1, 1, 4, rgbaLayer()),
  ]);
  const terrain = rasterManifest([
    rasterLevel(0, 4, 4, 1, heightLayers(701, 704)),
    rasterLevel(1, 2, 2, 2, heightLayers(710, 713)),
    rasterLevel(2, 1, 1, 16, heightLayers(720, 723)),
  ]);
  const requestedUrls: string[] = [];
  const originalFetch = globalThis.fetch;
  const originalCreateImageBitmap = globalThis.createImageBitmap;
  globalThis.fetch = (input) => {
    const url =
      typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    requestedUrls.push(url);
    if (url === orthoManifestUrl) return Promise.resolve(jsonResponse(ortho));
    if (url === terrainManifestUrl) return Promise.resolve(jsonResponse(terrain));
    if (url === 'hcad-product://orthomosaic/view/rgba/L2/0/0.png') {
      return Promise.resolve(new Response(new Blob([new Uint8Array([137, 80, 78, 71])])));
    }
    if (url === 'hcad-product://dem/view/height/L1/1/1.bin') {
      return Promise.resolve(new Response(new Float32Array([710, 711, 712, 713]).buffer));
    }
    return Promise.resolve(new Response('unexpected URL', { status: 404 }));
  };
  let bitmapClosed = false;
  globalThis.createImageBitmap = () =>
    Promise.resolve({
      close(): void {
        bitmapClosed = true;
      },
    } as unknown as ImageBitmap);

  try {
    const dataset = await RasterPyramidDataset.load(orthoManifestUrl, {
      id: 'ortho',
      kind: 'orthomosaic',
      renderOffset: [0, 0, 700],
      terrainManifestUrl,
    });
    await dataset.loadTile(dataset.rootTile);

    assert.equal(dataset.getTileLoadState(dataset.rootTile), 'loaded');
    assert.ok(requestedUrls.includes('hcad-product://orthomosaic/view/rgba/L2/0/0.png'));
    assert.ok(requestedUrls.includes('hcad-product://dem/view/height/L1/1/1.bin'));
    assert.equal(
      requestedUrls.some((url) => url.includes('/pyramid/view/')),
      false,
    );

    const mesh = dataset.root.children[0];
    assert.ok(mesh instanceof Mesh);
    const terrainMesh = mesh as Mesh<BufferGeometry>;
    const position = terrainMesh.geometry.getAttribute('position');
    assert.deepEqual(
      Array.from({ length: position.count }, (_, index) => position.getZ(index)),
      [10, 11, 12, 13],
    );
    dataset.dispose();
    assert.equal(bitmapClosed, true);
  } finally {
    globalThis.fetch = originalFetch;
    globalThis.createImageBitmap = originalCreateImageBitmap;
  }
});

void test('tile streaming does not retry failed tiles every frame', async () => {
  const rootTile = asTileId('root');
  const tile: Tile = {
    id: rootTile,
    bounds: { min: { x: -1, y: -1, z: -1 }, max: { x: 1, y: 1, z: 1 } },
    geometricError: 1,
    content: { triangles: 2, gpuBytes: 64, drawCalls: 1 },
    pickIndex: { kind: 'none', status: 'missing' },
    children: [],
    parent: null,
  };
  let state: TileLoadState = 'unloaded';
  let attempts = 0;
  const dataset: TiledDataset = {
    id: 'failed-raster',
    kind: 'surface',
    rootTile,
    getTile: (id) => (id === rootTile ? tile : null),
    getLoadedTileIds: () => [],
    getTileLoadState: () => state,
    computeScreenSpaceError: () => 1,
    loadTile: () => {
      attempts += 1;
      state = 'failed';
      return Promise.reject(new Error('offline tile is corrupt'));
    },
    unloadTile: () => {
      state = 'unloaded';
    },
    isLoaded: () => false,
  };
  const service = new TileStreamingService(new RenderBudget(), {
    updateIntervalMs: 0,
    maxNewLoadsPerUpdate: 1,
  });
  const context: ScreenSpaceErrorContext = {
    camera: new PerspectiveCamera(50, 1, 0.1, 1_000),
    viewportHeight: 1_000,
    fovY: Math.PI / 4,
  };
  service.register(dataset);

  service.update(context, 0);
  await new Promise<void>((resolve) => setImmediate(resolve));
  for (let frame = 1; frame <= 100; frame += 1) service.update(context, frame);
  await new Promise<void>((resolve) => setImmediate(resolve));

  assert.equal(state, 'failed');
  assert.equal(attempts, 1);
  assert.equal(service.getPendingLoadCount(), 0);
  service.dispose();
});

function rasterManifest(levels: readonly RasterLevelManifest[]): RasterPyramidManifest {
  return {
    schemaVersion: 1,
    tileSizePixels: 2,
    grid: {
      bounds: rasterBounds(),
      widthPixels: 8,
      heightPixels: 8,
      gsd: 1,
      noData: { kind: 'nan' },
    },
    levels,
  };
}

function rasterLevel(
  level: number,
  columns: number,
  rows: number,
  gsd: number,
  viewLayers: RasterLevelManifest['viewLayers'],
): RasterLevelManifest {
  return { level, columns, rows, bounds: rasterBounds(), gsd, viewLayers };
}

function rasterBounds(): RasterLevelManifest['bounds'] {
  return { minimumEast: 0, minimumNorth: 0, maximumEast: 8, maximumNorth: 8 };
}

function rgbaLayer(): RasterLevelManifest['viewLayers'] {
  return [
    {
      name: 'color',
      format: { kind: 'rgbaPng' },
      urlTemplate: 'view/rgba/L{level}/{x}/{y}.png',
    },
  ];
}

function heightLayers(
  minimumElevation: number,
  maximumElevation: number,
): RasterLevelManifest['viewLayers'] {
  return [
    {
      name: 'height-preview',
      format: { kind: 'grayscalePng', minimumElevation, maximumElevation },
      urlTemplate: 'view/height-preview/L{level}/{x}/{y}.png',
    },
    {
      name: 'height',
      format: { kind: 'float32Raw', byteOrder: hostByteOrder(), width: 2, height: 2 },
      urlTemplate: 'view/height/L{level}/{x}/{y}.bin',
    },
  ];
}

function hostByteOrder(): 'littleEndian' | 'bigEndian' {
  return new Uint8Array(new Uint16Array([1]).buffer)[0] === 1 ? 'littleEndian' : 'bigEndian';
}

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    headers: { 'content-type': 'application/json' },
  });
}
