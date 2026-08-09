import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';

import { admitCanonicalPreparedTinDatasetWith } from '../src/kernel/KernelPreparedTinDatasetAdmission.js';
import type { CanonicalRepresentationAdmission } from '../src/kernel/generated/index.js';

const encoder = new TextEncoder();

void test('prepared Civil TIN verifies both manifests and publishes streamed exact topology', async () => {
  const renderBytes = encoder.encode('{"schemaVersion":1,"roots":["root"],"tiles":[]}');
  const preparationBytes = encoder.encode('{"schemaVersion":1,"kind":"dgm-grid"}');
  const topologyBytes = encoder.encode(
    JSON.stringify({
      schemaVersion: 2,
      closedManifold: false,
      parts: [
        {
          partId: 'L0-0-0',
          topologyHash: 'ab'.repeat(32),
          bounds: { minimum: [0.5, 0.5, 100], maximum: [511.5, 511.5, 120] },
          manifestUrl: 'tiles/L0-0-0.section.json',
          positionUrl: 'tiles/L0-0-0.positions.f32',
          indexUrl: 'tiles/L0-0-0.indices.u32',
          materialSlotUrl: null,
        },
      ],
    }),
  );
  const admission = canonicalAdmission(renderBytes);
  const calls: unknown[][] = [];
  const mutation = {
    entities: 1,
    slots: 1,
    proxies: 0,
    generation: 1,
    bindings: [],
  };
  const result = await admitCanonicalPreparedTinDatasetWith(
    {
      geometryObjectContentHash: () => admission.selected.geometryRef,
      canonicalEntityVersionHash: () => admission.entity.versionHash,
      registerPreparedDatasetAndPublishCanonicalRepresentations: (...args) => {
        calls.push(['atomic', ...args]);
        return mutation;
      },
    },
    {
      fetchImmutableResource: async ({ uri }) => {
        if (uri.endsWith('section-topology.json')) return topologyBytes;
        return uri.endsWith('preparation.json') ? preparationBytes : renderBytes;
      },
    },
    {
      datasetId: 'dgm-road-v1',
      manifestUri: 'https://example.test/dgm/kernel-manifest.json',
      preparationUri: 'https://example.test/dgm/preparation.json',
      preparationResource: resource(preparationBytes, 'hcad.prepared-triangle-mesh-recipe@1'),
      sectionTopologyUri: 'https://example.test/dgm/section-topology.json',
      sectionTopologyResource: resource(topologyBytes, 'hcad.section-topology-index@2'),
      admission,
    },
  );

  assert.equal(result.mutation, mutation);
  assert.deepEqual(result.sectionTopologyParts, [
    {
      partId: 'L0-0-0',
      manifestUri: 'https://example.test/dgm/tiles/L0-0-0.section.json',
      positionUri: 'https://example.test/dgm/tiles/L0-0-0.positions.f32',
      indexUri: 'https://example.test/dgm/tiles/L0-0-0.indices.u32',
    },
  ]);
  const published = calls[0]?.[5] as Array<{
    evaluatedMesh: {
      parametersRef: string;
      parts: Array<{
        partId: string;
        topologyHash: string;
        bounds: { minimum: number[]; maximum: number[] };
      }>;
      closedManifold: boolean;
    };
  }>;
  assert.equal(published[0]?.evaluatedMesh.parametersRef, sha256(preparationBytes));
  assert.equal(published[0]?.evaluatedMesh.parts[0]?.topologyHash, 'ab'.repeat(32));
  assert.deepEqual(published[0]?.evaluatedMesh.parts[0]?.bounds, {
    minimum: [0.5, 0.5, 100],
    maximum: [511.5, 511.5, 120],
  });
  assert.equal(published[0]?.evaluatedMesh.closedManifold, false);
});

void test('tampered prepared TIN topology never registers a dataset', async () => {
  const renderBytes = encoder.encode('{}');
  const preparationBytes = encoder.encode('{}');
  const topologyBytes = encoder.encode('{"schemaVersion":1,"closedManifold":false,"parts":[]}');
  const admission = canonicalAdmission(renderBytes);
  let registered = false;
  await assert.rejects(
    admitCanonicalPreparedTinDatasetWith(
      {
        geometryObjectContentHash: () => admission.selected.geometryRef,
        canonicalEntityVersionHash: () => admission.entity.versionHash,
        registerPreparedDatasetAndPublishCanonicalRepresentations: () => {
          registered = true;
          throw new Error('must not mutate');
        },
      },
      {
        fetchImmutableResource: async ({ uri }) => {
          if (uri.endsWith('section-topology.json')) return topologyBytes;
          return uri.endsWith('preparation.json') ? preparationBytes : renderBytes;
        },
      },
      {
        datasetId: 'dgm-road-v1',
        manifestUri: 'https://example.test/dgm/kernel-manifest.json',
        preparationUri: 'https://example.test/dgm/preparation.json',
        preparationResource: resource(preparationBytes, 'hcad.prepared-triangle-mesh-recipe@1'),
        sectionTopologyUri: 'https://example.test/dgm/section-topology.json',
        sectionTopologyResource: {
          objectHash: '00'.repeat(32),
          mediaType: 'hcad.section-topology-index@2',
          byteLength: topologyBytes.byteLength,
        },
        admission,
      },
    ),
    /topology hash/,
  );
  assert.equal(registered, false);
});

void test('prepared TIN rejects missing, reversed and non-finite canonical bounds', async () => {
  const renderBytes = encoder.encode('{}');
  const preparationBytes = encoder.encode('{}');
  const admission = canonicalAdmission(renderBytes);
  const invalidBounds: unknown[] = [
    undefined,
    { minimum: [2, 0, 0], maximum: [1, 1, 1] },
    { minimum: [0, 0, 0], maximum: [1, Number.POSITIVE_INFINITY, 1] },
  ];
  for (const bounds of invalidBounds) {
    const part: Record<string, unknown> = {
      partId: 'L0-0-0',
      topologyHash: 'ab'.repeat(32),
      manifestUrl: 'tiles/L0-0-0.section.json',
      positionUrl: 'tiles/L0-0-0.positions.f32',
      indexUrl: 'tiles/L0-0-0.indices.u32',
      materialSlotUrl: null,
    };
    if (bounds !== undefined) part.bounds = bounds;
    const topologyBytes = encoder.encode(
      JSON.stringify({ schemaVersion: 2, closedManifold: false, parts: [part] }),
    );
    let registered = false;
    await assert.rejects(
      admitCanonicalPreparedTinDatasetWith(
        {
          geometryObjectContentHash: () => admission.selected.geometryRef,
          canonicalEntityVersionHash: () => admission.entity.versionHash,
          registerPreparedDatasetAndPublishCanonicalRepresentations: () => {
            registered = true;
            throw new Error('must not mutate');
          },
        },
        {
          fetchImmutableResource: async ({ uri }) => {
            if (uri.endsWith('section-topology.json')) return topologyBytes;
            return uri.endsWith('preparation.json') ? preparationBytes : renderBytes;
          },
        },
        {
          datasetId: 'dgm-invalid-bounds',
          manifestUri: 'https://example.test/dgm/kernel-manifest.json',
          preparationUri: 'https://example.test/dgm/preparation.json',
          preparationResource: resource(preparationBytes, 'hcad.prepared-triangle-mesh-recipe@1'),
          sectionTopologyUri: 'https://example.test/dgm/section-topology.json',
          sectionTopologyResource: resource(topologyBytes, 'hcad.section-topology-index@2'),
          admission,
        },
      ),
      /partition is invalid/,
    );
    assert.equal(registered, false);
  }
});

function canonicalAdmission(renderBytes: Uint8Array): CanonicalRepresentationAdmission {
  const renderResource = resource(renderBytes, 'himmelcad-prepared-hierarchy@1');
  return {
    entity: {
      id: 'road-dgm',
      revision: 1,
      typeId: 'hcad.elevation-surface@1',
      name: 'Road DGM',
      owner: null,
      layerIds: [],
      placement: null,
      representations: [
        {
          role: 'canonical',
          geometryRef: '11'.repeat(32),
          authority: 'authoritative',
          dependencyHash: null,
        },
      ],
      componentsRef: '22'.repeat(32),
      attributesRef: '33'.repeat(32),
      relationsRef: '44'.repeat(32),
      styleRef: null,
      versionHash: '55'.repeat(32),
      schemaVersion: 1,
    },
    selected: {
      role: 'canonical',
      geometryRef: '11'.repeat(32),
      authority: 'authoritative',
      dependencyHash: null,
    },
    representationSlot: 'source',
    expectedGeneration: null,
    resolvedGeometry: {
      kind: 'elevationSurface',
      surface: {
        kind: 'tin',
        mesh: {
          storage: { kind: 'resource', resource: renderResource },
          closedManifold: false,
          triangleMaterialSlots: null,
          materials: null,
        },
        breaklines: [],
      },
    },
  };
}

function resource(bytes: Uint8Array, mediaType: string) {
  return { objectHash: sha256(bytes), mediaType, byteLength: bytes.byteLength };
}

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}
