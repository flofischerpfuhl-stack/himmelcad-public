import assert from 'node:assert/strict';
import test from 'node:test';

import {
  KernelClipCapCoordinator,
  type KernelClipCapSource,
} from '../src/kernel/KernelClipCapCoordinator.js';
import type { SectionTopologyPartitionManifest } from '../src/kernel/generated/index.js';
import type {
  KernelAuthoritativeSectionProduct,
  KernelClipVolume,
  KernelSectionRequest,
} from '../src/kernel/WgpuKernelViewer.js';

const encoder = new TextEncoder();
const manifest = encoder.encode('{"schemaVersion":1}');

void test('streamed clip caps cancel stale work and atomically replace one stable section', async () => {
  const events: string[] = [];
  const operations = new Map<
    string,
    {
      readonly versionHash: string;
      readonly plane: KernelAuthoritativeSectionProduct['plane'];
      readonly tolerance: number;
    }
  >();
  const registered: string[] = [];
  const upserts: KernelSectionRequest[] = [];
  const removed: string[] = [];
  let begins = 0;
  const viewer = {
    setClipVolumes: (volumes: readonly KernelClipVolume[]) => {
      events.push(`clips:${volumes.length}`);
    },
    sectionTopologyPartitionContentHash: (_value: SectionTopologyPartitionManifest) => 'topology',
    beginAuthoritativeSectionEvaluation: (
      operationId: string,
      binding: KernelClipCapSource['binding'],
      plane: KernelAuthoritativeSectionProduct['plane'],
      tolerance: number,
    ) => {
      begins += 1;
      events.push(`begin:${binding.key.entityRevision}`);
      operations.set(operationId, {
        versionHash: binding.key.entityVersionHash,
        plane,
        tolerance,
      });
      return {
        topologyHash: 'topology',
        closedManifold: true,
        parts: [{ partId: 'only', topologyHash: 'topology' }],
      };
    },
    skipAuthoritativeSectionPartition: () => false,
    pushAuthoritativeSectionPartition: () => undefined,
    finishAuthoritativeSectionEvaluation: (operationId: string) => {
      const operation = operations.get(operationId);
      if (!operation) throw new Error('missing operation fixture');
      return product(operation.versionHash, operation.plane, operation.tolerance);
    },
    cancelAuthoritativeSectionEvaluation: (operationId: string) => operations.delete(operationId),
    sectionProductContentHash: (value: KernelAuthoritativeSectionProduct) =>
      value.source.versionHash,
    registerSectionProduct: (objectHash: string) => {
      registered.push(objectHash);
      events.push(`register:${objectHash.slice(0, 2)}`);
    },
    upsertSection: (request: KernelSectionRequest) => {
      upserts.push(request);
      events.push(`upsert:${request.productHash?.slice(0, 2) ?? 'local'}`);
      return { proxies: 1, generation: upserts.length };
    },
    removeSection: (sectionId: string) => {
      removed.push(sectionId);
      return true;
    },
  };
  const fetched: string[] = [];
  let slowWasAborted = false;
  const streaming = {
    fetchImmutableResource: async (
      { uri }: { readonly uri: string },
      signal?: AbortSignal,
    ): Promise<Uint8Array> => {
      fetched.push(uri);
      if (uri.includes('/slow/') && uri.endsWith('manifest.json')) {
        signal?.addEventListener('abort', () => {
          slowWasAborted = true;
        });
        await abortableDelay(5_000, signal);
      }
      signal?.throwIfAborted();
      return uri.endsWith('.json') ? manifest : new Uint8Array([1, 2, 3]);
    },
  };
  const coordinator = new KernelClipCapCoordinator(viewer, streaming);
  const volume = clipVolume();

  await coordinator.synchronize({ volumes: [volume], sources: [source(1, 'fast')] });
  const stableSectionId = upserts[0]?.sectionId;
  assert.ok(stableSectionId);
  assert.equal(events[0], 'clips:1');
  assert.deepEqual(registered, ['11'.repeat(32)]);
  assert.deepEqual(upserts[0]?.clipCap, { volumeId: 'road-box', planeIndex: 0 });
  assert.deepEqual(upserts[0]?.plane.origin, { x: 5, y: 0, z: 0 });

  // Identical state neither reloads topology nor rebuilds the already committed cap.
  await coordinator.synchronize({ volumes: [volume], sources: [source(1, 'fast')] });
  assert.equal(begins, 1);

  // View-local styling reuses the immutable geometry product and only swaps
  // the cap presentation under the same stable section identity.
  const restyled = source(1, 'fast');
  await coordinator.synchronize({
    volumes: [volume],
    sources: [{ ...restyled, style: { ...restyled.style!, opacity: 0.5 } }],
  });
  assert.equal(begins, 1);
  assert.equal(registered.length, 1);
  assert.equal(upserts.length, 2);
  assert.equal(upserts[1]?.sectionId, stableSectionId);

  const stale = coordinator.synchronize({ volumes: [volume], sources: [source(2, 'slow')] });
  await waitUntil(() => fetched.some((uri) => uri.includes('/slow/manifest.json')));
  assert.deepEqual(removed, []);
  const current = coordinator.synchronize({ volumes: [volume], sources: [source(3, 'fast')] });
  await Promise.all([stale, current]);

  assert.deepEqual(registered, ['11'.repeat(32), '33'.repeat(32)]);
  assert.equal(slowWasAborted, true);
  assert.equal(upserts.length, 3);
  assert.equal(upserts[2]?.sectionId, stableSectionId);
  assert.deepEqual(removed, []);

  await coordinator.synchronize({ volumes: [], sources: [source(3, 'fast')] });
  assert.deepEqual(removed, [stableSectionId]);
  assert.equal(events.at(-1), 'clips:0');
  coordinator.dispose();
});

void test('open streamed surfaces are clipped immediately but never scheduled for cap topology', async () => {
  let begins = 0;
  let clipPublications = 0;
  const base = source(1, 'fast');
  const coordinator = new KernelClipCapCoordinator(
    {
      setClipVolumes: () => {
        clipPublications += 1;
      },
      sectionTopologyPartitionContentHash: () => 'topology',
      beginAuthoritativeSectionEvaluation: () => {
        begins += 1;
        throw new Error('open source must not start a cap evaluation');
      },
      skipAuthoritativeSectionPartition: () => false,
      pushAuthoritativeSectionPartition: () => undefined,
      finishAuthoritativeSectionEvaluation: () => {
        throw new Error('unreachable');
      },
      cancelAuthoritativeSectionEvaluation: () => false,
      sectionProductContentHash: () => 'hash',
      registerSectionProduct: () => undefined,
      upsertSection: () => ({ proxies: 0, generation: 0 }),
      removeSection: () => false,
    },
    {
      fetchImmutableResource: () => Promise.reject(new Error('unreachable')),
    },
  );
  await coordinator.synchronize({
    volumes: [clipVolume()],
    sources: [{ ...base, closedManifold: false }],
  });
  assert.equal(clipPublications, 1);
  assert.equal(begins, 0);
});

function source(revision: number, speed: 'fast' | 'slow'): KernelClipCapSource {
  const versionHash = `${revision}${revision}`.repeat(32);
  return {
    entityId: 'road-mesh',
    binding: {
      key: {
        slot: { entityId: 'road-mesh', representationSlot: 'source' },
        entityRevision: revision,
        entityVersionHash: versionHash,
        geometryRef: '44'.repeat(32),
      },
      generation: revision,
    },
    sectionTopologyParts: [
      {
        partId: 'only',
        manifestUri: `https://example.test/${speed}/manifest.json`,
        positionUri: `https://example.test/${speed}/positions.bin`,
        indexUri: `https://example.test/${speed}/indices.bin`,
      },
    ],
    closedManifold: true,
    tolerance: 1e-6,
    style: {
      baseColor: [0.2, 0.3, 0.4, 1],
      opacity: 0.75,
      verticalExaggeration: 1,
      colorMode: { kind: 'uniform' },
      fill: { kind: 'color' },
      stroke: {
        mode: { kind: 'color' },
        color: { kind: 'inherit' },
        width: { kind: 'source' },
        cap: 'butt',
        join: 'miter',
        miterLimit: 4,
      },
    },
  };
}

function clipVolume(): KernelClipVolume {
  return {
    id: 'road-box',
    planes: [{ normal: { x: 2, y: 0, z: 0 }, distance: -10 }],
    operation: 'keepInside',
    previewCap: true,
    enabled: true,
  };
}

function product(
  versionHash: string,
  plane: KernelAuthoritativeSectionProduct['plane'],
  tolerance: number,
): KernelAuthoritativeSectionProduct {
  return {
    schemaVersion: 2,
    source: {
      entityId: 'road-mesh',
      datasetId: 'road-dataset',
      versionHash,
      topologyHash: 'topology',
      closedManifold: true,
      parts: [{ partId: 'only', topologyHash: 'topology' }],
    },
    plane,
    tolerance,
    materialRegions: [],
    product: { segments: [], regions: [] },
  };
}

function abortableDelay(milliseconds: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(resolve, milliseconds);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timeout);
        reject(new DOMException('aborted', 'AbortError'));
      },
      { once: true },
    );
  });
}

async function waitUntil(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
  throw new Error('timed out waiting for delayed topology fetch');
}
