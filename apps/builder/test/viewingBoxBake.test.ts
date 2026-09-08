import assert from 'node:assert/strict';
import test from 'node:test';

import { bakePotreeViewingBox, viewingBoxBakeCacheKey } from '../renderer/src/viewingBoxBake.js';

void test('prepared Potree bake keeps or removes points against all six box planes', async () => {
  const fixture = potreeFixture([-8, 0, 8]);
  const previousFetch = globalThis.fetch;
  globalThis.fetch = fixture.fetch;
  try {
    const box = viewingBox('box-a', 6);
    const inside = await bakePotreeViewingBox({ metadataUrl: fixture.metadataUrl, box });
    assert.equal(inside.sourcePointCount, 3);
    assert.equal(inside.pointCount, 1);
    assert.deepEqual([...new Int32Array(inside.octree.buffer)], [0, 0, 0]);

    const outside = await bakePotreeViewingBox({
      metadataUrl: fixture.metadataUrl,
      box: { ...box, operation: 'removeInside' },
    });
    assert.equal(outside.pointCount, 2);
    assert.deepEqual([...new Int32Array(outside.octree.buffer)], [-8, 0, 0, 8, 0, 0]);
  } finally {
    globalThis.fetch = previousFetch;
  }
});

void test('bake cache identity invalidates on placement and entity revision', () => {
  const box = viewingBox('box-a', 3);
  const source = { entityId: 'cloud-a', entityRevision: 4, placement: null, datasetId: 'd1' };
  const initial = viewingBoxBakeCacheKey(box, [source]);
  assert.notEqual(initial, viewingBoxBakeCacheKey(box, [{ ...source, entityRevision: 5 }]));
  assert.notEqual(initial, viewingBoxBakeCacheKey(box, [{ ...source, placement: [1, 0, 0, 0] }]));
});

void test('bake evaluates source points at the exact canonical placement', async () => {
  const fixture = potreeFixture([-8, 0, 8]);
  const previousFetch = globalThis.fetch;
  globalThis.fetch = fixture.fetch;
  try {
    const result = await bakePotreeViewingBox({
      metadataUrl: fixture.metadataUrl,
      box: { ...viewingBox('box-a', 2), center: { x: 18, y: 0, z: 0 } },
      placement: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 10, 0, 0, 1],
    });
    assert.equal(result.pointCount, 1);
    assert.deepEqual([...new Int32Array(result.octree.buffer)], [8, 0, 0]);
  } finally {
    globalThis.fetch = previousFetch;
  }
});

void test('bake observes cancellation before publishing any output', async () => {
  const controller = new AbortController();
  controller.abort();
  const box = viewingBox('box-a', 3);
  await assert.rejects(
    bakePotreeViewingBox({
      metadataUrl: 'https://fixture.invalid/metadata.json',
      box,
      signal: controller.signal,
    }),
    (error: unknown) => error instanceof DOMException && error.name === 'AbortError',
  );
});

void test('bake cancelled after filtering still returns no publishable result', async () => {
  const fixture = potreeFixture([-8, 0, 8]);
  const previousFetch = globalThis.fetch;
  const controller = new AbortController();
  globalThis.fetch = fixture.fetch;
  try {
    let result: unknown;
    await assert.rejects(
      bakePotreeViewingBox({
        metadataUrl: fixture.metadataUrl,
        box: viewingBox('box-a', 6),
        signal: controller.signal,
        onProgress: () => controller.abort(),
      }).then((value) => {
        result = value;
      }),
      (error: unknown) => error instanceof DOMException && error.name === 'AbortError',
    );
    assert.equal(result, undefined);
  } finally {
    globalThis.fetch = previousFetch;
  }
});

function potreeFixture(xCoordinates: readonly number[]): {
  readonly metadataUrl: string;
  readonly fetch: typeof fetch;
} {
  const metadataUrl = 'https://fixture.invalid/cloud/metadata.json';
  const octree = new Uint8Array(xCoordinates.length * 12);
  const octreeView = new DataView(octree.buffer);
  xCoordinates.forEach((x, index) => {
    octreeView.setInt32(index * 12, x, true);
    octreeView.setInt32(index * 12 + 4, 0, true);
    octreeView.setInt32(index * 12 + 8, 0, true);
  });
  const hierarchy = new Uint8Array(22);
  const hierarchyView = new DataView(hierarchy.buffer);
  hierarchyView.setUint8(0, 0);
  hierarchyView.setUint8(1, 0);
  hierarchyView.setUint32(2, xCoordinates.length, true);
  hierarchyView.setBigUint64(6, 0n, true);
  hierarchyView.setBigUint64(14, BigInt(octree.byteLength), true);
  const metadata = new TextEncoder().encode(
    JSON.stringify({
      version: '2.0',
      name: 'fixture',
      points: xCoordinates.length,
      projection: '',
      hierarchy: { firstChunkSize: hierarchy.byteLength, stepSize: 5, depth: 0 },
      offset: [0, 0, 0],
      scale: [1, 1, 1],
      spacing: 1,
      boundingBox: { min: [-10, -10, -10], max: [10, 10, 10] },
      encoding: 'DEFAULT',
      attributes: [{ name: 'position', size: 12, numElements: 3, elementSize: 4, type: 'int32' }],
    }),
  );
  const fixtureFetch: typeof fetch = async (input) => {
    const url = String(input);
    const bytes = url.endsWith('metadata.json')
      ? metadata
      : url.endsWith('hierarchy.bin')
        ? hierarchy
        : octree;
    return new Response(bytes.slice().buffer, {
      status: url.endsWith('metadata.json') ? 200 : 206,
    });
  };
  return { metadataUrl, fetch: fixtureFetch };
}

function viewingBox(id: string, halfExtent: number) {
  return {
    id,
    center: { x: 0, y: 0, z: 0 },
    halfExtents: { x: halfExtent, y: halfExtent, z: halfExtent },
    rotation: [0, 0, 0, 1] as const,
    mode: 'resize' as const,
    enabled: true,
    operation: 'keepInside' as const,
    lockMode: 'unlocked' as const,
    bakeKey: null,
  };
}
