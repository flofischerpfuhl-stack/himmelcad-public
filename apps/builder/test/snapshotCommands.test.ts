import assert from 'node:assert/strict';
import test from 'node:test';

import type { ProjectSnapshot } from '@himmelcad/data';

import type { BuilderSnapshotSummary } from '../renderer/src/project.js';
import { executeBuilderSnapshotCommand } from '../renderer/src/snapshotCommands.js';

const named = snapshot('named', 'Before grading', 'manual', 12);
const safety = snapshot('safety', "Before restoring 'Before grading'", 'pre_restore', 18);
const restoredProject = { projectId: 'restored' } as ProjectSnapshot;

void test('snapshot UI/automation command path lists, creates, and restores canonical snapshots', async () => {
  const calls: string[] = [];
  let snapshots: readonly BuilderSnapshotSummary[] = [named];
  const session = {
    async createSnapshot(name: string) {
      calls.push(`create:${name}`);
      const created = snapshot('created', name, 'manual', 16);
      snapshots = [...snapshots, created];
      return created;
    },
    async listSnapshots() {
      calls.push('list');
      return snapshots;
    },
    async restoreSnapshot(entityId: string) {
      calls.push(`restore:${entityId}`);
      snapshots = [...snapshots, safety];
      return restoredProject;
    },
  };

  const listed = await executeBuilderSnapshotCommand(session, 'snapshot.list', {});
  assert.deepEqual(listed.result, [named]);
  const created = await executeBuilderSnapshotCommand(session, 'snapshot.create', {
    name: 'Before utilities',
  });
  assert.equal(created.result.name, 'Before utilities');
  const restored = await executeBuilderSnapshotCommand(session, 'snapshot.restore', {
    entityId: named.entityId,
  });
  assert.equal(restored.result, named);
  assert.equal(restored.project, restoredProject);
  assert.ok(restored.snapshots.includes(safety));
  assert.deepEqual(calls, [
    'list',
    'create:Before utilities',
    'list',
    'list',
    'restore:named',
    'list',
  ]);
});

void test('snapshot commands reject missing names, ids, and stale restore targets', async () => {
  const session = {
    async createSnapshot() {
      throw new Error('must not create');
    },
    async listSnapshots() {
      return [named];
    },
    async restoreSnapshot() {
      throw new Error('must not restore');
    },
  };
  await assert.rejects(
    executeBuilderSnapshotCommand(session, 'snapshot.create', { name: '  ' }),
    /payload\.name/,
  );
  await assert.rejects(
    executeBuilderSnapshotCommand(session, 'snapshot.restore', { entityId: 'missing' }),
    /no longer exists/,
  );
});

function snapshot(
  entityId: string,
  name: string,
  markerKind: BuilderSnapshotSummary['marker']['markerKind'],
  markedGeneration: number,
): BuilderSnapshotSummary {
  return {
    entityId,
    name,
    marker: {
      schemaId: 'hcad.snapshot-marker@1',
      schemaVersion: 1,
      markedGeneration,
      markerKind,
      createdAt: '2026-09-08T10:00:00Z',
      origin: markerKind === 'manual' ? 'ui' : 'system',
    },
  };
}
