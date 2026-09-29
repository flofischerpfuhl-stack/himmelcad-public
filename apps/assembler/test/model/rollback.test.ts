import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createDemoDocument,
  type SetAppearanceFeature,
} from '../../renderer/src/model/document.js';
import { moveFeature } from '../../renderer/src/model/historyTools.js';
import { useAssemblerStore } from '../../renderer/src/model/store.js';
import { createNodeKernelAdapter } from '../kernel/nodeKernel.js';

const store = useAssemblerStore;
store.getState().attachKernel(createNodeKernelAdapter());

async function settled() {
  await store.getState().whenSettled();
  return store.getState();
}

function appearance(id: string, color: string): SetAppearanceFeature {
  return {
    id,
    name: id,
    suppressed: false,
    kind: 'setAppearance',
    bodyId: 'body:feature-extrude-1',
    color,
  };
}

void test('rolling back excludes the later steps from evaluation; rolling forward restores them', async () => {
  store.getState().loadDocument(createDemoDocument());
  const full = await settled();
  const fullVolume = full.evaluation.bodies[0]!.volume;
  store.getState().setRollback('feature-fillet-3');
  const rolled = await settled();
  assert.equal(rolled.rollbackBefore, 'feature-fillet-3');
  assert.equal(rolled.features.length, 7, 'the document keeps every step');
  // No fillet, no hole: 80*50*6 + 80*8*40.
  assert.ok(Math.abs(rolled.evaluation.bodies[0]!.volume - (80 * 50 * 6 + 80 * 8 * 40)) < 1e-3);
  assert.equal(rolled.evaluation.sketches.length, 2, 'Sketch 3 is rolled back too');
  assert.equal(rolled.history.canUndo, false, 'moving the marker is not an undo step');
  store.getState().setRollback(null);
  const forward = await settled();
  assert.ok(Math.abs(forward.evaluation.bodies[0]!.volume - fullVolume) < 1e-6);
});

void test('new steps are inserted at the marker and undo/redo keep the marker', async () => {
  store.getState().loadDocument(createDemoDocument());
  await settled();
  store.getState().setRollback('feature-fillet-3');
  await settled();
  store.getState().addFeature(appearance('appearance-a', '#FF0000'));
  const inserted = await settled();
  assert.deepEqual(inserted.features.map((f) => f.id).slice(3, 6), [
    'feature-extrude-2',
    'appearance-a',
    'feature-fillet-3',
  ]);
  assert.equal(inserted.rollbackBefore, 'feature-fillet-3');
  assert.equal(inserted.evaluation.bodies[0]!.color.toUpperCase(), '#FF0000');
  store.getState().undo();
  const undone = await settled();
  assert.equal(undone.features.length, 7);
  assert.equal(undone.rollbackBefore, 'feature-fillet-3');
  store.getState().redo();
  const redone = await settled();
  assert.equal(redone.features[4]!.id, 'appearance-a');
});

void test('deleting the marker step hands the marker to the next step; agent commits lift it', async () => {
  store.getState().loadDocument(createDemoDocument());
  await settled();
  store.getState().setRollback('feature-fillet-3');
  store.getState().deleteFeature('feature-fillet-3');
  const afterDelete = await settled();
  assert.equal(afterDelete.rollbackBefore, 'feature-sketch-4');
  // A reorder through the UI path keeps the marker…
  const s = store.getState();
  const reordered = moveFeature(s.features, 5, 4);
  assert.equal(s.commitDocumentChange(reordered, { keepRollback: true }), true);
  assert.equal((await settled()).rollbackBefore, 'feature-sketch-4');
  // …an agent commit (default) acts on the full history.
  assert.equal(store.getState().commitDocumentChange([...store.getState().features]), true);
  assert.equal((await settled()).rollbackBefore, null);
});

void test('setSelection replaces the selection in one step', async () => {
  store.getState().loadDocument(createDemoDocument());
  const s = await settled();
  const body = s.evaluation.bodies[0]!;
  store.getState().setSelection([
    { kind: 'body', bodyId: body.id },
    { kind: 'edge', bodyId: body.id, edgeKey: body.edges[0]!.key },
  ]);
  assert.equal(store.getState().selection.length, 2);
  store.getState().setSelection([]);
  assert.equal(store.getState().selection.length, 0);
});
