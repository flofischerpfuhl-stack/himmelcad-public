import assert from 'node:assert/strict';
import test from 'node:test';

import type {
  AlignmentMergeCandidateRecord,
  EntityId,
  PublishedGcpOptimizationEntry,
} from '@himmelcad/data';

import {
  formatAlignmentLineageLabel,
  formatGcpRevisionLineageLabel,
  hash8,
  shortOperationId,
  // @ts-expect-error Node's strip-types test runner loads the TypeScript source directly.
} from './alignmentMergeLineage.ts';

test('formats readable alignment and GCP lineage while retaining full ids', () => {
  const alignmentId = 'project:alignment:raw-identifier' as EntityId;
  const gcpId = 'project:alignment:gcp-identifier' as EntityId;
  const candidates = [
    {
      entityId: alignmentId,
      name: 'North mission',
      jobId: 'alignment-job',
      publicationSequence: 1,
      versionSha256: '1234567890abcdef',
      cameraEntityIds: [],
    },
  ] as unknown as AlignmentMergeCandidateRecord[];
  const optimizations = [
    {
      entityId: gcpId,
      optimization: {
        operationId: 'optimization-for-north-mission-000042',
        snapshotSha256: 'abcdef0123456789',
      },
    },
  ] as unknown as PublishedGcpOptimizationEntry[];

  assert.deepEqual(formatAlignmentLineageLabel(alignmentId, candidates), {
    text: 'North mission · 12345678',
    title: alignmentId,
  });
  assert.deepEqual(formatGcpRevisionLineageLabel(gcpId, optimizations), {
    text: 'optimizati…000042 · abcdef01',
    title: gcpId,
  });
});

test('uses deterministic compact fallbacks', () => {
  const entityId = 'project:alignment:missing' as EntityId;
  assert.equal(hash8('0123456789'), '01234567');
  assert.equal(shortOperationId('short-operation'), 'short-operation');
  assert.deepEqual(formatAlignmentLineageLabel(entityId, []), {
    text: 'Alignment · missing',
    title: entityId,
  });
});
