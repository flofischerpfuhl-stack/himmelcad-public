import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';

import { admitCanonicalPreparedMeshDatasetWith } from '../src/kernel/KernelPreparedMeshDatasetAdmission.js';
import type { CanonicalRepresentationAdmission } from '../src/kernel/generated/index.js';

const encoder = new TextEncoder();

void test('prepared closed mesh publishes material-bound topology through the shared admission', async () => {
  const renderBytes = encoder.encode('{"schemaVersion":1,"roots":["root"],"tiles":[]}');
  const preparationBytes = encoder.encode(
    '{"schemaVersion":1,"producer":"hcad.prepared-triangle-mesh","version":"1.0.0"}',
  );
  const topologyBytes = encoder.encode(
    JSON.stringify({
      schemaVersion: 2,
      closedManifold: true,
      materialKeys: { 0: 'material:concrete' },
      parts: [
        {
          partId: 'body-0',
          topologyHash: 'ab'.repeat(32),
          bounds: { minimum: [-1, -1, -1], maximum: [1, 1, 1] },
          manifestUrl: 'parts/body-0.json',
          positionUrl: 'parts/body-0.positions.f64',
          indexUrl: 'parts/body-0.indices.u32',
          materialSlotUrl: 'parts/body-0.materials.u32',
        },
      ],
    }),
  );
  const admission = closedMeshAdmission(renderBytes);
  const calls: unknown[][] = [];
  const mutation = { entities: 1, slots: 1, proxies: 0, generation: 1, bindings: [] };
  const result = await admitCanonicalPreparedMeshDatasetWith(
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
      datasetId: 'prepared-building-shell',
      manifestUri: 'https://example.test/building/kernel-manifest.json',
      preparationUri: 'https://example.test/building/preparation.json',
      preparationResource: resource(preparationBytes, 'hcad.prepared-triangle-mesh-recipe@1'),
      sectionTopologyUri: 'https://example.test/building/section-topology.json',
      sectionTopologyResource: resource(topologyBytes, 'hcad.section-topology-index@2'),
      admission,
      providerId: 'hcad.prepared-triangle-mesh',
      providerVersion: '1.0.0',
    },
  );

  assert.equal(result.mutation, mutation);
  assert.deepEqual(result.sectionTopologyParts, [
    {
      partId: 'body-0',
      manifestUri: 'https://example.test/building/parts/body-0.json',
      positionUri: 'https://example.test/building/parts/body-0.positions.f64',
      indexUri: 'https://example.test/building/parts/body-0.indices.u32',
      materialSlotUri: 'https://example.test/building/parts/body-0.materials.u32',
    },
  ]);
  const published = calls[0]?.[5] as Array<{
    evaluatedMesh: {
      providerId: string;
      parametersRef: string;
      closedManifold: boolean;
      materialKeys: Record<number, string>;
      parts: Array<{ bounds: { minimum: number[]; maximum: number[] } }>;
    };
  }>;
  assert.equal(published[0]?.evaluatedMesh.providerId, 'hcad.prepared-triangle-mesh');
  assert.equal(published[0]?.evaluatedMesh.parametersRef, sha256(preparationBytes));
  assert.equal(published[0]?.evaluatedMesh.closedManifold, true);
  assert.deepEqual(published[0]?.evaluatedMesh.materialKeys, { 0: 'material:concrete' });
  assert.deepEqual(published[0]?.evaluatedMesh.parts[0]?.bounds, {
    minimum: [-1, -1, -1],
    maximum: [1, 1, 1],
  });
  assert.deepEqual(calls[0]?.[6], [
    {
      entityId: admission.entity.id,
      representationSlot: admission.representationSlot,
      sectionTopologyParts: result.sectionTopologyParts,
      closedManifold: true,
    },
  ]);
});

void test('prepared mesh rejects topology that contradicts canonical manifold semantics', async () => {
  const renderBytes = encoder.encode('{}');
  const preparationBytes = encoder.encode('{}');
  const topologyBytes = encoder.encode(
    JSON.stringify({
      schemaVersion: 2,
      closedManifold: false,
      parts: [
        {
          partId: 'body-0',
          topologyHash: 'ab'.repeat(32),
          bounds: { minimum: [-1, -1, -1], maximum: [1, 1, 1] },
          manifestUrl: 'body.json',
          positionUrl: 'body.positions',
          indexUrl: 'body.indices',
          materialSlotUrl: null,
        },
      ],
    }),
  );
  const admission = closedMeshAdmission(renderBytes);
  let registered = false;
  await assert.rejects(
    admitCanonicalPreparedMeshDatasetWith(
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
        datasetId: 'invalid-building-shell',
        manifestUri: 'https://example.test/building/kernel-manifest.json',
        preparationUri: 'https://example.test/building/preparation.json',
        preparationResource: resource(preparationBytes, 'hcad.prepared-triangle-mesh-recipe@1'),
        sectionTopologyUri: 'https://example.test/building/section-topology.json',
        sectionTopologyResource: resource(topologyBytes, 'hcad.section-topology-index@2'),
        admission,
        providerId: 'hcad.prepared-triangle-mesh',
        providerVersion: '1.0.0',
      },
    ),
    /contradicts canonical open\/closed semantics/,
  );
  assert.equal(registered, false);
});

void test('generation conflict is delegated to the single atomic kernel mutation', async () => {
  const renderBytes = encoder.encode('{}');
  const preparationBytes = encoder.encode('{}');
  const topologyBytes = closedTopologyBytes({ 0: 'material:steel' });
  const admission = closedMeshAdmission(renderBytes);
  let atomicCalls = 0;
  await assert.rejects(
    admitCanonicalPreparedMeshDatasetWith(
      {
        geometryObjectContentHash: () => admission.selected.geometryRef,
        canonicalEntityVersionHash: () => admission.entity.versionHash,
        registerPreparedDatasetAndPublishCanonicalRepresentations: () => {
          atomicCalls += 1;
          throw new Error('representation generation conflict');
        },
      },
      {
        fetchImmutableResource: async ({ uri }) => {
          if (uri.endsWith('section-topology.json')) return topologyBytes;
          return uri.endsWith('preparation.json') ? preparationBytes : renderBytes;
        },
      },
      preparedInput(admission, preparationBytes, topologyBytes),
    ),
    /generation conflict/,
  );
  assert.equal(atomicCalls, 1);
});

void test('closed mesh material keys are validated before the atomic kernel mutation', async () => {
  const renderBytes = encoder.encode('{}');
  const preparationBytes = encoder.encode('{}');
  const topologyBytes = closedTopologyBytes({});
  const admission = closedMeshAdmission(renderBytes);
  let mutated = false;
  await assert.rejects(
    admitCanonicalPreparedMeshDatasetWith(
      {
        geometryObjectContentHash: () => admission.selected.geometryRef,
        canonicalEntityVersionHash: () => admission.entity.versionHash,
        registerPreparedDatasetAndPublishCanonicalRepresentations: () => {
          mutated = true;
          throw new Error('must not mutate');
        },
      },
      {
        fetchImmutableResource: async ({ uri }) => {
          if (uri.endsWith('section-topology.json')) return topologyBytes;
          return uri.endsWith('preparation.json') ? preparationBytes : renderBytes;
        },
      },
      preparedInput(admission, preparationBytes, topologyBytes),
    ),
    /requires canonical material keys/,
  );
  assert.equal(mutated, false);
});

void test('tampered preparation recipe is rejected before the atomic kernel mutation', async () => {
  const renderBytes = encoder.encode('{}');
  const preparationBytes = encoder.encode('{"recipe":"authoritative"}');
  const tamperedPreparationBytes = encoder.encode('{"recipe":"tampered"}');
  const topologyBytes = closedTopologyBytes({ 0: 'material:steel' });
  const admission = closedMeshAdmission(renderBytes);
  let mutated = false;
  await assert.rejects(
    admitCanonicalPreparedMeshDatasetWith(
      {
        geometryObjectContentHash: () => admission.selected.geometryRef,
        canonicalEntityVersionHash: () => admission.entity.versionHash,
        registerPreparedDatasetAndPublishCanonicalRepresentations: () => {
          mutated = true;
          throw new Error('must not mutate');
        },
      },
      {
        fetchImmutableResource: async ({ uri }) => {
          if (uri.endsWith('section-topology.json')) return topologyBytes;
          return uri.endsWith('preparation.json') ? tamperedPreparationBytes : renderBytes;
        },
      },
      preparedInput(admission, preparationBytes, topologyBytes),
    ),
    /preparation recipe byte length|preparation recipe hash/,
  );
  assert.equal(mutated, false);
});

function closedTopologyBytes(materialKeys: Record<number, string>): Uint8Array {
  return encoder.encode(
    JSON.stringify({
      schemaVersion: 2,
      closedManifold: true,
      materialKeys,
      parts: [
        {
          partId: 'body-0',
          topologyHash: 'ab'.repeat(32),
          bounds: { minimum: [-1, -1, -1], maximum: [1, 1, 1] },
          manifestUrl: 'body.json',
          positionUrl: 'body.positions',
          indexUrl: 'body.indices',
          materialSlotUrl: 'body.materials',
        },
      ],
    }),
  );
}

function preparedInput(
  admission: CanonicalRepresentationAdmission,
  preparationBytes: Uint8Array,
  topologyBytes: Uint8Array,
) {
  return {
    datasetId: 'prepared-building-shell',
    manifestUri: 'https://example.test/building/kernel-manifest.json',
    preparationUri: 'https://example.test/building/preparation.json',
    preparationResource: resource(preparationBytes, 'hcad.prepared-triangle-mesh-recipe@1'),
    sectionTopologyUri: 'https://example.test/building/section-topology.json',
    sectionTopologyResource: resource(topologyBytes, 'hcad.section-topology-index@2'),
    admission,
    providerId: 'hcad.prepared-triangle-mesh',
    providerVersion: '1.0.0',
  };
}

function closedMeshAdmission(renderBytes: Uint8Array): CanonicalRepresentationAdmission {
  const renderResource = resource(renderBytes, 'himmelcad-prepared-hierarchy@1');
  const selected = {
    role: 'canonical' as const,
    geometryRef: '11'.repeat(32),
    authority: 'authoritative' as const,
    dependencyHash: null,
  };
  return {
    entity: {
      id: 'building-shell',
      revision: 1,
      typeId: 'hcad.object-3d@1',
      name: 'Building shell',
      owner: null,
      layerIds: [],
      placement: null,
      representations: [selected],
      componentsRef: '22'.repeat(32),
      attributesRef: '33'.repeat(32),
      relationsRef: '44'.repeat(32),
      styleRef: null,
      versionHash: '55'.repeat(32),
      schemaVersion: 1,
    },
    selected,
    representationSlot: 'source',
    expectedGeneration: null,
    resolvedGeometry: {
      kind: 'solid',
      solid: {
        kind: 'closedMesh',
        mesh: {
          storage: { kind: 'resource', resource: renderResource },
          closedManifold: true,
          triangleMaterialSlots: null,
          materials: null,
        },
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
