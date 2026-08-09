import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createJournalMirror,
  reduceJournalMirror,
  type CanonicalEntity,
  type CanonicalJournalEntry,
} from '../src/index.js';

void test('journal mirror applies canonical effects, ignores replay and fails closed on a gap', () => {
  const a1 = entity('a', 1);
  const a2 = entity('a', 2);
  const b1 = entity('b', 1);
  const initial = createJournalMirror({
    generation: 10,
    journalHeadSequence: 10,
    entities: [a1],
    tombstones: [],
  });
  const entry = journalEntry(11, [
    { entityId: 'a', before: a1, after: a2, touchedFields: ['name'] },
    { entityId: 'b', before: null, after: b1, touchedFields: ['typeId'] },
  ]);

  const applied = reduceJournalMirror(initial, entry);
  assert.equal(applied.status, 'ready');
  assert.equal(applied.generation, 11);
  assert.equal(applied.appliedThroughSequence, 11);
  assert.equal(applied.entities.a?.revision, 2);
  assert.equal(applied.entities.b?.revision, 1);
  assert.strictEqual(reduceJournalMirror(applied, entry), applied);

  const gap = reduceJournalMirror(applied, journalEntry(13, []));
  assert.equal(gap.status, 'refresh-required');
  if (gap.status !== 'refresh-required') assert.fail('gap must request refresh');
  assert.equal(gap.expectedSequence, 12);
  assert.equal(gap.receivedSequence, 13);
  assert.strictEqual(reduceJournalMirror(gap, journalEntry(12, [])), gap);
});

void test('canonical delete effects remove live entities without fabricating tombstone hashes', () => {
  const a1 = entity('a', 1);
  const initial = createJournalMirror({
    generation: 1,
    journalHeadSequence: 1,
    entities: [a1],
    tombstones: [],
  });

  const deleted = reduceJournalMirror(
    initial,
    journalEntry(2, [{ entityId: 'a', before: a1, after: null, touchedFields: ['schemaVersion'] }]),
  );

  assert.equal(deleted.entities.a, undefined);
  assert.deepEqual(deleted.tombstones, {});
});

function entity(id: string, revision: number): CanonicalEntity {
  return {
    id,
    revision,
    typeId: 'hcad.group@1',
    name: id,
    owner: null,
    layerIds: [],
    placement: null,
    representations: [],
    componentsRef: 'a'.repeat(64),
    attributesRef: 'b'.repeat(64),
    relationsRef: 'c'.repeat(64),
    styleRef: null,
    schemaVersion: 1,
    versionHash: `${id}-${String(revision)}`,
  };
}

function journalEntry(
  sequence: number,
  effects: CanonicalJournalEntry['effects'],
): CanonicalJournalEntry {
  return {
    sequence,
    commandId: `command-${String(sequence)}`,
    kind: 'command',
    relatedCommandId: null,
    effects,
  };
}
