import assert from 'node:assert/strict';
import test from 'node:test';
import { ViewLocalHistory, type ViewHistoryPersistence, parseViewStateV2 } from '../src/index.js';

function memory(): ViewHistoryPersistence & { records: Map<string, unknown> } {
  const records = new Map<string, unknown>();
  return {
    records,
    async load(id) {
      return records.get(id) ?? null;
    },
    async store(id, value) {
      records.set(id, structuredClone(value));
    },
  };
}
const parse = (input: unknown): number => {
  if (typeof input !== 'number' || !Number.isFinite(input)) throw new TypeError('invalid state');
  return input;
};

void test('P8 streams rehydrate independently; undo restores pose, branch truncates, no document client', async () => {
  const cameras = memory(),
    displays = memory();
  const camera = new ViewLocalHistory('p', 'camera', 10, parse, cameras);
  const display = new ViewLocalHistory('p', 'display', 1, parse, displays);
  await camera.open();
  await display.open();
  assert.equal(
    cameras.records.size + displays.records.size,
    0,
    'opening missing streams never writes',
  );
  camera.commit(20, 'gesture-1');
  display.commit(0);
  assert.equal(camera.undo(), 10);
  assert.equal(display.current, 0);
  await camera.flushPersistence();
  await display.flushPersistence();
  const restoredCamera = new ViewLocalHistory('p', 'camera', 0, parse, cameras);
  const restoredDisplay = new ViewLocalHistory('p', 'display', 1, parse, displays);
  await restoredCamera.open();
  await restoredDisplay.open();
  assert.equal(restoredCamera.current, 10);
  assert.equal(restoredDisplay.current, 0);
  assert.equal(restoredCamera.redo(), 20);
  restoredCamera.undo();
  restoredCamera.commit(30);
  assert.equal(restoredCamera.canRedo, false);
  assert.equal(restoredCamera.snapshot.localSequence, 2);
  restoredCamera.clear();
  assert.equal(restoredCamera.current, 30);
});

void test('corrupt stream resets only itself and explains recovery', async () => {
  const persistence = memory();
  const messages: string[] = [];
  persistence.records.set('p', { history: { schemaId: 'bad' } });
  const history = new ViewLocalHistory('p', 'display', 7, parse, persistence, (message) =>
    messages.push(message),
  );
  await history.open();
  assert.equal(history.current, 7);
  assert.equal(history.canUndo, false);
  assert.match(messages[0]!, /display history reset/);
});

void test('ViewState v2 passes parser and local journal round trip', async () => {
  const state = parseViewStateV2({
    schema: 'himmelcad.view-state',
    version: 2,
    camera: {
      position: { x: 0, y: -10, z: 10 },
      target: { x: 0, y: 0, z: 0 },
      up: { x: 0, y: 0, z: 1 },
      projection: { kind: 'perspective', verticalFieldOfViewRadians: 1, near: 0.1, far: 1000 },
    },
    navigationMode: '3d',
    hiddenEntityIds: [],
    sessionHiddenEntityIds: ['local'],
    selectedEntityIds: [],
    clipRefs: [{ entityId: 'box', expectedRevision: 2, active: true, locked: false }],
    presentation: {
      background: 'black',
      renderStyle: 'source',
      showGrid: false,
      showAxes: false,
      showSelectionOutline: true,
      colorModeOverride: { kind: 'follow' },
      pointSizeMultiplier: 1,
    },
  });
  const persistence = memory();
  const history = new ViewLocalHistory('p', 'display', state, parseViewStateV2, persistence);
  await history.open();
  history.commit({ ...state, sessionHiddenEntityIds: [] });
  await history.flushPersistence();
  const restored = new ViewLocalHistory('p', 'display', state, parseViewStateV2, persistence);
  await restored.open();
  assert.deepEqual(restored.undo(), state);
});
