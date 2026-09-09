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

void test('large node filtering yields so cancellation remains bounded', async () => {
  const fixture = potreeFixture(Array.from({ length: 70_000 }, () => 0));
  const previousFetch = globalThis.fetch;
  const controller = new AbortController();
  globalThis.fetch = fixture.fetch;
  try {
    const started = Date.now();
    await assert.rejects(
      bakePotreeViewingBox({
        metadataUrl: fixture.metadataUrl,
        box: viewingBox('box-a', 6),
        signal: controller.signal,
        onProgress: (_fraction, phase) => {
          if (phase === 'Filtering prepared points') {
            globalThis.setTimeout(() => controller.abort(), 0);
          }
        },
      }),
      (error: unknown) => error instanceof DOMException && error.name === 'AbortError',
    );
    assert.ok(Date.now() - started < 2_000);
  } finally {
    globalThis.fetch = previousFetch;
  }
});

void test('small keep-inside bake skips non-intersecting hierarchy pages and reports phases', async () => {
  const fixture = pagedPotreeFixture();
  const previousFetch = globalThis.fetch;
  globalThis.fetch = fixture.fetch;
  const phases: string[] = [];
  try {
    const result = await bakePotreeViewingBox({
      metadataUrl: fixture.metadataUrl,
      box: {
        ...viewingBox('small-box', 2),
        center: { x: -12, y: -12, z: -12 },
      },
      onProgress: (_fraction, phase) => {
        phases.push(phase);
      },
    });
    assert.equal(result.pointCount, 1);
    assert.deepEqual(fixture.hierarchyRanges, ['bytes=0-1048575']);
    assert.deepEqual(fixture.octreeRanges, ['bytes=0-11', 'bytes=12-23']);
    assert.equal(phases[0], 'Reading point-cloud metadata');
    assert.ok(phases.includes('Reading intersecting hierarchy'));
    assert.ok(phases.includes('Filtering prepared points'));
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

function pagedPotreeFixture(): {
  readonly metadataUrl: string;
  readonly hierarchyRanges: string[];
  readonly octreeRanges: string[];
  readonly fetch: typeof fetch;
} {
  const metadataUrl = 'https://fixture.invalid/paged/metadata.json';
  const hierarchy = new Uint8Array(110);
  const hierarchyView = new DataView(hierarchy.buffer);
  const writeNode = (
    at: number,
    type: number,
    childMask: number,
    points: number,
    offset: bigint,
    length: bigint,
  ): void => {
    hierarchyView.setUint8(at, type);
    hierarchyView.setUint8(at + 1, childMask);
    hierarchyView.setUint32(at + 2, points, true);
    hierarchyView.setBigUint64(at + 6, offset, true);
    hierarchyView.setBigUint64(at + 14, length, true);
  };
  writeNode(0, 0, (1 << 0) | (1 << 7), 1, 0n, 12n);
  writeNode(22, 2, 0, 0, 66n, 22n);
  writeNode(44, 2, 0, 0, 88n, 22n);
  writeNode(66, 0, 0, 1, 12n, 12n);
  writeNode(88, 0, 0, 1, 24n, 12n);
  const octree = new Uint8Array(36);
  const octreeView = new DataView(octree.buffer);
  for (const [index, coordinate] of [0, -12, 12].entries()) {
    octreeView.setInt32(index * 12, coordinate, true);
    octreeView.setInt32(index * 12 + 4, coordinate, true);
    octreeView.setInt32(index * 12 + 8, coordinate, true);
  }
  const metadata = new TextEncoder().encode(
    JSON.stringify({
      version: '2.0',
      name: 'paged fixture',
      points: 3,
      hierarchy: { firstChunkSize: 66, stepSize: 1, depth: 1 },
      offset: [0, 0, 0],
      scale: [1, 1, 1],
      spacing: 1,
      boundingBox: { min: [-16, -16, -16], max: [16, 16, 16] },
      encoding: 'DEFAULT',
      attributes: [{ name: 'position', size: 12, numElements: 3, elementSize: 4, type: 'int32' }],
    }),
  );
  const hierarchyRanges: string[] = [];
  const octreeRanges: string[] = [];
  const fixtureFetch: typeof fetch = async (input, init) => {
    const url = String(input);
    if (url.endsWith('metadata.json'))
      return new Response(metadata.slice().buffer, { status: 200 });
    const range = new Headers(init?.headers).get('range')!;
    const match = /^bytes=(\d+)-(\d+)$/.exec(range)!;
    const start = Number(match[1]);
    const end = Number(match[2]);
    const bytes = url.endsWith('hierarchy.bin') ? hierarchy : octree;
    (url.endsWith('hierarchy.bin') ? hierarchyRanges : octreeRanges).push(range);
    return new Response(bytes.slice(start, end + 1).buffer, { status: 206 });
  };
  return { metadataUrl, hierarchyRanges, octreeRanges, fetch: fixtureFetch };
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
