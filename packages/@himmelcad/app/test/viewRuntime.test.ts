import assert from 'node:assert/strict';
import test from 'node:test';

import {
  StaleViewReferenceError,
  ViewBookmarkController,
  ViewDisplayStore,
  applyViewStateAtomically,
  type ViewBookmarkJournal,
  type ViewBookmarkV1,
  type ViewHistoryPersistence,
  type ViewStateV2,
} from '../src/index.js';

const camera = {
  position: { x: 0, y: -10, z: 10 },
  target: { x: 0, y: 0, z: 0 },
  up: { x: 0, y: 0, z: 1 },
  projection: { kind: 'perspective' as const, verticalFieldOfViewRadians: 1, near: 0.1, far: 1000 },
};

function state(revision = 2): ViewStateV2 {
  return {
    schema: 'himmelcad.view-state', version: 2, camera, navigationMode: '3d',
    hiddenEntityIds: ['canonical-hidden'], sessionHiddenEntityIds: ['session-hidden'],
    selectedEntityIds: ['selected'],
    clipRefs: [{ entityId: 'box', expectedRevision: revision, active: true, locked: false }],
    presentation: {
      background: 'black', renderStyle: 'source', showGrid: false, showAxes: false,
      showSelectionOutline: true, colorModeOverride: { kind: 'follow' }, pointSizeMultiplier: 1.75,
    },
  };
}

function persistence(): ViewHistoryPersistence & { records: Map<string, unknown> } {
  const records = new Map<string, unknown>();
  return {
    records,
    async load(id) { return records.get(id) ?? null; },
    async store(id, value) { records.set(id, structuredClone(value)); },
  };
}

void test('G-VD-STATE validates every viewing-box revision before applying anything', async () => {
  let applications = 0;
  await assert.rejects(
    applyViewStateAtomically(
      state(1),
      (entityId) => ({ entityId, revision: 2, kind: 'viewing-box' }),
      () => { applications += 1; },
    ),
    StaleViewReferenceError,
  );
  assert.equal(applications, 0, 'stale reference rejection is atomic');
});

void test('P8/P9 display defaults preserve overrides, never call a document journal, and rehydrate per project', async () => {
  const stored = persistence();
  let canonicalJournalWrites = 0;
  const display = new ViewDisplayStore(stored, () => { canonicalJournalWrites += 1; });
  await display.openProject('a');
  display.setOverride('fixed', 'reference');
  display.setGlobalDefault('hidden');
  display.replaceState({
    ...display.getSnapshot().state,
    activeClipEntityIds: ['box'],
    presentation: state().presentation,
  });
  assert.equal(display.effective('fixed'), 'reference');
  assert.equal(display.effective('other'), 'hidden');
  assert.equal(canonicalJournalWrites, 0);
  await display.flushPersistence();
  await display.openProject('b');
  assert.equal(display.effective('other'), 'editable');
  await display.openProject('a');
  assert.equal(display.effective('fixed'), 'reference');
  assert.equal(display.effective('other'), 'hidden');
  assert.deepEqual(display.getSnapshot().state.activeClipEntityIds, ['box']);
  assert.equal(display.getSnapshot().state.presentation.pointSizeMultiplier, 1.75);
  assert.equal(display.undo(), true);
  assert.equal(display.effective('other'), 'hidden');
  assert.equal(display.undo(), true);
  assert.equal(display.effective('other'), 'editable');
});

void test('canonical bookmark create/list/restore round-trips and preserves every VD-D3 exclusion', async () => {
  const records = new Map<string, ViewBookmarkV1>();
  let journalWrites = 0;
  const journal: ViewBookmarkJournal = {
    async create(name, captured) {
      journalWrites += 1;
      const bookmark = { schemaId: 'hcad.view-bookmark@1' as const, entityId: 'bookmark', revision: 0, name, state: captured };
      records.set(bookmark.entityId, bookmark);
      return structuredClone(bookmark);
    },
    async list() { return [...records.values()].map((value) => structuredClone(value)); },
    async read(id) { return structuredClone(records.get(id) ?? null); },
    async recordRestore() { journalWrites += 1; },
  };
  let live = state();
  const applied: ViewStateV2[] = [];
  const controller = new ViewBookmarkController(
    journal,
    (entityId) => ({ entityId, revision: 2, kind: 'viewing-box' }),
    () => live,
    async (next) => { applied.push(next); },
  );
  const created = await controller.create('Bearing detail', live);
  assert.equal(created.state.schemaId, 'hcad.bookmark-view-state@1');
  assert.equal('selectedEntityIds' in created.state, false);
  assert.equal('sessionHiddenEntityIds' in created.state, false);
  assert.equal('pointSizeMultiplier' in created.state.presentation, false);
  live = { ...live, selectedEntityIds: ['new-selection'], sessionHiddenEntityIds: ['new-session-hide'], presentation: { ...live.presentation, pointSizeMultiplier: 2 } };
  assert.equal((await controller.list()).length, 1);
  await controller.restore(created.entityId, created.revision);
  assert.equal(journalWrites, 2);
  assert.deepEqual(applied[0]?.selectedEntityIds, ['new-selection']);
  assert.deepEqual(applied[0]?.sessionHiddenEntityIds, ['new-session-hide']);
  assert.equal(applied[0]?.presentation.pointSizeMultiplier, 2);
});
