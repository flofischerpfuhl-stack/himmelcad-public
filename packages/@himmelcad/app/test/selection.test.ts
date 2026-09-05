import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import test from 'node:test';

import {
  MIXED,
  MemorySelectionPersistence,
  SelectionStore,
  assignToAll,
  executeSelectionCommand,
  sharedPropertySet,
  type CandidateInvalidationReason,
  type SelectionMember,
} from '../src/index.js';

const live = (...ids: string[]): Set<string> => new Set(ids);
const kind = (id: string): string =>
  id.startsWith('cloud')
    ? 'PointCloud'
    : id.startsWith('splat')
      ? 'GaussianSplatCloud'
      : 'Polyline3D';

async function store(ids = ['a', 'b', 'cloud-1', 'splat-1']): Promise<SelectionStore> {
  const result = new SelectionStore();
  await result.openProject('project-a', live(...ids), kind);
  return result;
}

void test('G-SE-CORE UIP-D2 applies every mouse and touch set-semantics row', async () => {
  const selection = await store();
  assert.equal(selection.pointerSelect('a', { modality: 'mouse' }), true);
  assert.deepEqual([...selection.getSnapshot().selectedEntityIds], ['a']);
  assert.equal(
    selection.pointerSelect('a', { modality: 'mouse' }),
    false,
    'mouse click is idempotent',
  );
  assert.equal(selection.pointerSelect('b', { modality: 'mouse', ctrlKey: true }), true);
  assert.deepEqual(new Set(selection.getSnapshot().selectedEntityIds), live('a', 'b'));
  selection.pointerSelect('a', { modality: 'mouse', ctrlKey: true });
  assert.deepEqual([...selection.getSnapshot().selectedEntityIds], ['b']);
  assert.equal(selection.pointerSelect(null, { modality: 'mouse' }), false, 'single void is inert');
  selection.clear();
  selection.pointerSelect('a', { modality: 'touch' });
  selection.pointerSelect('a', { modality: 'touch' });
  assert.equal(selection.getSnapshot().selectedEntityIds.size, 0, 'touch tap-again deselects');
  selection.pointerSelect('a', { modality: 'touch' });
  selection.pointerSelect('b', { modality: 'touch' });
  assert.deepEqual([...selection.getSnapshot().selectedEntityIds], ['b'], 'touch tap replaces');
});

void test('G-SE-CORE UIP-D15 excludes cloud/splat clicks and exposes bounding-box halo flags', async () => {
  const selection = await store();
  assert.equal(selection.pointerSelect('cloud-1', { modality: 'mouse' }), false);
  assert.equal(selection.pointerSelect('splat-1', { modality: 'mouse', ctrlKey: true }), false);
  selection.replace(['cloud-1', 'splat-1']);
  assert.deepEqual(selection.getSnapshot().boundingBoxHaloEntityIds, live('cloud-1', 'splat-1'));
});

void test('SE-D18 reuses the canonical stable curve-subentity locator as set identity', async () => {
  const selection = await store(['curve']);
  const segment = {
    kind: 'curveSubentity',
    ref: {
      schemaId: 'hcad.curve-subentity-ref@1',
      schemaVersion: 1,
      parentId: 'curve',
      parentRevision: 7,
      topologyKind: 'edge',
      stableMemberId: 'edge-2',
      directedParameterInterval: [0.25, 0.5],
      loopId: null,
      useId: null,
      semanticHash: 'a'.repeat(64),
    },
  } as SelectionMember;
  selection.replaceMembers([segment, segment]);
  assert.equal(selection.getSnapshot().members.length, 1);
  assert.deepEqual([...selection.getSnapshot().selectedEntityIds], ['curve']);
  selection.pruneDeleted(['curve']);
  assert.equal(selection.getSnapshot().members.length, 0);
});

void test('G-SE-CORE/G-SE-P4 hide survives, journal deletion prunes, and undo never resurrects', async () => {
  const selection = await store();
  selection.replace(['a', 'b']);
  selection.entitiesHidden(['a']);
  assert.deepEqual(new Set(selection.getSnapshot().selectedEntityIds), live('a', 'b'));
  selection.clear();
  assert.equal(
    selection.pointerSelect('a', { modality: 'mouse' }),
    false,
    'hidden is not click selectable',
  );
  selection.replace(['a', 'b']);
  selection.pruneDeleted(['a']);
  assert.deepEqual([...selection.getSnapshot().selectedEntityIds], ['b']);
  selection.undo();
  assert.deepEqual([...selection.getSnapshot().selectedEntityIds], ['b']);
});

void test('G-SE-CORE project switch stores then unloads and rehydrates each project', async () => {
  const persistence = new MemorySelectionPersistence();
  const selection = new SelectionStore({ persistence });
  await selection.openProject('a', live('a1'), () => 'Polyline3D');
  selection.replace(['a1']);
  await selection.switchProject('b', live('b1'), () => 'SinglePoint');
  assert.equal(selection.getSnapshot().selectedEntityIds.size, 0);
  selection.replace(['b1']);
  await selection.switchProject('a', live('a1'), () => 'Polyline3D');
  assert.deepEqual([...selection.getSnapshot().selectedEntityIds], ['a1']);
});

void test('UIP-D16 candidate copy, cycling, and every invalidation event', async () => {
  const reasons: CandidateInvalidationReason[] = [
    'cameraMove',
    'newClick',
    'toolCancel',
    'permissionChange',
    'overlayChange',
    'kindFilterChange',
    'renderGenerationChange',
    'deviceLoss',
    'viewportBlur',
    'escape',
  ];
  const selection = await store(['a', 'b']);
  const candidates = [
    { entityId: 'a', name: 'A', kind: 'Polyline3D' },
    { entityId: 'b', name: 'B', kind: 'Polyline3D' },
  ];
  selection.setCandidates(candidates, 0);
  assert.equal(
    selection.getSnapshot().candidates?.statusText,
    '1 of 2 under cursor — Up/Down cycles',
  );
  assert.equal(selection.cycleCandidate(1)?.entityId, 'b');
  assert.deepEqual([...selection.getSnapshot().selectedEntityIds], ['b']);
  for (const reason of reasons) {
    selection.setCandidates(candidates, 0);
    selection.invalidateCandidates(reason);
    assert.equal(selection.getSnapshot().candidates, null, reason);
  }
});

void test('UIP-D17 sharedPropertySet intersects fields and marks mixed values', () => {
  const result = sharedPropertySet([
    { kind: 'point', fields: { layer: 'Survey', elevation: 4, pointOnly: true } },
    { kind: 'polyline', fields: { layer: 'Survey', elevation: 8, lineOnly: true } },
  ]);
  assert.deepEqual(result.perKind, { point: 1, polyline: 1 });
  assert.equal(result.fields.layer, 'Survey');
  assert.equal(result.fields.elevation, MIXED);
  assert.equal('pointOnly' in result.fields, false);
});

void test('UIP-D17 assignToAll emits exactly one journaled batch for the whole selection', async () => {
  const batches: unknown[] = [];
  const batch = await assignToAll(
    [{ entityId: 'a' }, { entityId: 'b' }, { entityId: 'a' }],
    'elevation',
    12.5,
    async (value) => {
      batches.push(value);
    },
  );
  assert.equal(batches.length, 1);
  assert.deepEqual(batch.entityIds, ['a', 'b']);
  assert.deepEqual(batch.assignments, [{ field: 'elevation', value: 12.5 }]);
});

void test('G-B2-HISTORY traverses 1,000 selection steps under 50 ms each direction', async (t) => {
  const selection = new SelectionStore({ historyDepth: 1_100 });
  await selection.openProject('perf', live('a'), () => 'Polyline3D');
  for (let index = 0; index < 1_000; index += 1) selection.toggle('a');
  let started = performance.now();
  for (let index = 0; index < 1_000; index += 1) assert.equal(selection.undo(), true);
  const undoMs = performance.now() - started;
  started = performance.now();
  for (let index = 0; index < 1_000; index += 1) assert.equal(selection.redo(), true);
  const redoMs = performance.now() - started;
  assert.ok(undoMs < 50, `1,000 undos took ${undoMs.toFixed(3)} ms`);
  assert.ok(redoMs < 50, `1,000 redos took ${redoMs.toFixed(3)} ms`);
  t.diagnostic(`selection history: undo=${undoMs.toFixed(3)} ms redo=${redoMs.toFixed(3)} ms`);
});

void test('G-B2-HISTORY persists/rehydrates and isolates corrupt selection recovery', async () => {
  const persistence = new MemorySelectionPersistence();
  const first = new SelectionStore({ persistence });
  await first.openProject('persisted', live('a', 'b'), kind);
  first.replace(['a']);
  first.toggle('b');
  await first.flushPersistence();
  const second = new SelectionStore({ persistence });
  await second.openProject('persisted', live('a', 'b'), kind);
  assert.deepEqual(new Set(second.getSnapshot().selectedEntityIds), live('a', 'b'));
  assert.equal(second.undo(), true);
  assert.deepEqual([...second.getSnapshot().selectedEntityIds], ['a']);

  const record = persistence.records.get('persisted')!;
  persistence.records.set('persisted', {
    ...record,
    history: { ...record.history, checksum: '0'.repeat(64) as never },
  });
  const messages: string[] = [];
  const recovered = new SelectionStore({
    persistence,
    onRecovery: (message) => messages.push(message),
  });
  await recovered.openProject('persisted', live('a', 'b'), kind);
  assert.deepEqual(new Set(recovered.getSnapshot().selectedEntityIds), live('a', 'b'));
  assert.equal(recovered.getSnapshot().canUndo, false);
  assert.match(messages[0]!, /without changing the document/);

  const malformedMessages: string[] = [];
  const malformed = new SelectionStore({
    persistence: {
      load: async () => {
        throw new SyntaxError('malformed JSON');
      },
      store: async () => undefined,
    },
    onRecovery: (message) => malformedMessages.push(message),
  });
  await malformed.openProject('persisted', live('a', 'b'), kind);
  assert.equal(malformed.getSnapshot().selectedEntityIds.size, 0);
  assert.equal(malformed.getSnapshot().canUndo, false);
  assert.match(malformedMessages[0]!, /malformed JSON/);
});

void test('extreme-member 10^5 ids toggle/clear under 150 ms without property computation', async (t) => {
  const ids = Array.from({ length: 100_000 }, (_, index) => `entity-${index}`);
  const selection = await store(ids);
  selection.replace(ids);
  let started = performance.now();
  selection.toggle('entity-50000');
  const toggleMs = performance.now() - started;
  started = performance.now();
  selection.clear();
  const clearMs = performance.now() - started;
  assert.ok(toggleMs < 150, `toggle took ${toggleMs.toFixed(3)} ms`);
  assert.ok(clearMs < 150, `clear took ${clearMs.toFixed(3)} ms`);
  t.diagnostic(`selection 10^5: toggle=${toggleMs.toFixed(3)} ms clear=${clearMs.toFixed(3)} ms`);
  // Property aggregation is a separate pure call and therefore cannot run on either store path.
  assert.equal(selection.getSnapshot().selectedEntityIds.size, 0);
});

void test('automation parity: every canonical select row round-trips through one store', async () => {
  const selection = await store(['a', 'b']);
  const call = (id: Parameters<typeof executeSelectionCommand>[1], payload: unknown = {}) =>
    executeSelectionCommand(selection, id, { schemaId: 'hcad.selection-command@1', payload });
  call('select.set', { entityIds: ['a'] });
  call('select.toggle', { entityId: 'b' });
  assert.deepEqual((call('select.get').payload as { entityIds: string[] }).entityIds, ['a', 'b']);
  selection.setCandidates([
    { entityId: 'a', name: 'A', kind: 'Polyline3D' },
    { entityId: 'b', name: 'B', kind: 'Polyline3D' },
  ]);
  assert.equal(
    (call('select.candidates').payload as { statusText: string }).statusText,
    '1 of 2 under cursor — Up/Down cycles',
  );
  call('select.clear');
  call('select.undo');
  assert.deepEqual(
    new Set((call('select.get').payload as { entityIds: string[] }).entityIds),
    live('a', 'b'),
  );
  call('select.redo');
  assert.equal((call('select.get').payload as { entityIds: string[] }).entityIds.length, 0);
  assert.throws(
    () => call('select.set', { entityIds: ['missing'] }),
    /selection entity does not exist: missing/,
  );
  assert.equal((call('select.get').payload as { entityIds: string[] }).entityIds.length, 0);
});
