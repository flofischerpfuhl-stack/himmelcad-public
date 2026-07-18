import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';

import { evaluateCanonicalSectionTopologyWith } from '../src/kernel/KernelSectionTopologyEvaluation.js';
import type { SectionTopologyPartitionManifest } from '../src/kernel/generated/index.js';
import type { KernelAuthoritativeSectionProduct } from '../src/kernel/WgpuKernelViewer.js';

const encoder = new TextEncoder();

void test('streamed exact section loads canonical partitions sequentially in manifest order', async () => {
  const left = partition('left');
  const right = partition('right');
  const resources = new Map<string, Uint8Array>([
    ['https://example.test/right/part.json', right.manifestBytes],
    ['https://example.test/right/positions.bin', new Uint8Array([4])],
    ['https://example.test/right/indices.bin', new Uint8Array([5])],
    ['https://example.test/left/part.json', left.manifestBytes],
    ['https://example.test/left/positions.bin', new Uint8Array([1])],
    ['https://example.test/left/indices.bin', new Uint8Array([2])],
  ]);
  const events: string[] = [];
  let finished = false;
  const product = { schemaVersion: 2 } as KernelAuthoritativeSectionProduct;
  const viewer = {
    sectionTopologyPartitionContentHash: mockManifestHash,
    beginAuthoritativeSectionEvaluation: () => ({
      topologyHash: 'complete',
      closedManifold: false,
      parts: [
        { partId: 'left', topologyHash: left.hash },
        { partId: 'right', topologyHash: right.hash },
      ],
    }),
    skipAuthoritativeSectionPartition: () => false,
    pushAuthoritativeSectionPartition: (
      _operationId: string,
      partId: string,
      manifest: SectionTopologyPartitionManifest,
    ) => {
      events.push(`push:${partId}`);
      assert.equal(manifest.schemaVersion, 1);
    },
    finishAuthoritativeSectionEvaluation: () => {
      finished = true;
      return product;
    },
    cancelAuthoritativeSectionEvaluation: () => false,
  };
  const streaming = {
    fetchImmutableResource: async ({ uri }: { readonly uri: string }) => {
      events.push(`fetch:${uri}`);
      const bytes = resources.get(uri);
      if (!bytes) throw new Error(`missing fixture: ${uri}`);
      return bytes;
    },
  };

  const evaluated = await evaluateCanonicalSectionTopologyWith(viewer, streaming, {
    operationId: 'section-1',
    binding: binding(),
    plane: { origin: { x: 0, y: 0, z: 0 }, normal: { x: 0, y: 0, z: 1 } },
    tolerance: 1e-6,
    parts: [
      location('right'),
      location('left'),
    ],
  });

  assert.equal(evaluated, product);
  assert.equal(finished, true);
  assert.deepEqual(
    events.filter((event) => event.startsWith('push:')),
    ['push:left', 'push:right'],
  );
  assert.ok(events.indexOf('push:left') < events.indexOf('fetch:https://example.test/right/part.json'));
});

void test('tampered topology manifest cancels before source buffers are fetched', async () => {
  const valid = partition('left');
  let cancelled = 0;
  let pushed = 0;
  const fetched: string[] = [];
  await assert.rejects(
    evaluateCanonicalSectionTopologyWith(
      {
        sectionTopologyPartitionContentHash: mockManifestHash,
        beginAuthoritativeSectionEvaluation: () => ({
          topologyHash: 'complete',
          closedManifold: false,
          parts: [{ partId: 'left', topologyHash: valid.hash }],
        }),
        skipAuthoritativeSectionPartition: () => false,
        pushAuthoritativeSectionPartition: () => {
          pushed += 1;
        },
        finishAuthoritativeSectionEvaluation: () => ({}) as KernelAuthoritativeSectionProduct,
        cancelAuthoritativeSectionEvaluation: () => {
          cancelled += 1;
          return true;
        },
      },
      {
        fetchImmutableResource: async ({ uri }) => {
          fetched.push(uri);
          return encoder.encode('{"tampered":true}');
        },
      },
      {
        operationId: 'section-tamper',
        binding: binding(),
        plane: { origin: { x: 0, y: 0, z: 0 }, normal: { x: 0, y: 0, z: 1 } },
        tolerance: 1e-6,
        parts: [location('left')],
      },
    ),
    /manifest hash mismatch/,
  );
  assert.equal(cancelled, 1);
  assert.equal(pushed, 0);
  assert.deepEqual(fetched, ['https://example.test/left/part.json']);
});

void test('kernel-disjoint section partition performs zero immutable resource requests', async () => {
  const intersecting = partition('intersecting');
  const fetched: string[] = [];
  const pushed: string[] = [];
  const skipped: string[] = [];
  const product = { schemaVersion: 2 } as KernelAuthoritativeSectionProduct;
  const evaluated = await evaluateCanonicalSectionTopologyWith(
    {
      sectionTopologyPartitionContentHash: mockManifestHash,
      beginAuthoritativeSectionEvaluation: () => ({
        topologyHash: 'complete',
        closedManifold: false,
        parts: [
          {
            partId: 'distant',
            topologyHash: 'aa'.repeat(32),
            bounds: { minimum: [100, 100, 100], maximum: [200, 200, 200] },
          },
          {
            partId: 'intersecting',
            topologyHash: intersecting.hash,
            bounds: { minimum: [-1, -1, -1], maximum: [1, 1, 1] },
          },
        ],
      }),
      skipAuthoritativeSectionPartition: (_operationId, partId) => {
        skipped.push(partId);
        return partId === 'distant';
      },
      pushAuthoritativeSectionPartition: (_operationId, partId) => pushed.push(partId),
      finishAuthoritativeSectionEvaluation: () => product,
      cancelAuthoritativeSectionEvaluation: () => false,
    },
    {
      fetchImmutableResource: async ({ uri }) => {
        fetched.push(uri);
        if (uri.endsWith('/part.json')) return intersecting.manifestBytes;
        return new Uint8Array([1]);
      },
    },
    {
      operationId: 'section-cull',
      binding: binding(),
      plane: { origin: { x: 0, y: 0, z: 0 }, normal: { x: 0, y: 0, z: 1 } },
      tolerance: 1e-6,
      parts: [location('distant'), location('intersecting')],
    },
  );

  assert.equal(evaluated, product);
  assert.deepEqual(skipped, ['distant', 'intersecting']);
  assert.deepEqual(pushed, ['intersecting']);
  assert.ok(fetched.every((uri) => !uri.includes('/distant/')));
  assert.equal(fetched.length, 3);
});

function partition(id: string): { manifestBytes: Uint8Array; hash: string } {
  const manifest: SectionTopologyPartitionManifest = {
    schemaVersion: 1,
    origin: [0, 0, 0],
    positions: { objectHash: '11'.repeat(32), mediaType: 'f32le-xyz', byteLength: 1 },
    positionComponentType: 'float32',
    vertexCount: 1,
    indices: { objectHash: '22'.repeat(32), mediaType: 'u16le', byteLength: 1 },
    indexComponentType: 'uint16',
    indexCount: 3,
    materialSlots: null,
  };
  const manifestBytes = encoder.encode(JSON.stringify({ ...manifest, origin: [id.length, 0, 0] }));
  return { manifestBytes, hash: sha256(manifestBytes) };
}

function location(partId: string) {
  return {
    partId,
    manifestUri: `https://example.test/${partId}/part.json`,
    positionUri: `https://example.test/${partId}/positions.bin`,
    indexUri: `https://example.test/${partId}/indices.bin`,
  };
}

function binding() {
  return {
    key: {
      slot: { entityId: 'road-dgm', representationSlot: 'source' },
      entityRevision: 1,
      entityVersionHash: '33'.repeat(32),
      geometryRef: '44'.repeat(32),
    },
    generation: 1,
  };
}

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function mockManifestHash(manifest: SectionTopologyPartitionManifest): string {
  return sha256(encoder.encode(JSON.stringify(manifest)));
}
