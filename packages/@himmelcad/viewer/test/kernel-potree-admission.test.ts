import assert from 'node:assert/strict';
import test from 'node:test';

import type {
  CanonicalEntity,
  CanonicalRepresentationAdmission,
  GeometryObject,
  Representation,
} from '../src/kernel/generated/index.js';
import {
  admitCanonicalPotreeDatasetWith,
  type KernelPotreeDatasetAdmission,
} from '../src/kernel/KernelPotreeDatasetAdmission.js';
import type {
  KernelCanonicalEntityMutation,
  KernelCanonicalRenderAdmission,
} from '../src/kernel/WgpuKernelViewer.js';

void test('canonical Potree bootstrap verifies metadata before registry publication', async () => {
  const metadata = new TextEncoder().encode(
    JSON.stringify({ hierarchy: { firstChunkSize: 22 }, version: '2.0' }),
  );
  const input = await admission(metadata);
  const calls: Array<readonly unknown[]> = [];
  const mutation: KernelCanonicalEntityMutation = {
    entities: 1,
    slots: 1,
    proxies: 0,
    generation: 1,
    bindings: [],
  };
  const viewer = {
    geometryObjectContentHash(): string {
      return input.admission.selected.geometryRef;
    },
    canonicalEntityVersionHash(): string {
      return input.admission.entity.versionHash;
    },
    registerPotreeDataset(
      datasetId: string,
      formatId: string,
      metadataUri: string,
      metadataJson: Uint8Array,
      hierarchy: Uint8Array,
      preparedMetadata: Uint8Array,
    ): void {
      calls.push([
        'register',
        datasetId,
        formatId,
        metadataUri,
        metadataJson,
        hierarchy,
        preparedMetadata,
      ]);
    },
    publishCanonicalRepresentations(
      admissions: readonly KernelCanonicalRenderAdmission[],
    ): KernelCanonicalEntityMutation {
      calls.push(['publish', admissions]);
      return mutation;
    },
  };
  const requests: Array<readonly unknown[]> = [];
  const progress: Array<readonly [string, number, number]> = [];
  const streaming = {
    fetchImmutableResource(reference: {
      readonly uri: string;
      readonly byteOffset: number | null;
      readonly byteLength: number | null;
    }): Promise<Uint8Array> {
      requests.push([reference.uri, reference.byteOffset, reference.byteLength]);
      return Promise.resolve(reference.byteOffset === null ? metadata : new Uint8Array(22));
    },
  };

  assert.equal(
    await admitCanonicalPotreeDatasetWith(viewer, streaming, input, undefined, (item) =>
      progress.push([item.phase, item.completed, item.total]),
    ),
    mutation,
  );
  assert.deepEqual(requests, [
    ['hcad-cache://local/dataset/metadata.json', null, null],
    ['hcad-cache://local/dataset/hierarchy.bin', 0, 22],
  ]);
  assert.equal(calls[0]?.[0], 'register');
  assert.equal((calls[0]?.[6] as Uint8Array).byteLength, 0);
  assert.equal(calls[1]?.[0], 'publish');
  const published = calls[1]?.[1] as readonly KernelCanonicalRenderAdmission[];
  assert.equal(published[0]?.datasetId, 'dataset');
  assert.equal(published[0]?.admission, input.admission);
  assert.deepEqual(progress, [
    ['validating', 0, 4],
    ['fetching', 0, 4],
    ['verifying', 1, 4],
    ['publishing', 3, 4],
    ['complete', 4, 4],
  ]);
});

void test('prepared Potree admission preserves explicit station ids without rewriting metadata', async () => {
  const metadata = new TextEncoder().encode(
    JSON.stringify({ hierarchy: { firstChunkSize: 22 }, version: '2.0' }),
  );
  const input = await admission(metadata);
  const prepared = {
    schemaVersion: 1 as const,
    rawSourceContentHash: '11'.repeat(32),
    nodes: {
      r: {
        screenSpaceError: { geometricError: 2, pointSpacing: 1 },
        sampleStatistics: { sampledPoints: 3, sourcePoints: 5, method: 'poisson-disk' },
        stationIds: ['station-17'],
        contentHash: null,
        origin: 'baked' as const,
      },
    },
  };
  let preparedBytes: Uint8Array<ArrayBufferLike> = new Uint8Array(0);
  const viewer = {
    geometryObjectContentHash: () => input.admission.selected.geometryRef,
    canonicalEntityVersionHash: () => input.admission.entity.versionHash,
    registerPotreeDataset(
      _datasetId: string,
      _formatId: string,
      _metadataUri: string,
      registeredMetadata: Uint8Array,
      _hierarchy: Uint8Array,
      registeredPrepared: Uint8Array,
    ): void {
      assert.deepEqual(registeredMetadata, metadata);
      preparedBytes = registeredPrepared;
    },
    publishCanonicalRepresentations: () => ({
      entities: 1,
      slots: 1,
      proxies: 0,
      generation: 1,
      bindings: [],
    }),
  };
  const streaming = {
    fetchImmutableResource: (reference: { readonly byteOffset: number | null }) =>
      Promise.resolve(reference.byteOffset === null ? metadata : new Uint8Array(22)),
  };

  await admitCanonicalPotreeDatasetWith(viewer, streaming, { ...input, preparedMetadata: prepared });
  assert.deepEqual(JSON.parse(new TextDecoder().decode(preparedBytes)), prepared);
});

void test('Potree abort after immutable fetch cannot publish a half-loaded dataset', async () => {
  const metadata = new TextEncoder().encode(
    JSON.stringify({ hierarchy: { firstChunkSize: 22 }, version: '2.0' }),
  );
  const input = await admission(metadata);
  const abort = new AbortController();
  let registrations = 0;
  let publications = 0;
  let fetches = 0;
  const viewer = {
    geometryObjectContentHash: () => input.admission.selected.geometryRef,
    canonicalEntityVersionHash: () => input.admission.entity.versionHash,
    registerPotreeDataset: () => {
      registrations += 1;
    },
    publishCanonicalRepresentations: () => {
      publications += 1;
      return { entities: 0, slots: 0, proxies: 0, generation: 0, bindings: [] };
    },
  };
  const streaming = {
    fetchImmutableResource: () => {
      fetches += 1;
      if (fetches === 2) abort.abort();
      return Promise.resolve(fetches === 1 ? metadata : new Uint8Array(22));
    },
  };

  await assert.rejects(
    admitCanonicalPotreeDatasetWith(viewer, streaming, input, abort.signal),
    /abort/i,
  );
  assert.equal(fetches, 2);
  assert.equal(registrations, 0);
  assert.equal(publications, 0);
});

void test('tampered Potree metadata never reaches dataset registration', async () => {
  const expected = new TextEncoder().encode(
    JSON.stringify({ hierarchy: { firstChunkSize: 22 }, version: '2.0' }),
  );
  const input = await admission(expected);
  let registrations = 0;
  let publications = 0;
  const viewer = {
    geometryObjectContentHash: () => input.admission.selected.geometryRef,
    canonicalEntityVersionHash: () => input.admission.entity.versionHash,
    registerPotreeDataset: () => {
      registrations += 1;
    },
    publishCanonicalRepresentations: () => {
      publications += 1;
      return { entities: 0, slots: 0, proxies: 0, generation: 0, bindings: [] };
    },
  };
  const streaming = {
    fetchImmutableResource: () => Promise.resolve(new TextEncoder().encode('{"tampered":true}')),
  };

  await assert.rejects(
    admitCanonicalPotreeDatasetWith(viewer, streaming, input),
    /byte length|content does not match/,
  );
  assert.equal(registrations, 0);
  assert.equal(publications, 0);
});

void test('unbounded Potree bootstrap hierarchy is rejected before its range request', async () => {
  const metadata = new TextEncoder().encode(
    JSON.stringify({ hierarchy: { firstChunkSize: 64 * 1024 * 1024 + 1 }, version: '2.0' }),
  );
  const input = await admission(metadata);
  let fetches = 0;
  const viewer = {
    geometryObjectContentHash: () => input.admission.selected.geometryRef,
    canonicalEntityVersionHash: () => input.admission.entity.versionHash,
    registerPotreeDataset: () => undefined,
    publishCanonicalRepresentations: () => ({
      entities: 0,
      slots: 0,
      proxies: 0,
      generation: 0,
      bindings: [],
    }),
  };
  const streaming = {
    fetchImmutableResource: () => {
      fetches += 1;
      return Promise.resolve(metadata);
    },
  };

  await assert.rejects(
    admitCanonicalPotreeDatasetWith(viewer, streaming, input),
    /bounded bootstrap range/,
  );
  assert.equal(fetches, 1);
});

async function admission(metadata: Uint8Array): Promise<KernelPotreeDatasetAdmission> {
  const geometry: GeometryObject = {
    kind: 'pointCloud',
    dataset: {
      formatId: 'potree@2',
      metadata: {
        objectHash: await sha256(metadata),
        mediaType: 'application/json',
        byteLength: metadata.byteLength,
      },
      elementCount: 3,
    },
  };
  const selected: Representation = {
    role: 'canonical',
    geometryRef: '11'.repeat(32),
    authority: 'authoritative',
    dependencyHash: null,
  };
  const entity: CanonicalEntity = {
    id: 'entity-survey',
    revision: 0,
    typeId: 'hcad.point-cloud@1',
    name: 'survey.laz',
    owner: null,
    layerIds: [],
    placement: null,
    representations: [selected],
    componentsRef: '22'.repeat(32),
    attributesRef: '33'.repeat(32),
    relationsRef: '44'.repeat(32),
    styleRef: null,
    schemaVersion: 1,
    versionHash: '55'.repeat(32),
  };
  const canonical: CanonicalRepresentationAdmission = {
    entity,
    selected,
    representationSlot: 'source',
    expectedGeneration: null,
    resolvedGeometry: geometry,
  };
  return {
    datasetId: 'dataset',
    metadataUri: 'hcad-cache://local/dataset/metadata.json',
    admission: canonical,
  };
}

async function sha256(bytes: Uint8Array): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes.slice().buffer));
  return [...digest].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}
