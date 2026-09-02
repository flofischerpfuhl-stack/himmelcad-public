import assert from 'node:assert/strict';
import test from 'node:test';

import type { EntityId, EntitySnapshot, ProjectSnapshot } from '@himmelcad/data';

import {
  revalidateSelection,
  // @ts-expect-error Node's strip-types test runner loads the TypeScript source directly.
} from './selectionLifecycle.ts';

const first = 'entity:first' as EntityId;
const second = 'entity:second' as EntityId;

test('hide keeps selected entity ids', () => {
  const selection = new Set([first]);
  const snapshot = project([entity(first, 'First', false)]);
  assert.equal(revalidateSelection(selection, snapshot), selection);
});

test('rename keeps selected entity ids', () => {
  const selection = new Set([first]);
  const snapshot = project([entity(first, 'Renamed', true)]);
  assert.equal(revalidateSelection(selection, snapshot), selection);
});

test('delete prunes only deleted ids', () => {
  const selection = new Set([first, second]);
  const snapshot = project([entity(second, 'Second', true)]);
  assert.deepEqual([...revalidateSelection(selection, snapshot)], [second]);
});

test('replacement rejects stale ids and keeps ids present in the replacement', () => {
  const selection = new Set([first, second]);
  const snapshot = project([entity(first, 'Replacement first', true)]);
  assert.deepEqual([...revalidateSelection(selection, snapshot)], [first]);
});

function project(entities: readonly EntitySnapshot[]): Pick<ProjectSnapshot, 'entities'> {
  return { entities: Object.fromEntries(entities.map((candidate) => [candidate.id, candidate])) };
}

function entity(id: EntityId, name: string, visible: boolean): EntitySnapshot {
  return {
    id,
    kind: 'Group',
    name,
    parent: null,
    children: [],
    visibility: { visible, locked: false },
    versionHash: '0'.repeat(64) as EntitySnapshot['versionHash'],
    bounds: null,
  };
}
