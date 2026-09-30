import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createDemoDocument,
  type SetAppearanceFeature,
} from '../../renderer/src/model/document.js';
import { applyBodyColour, applyBodyMaterial } from '../../renderer/src/model/appearance.js';
import { moveFeature } from '../../renderer/src/model/historyTools.js';
import { usePrintStore } from '../../renderer/src/print/printStore.js';
import { useAssemblerStore } from '../../renderer/src/model/store.js';
import { createEvaluator } from '../../renderer/src/kernel/evaluator.js';
import type { EvaluationResult } from '../../renderer/src/kernel/types.js';
import type { Feature } from '../../renderer/src/model/document.js';
import { createNodeKernelAdapter, loadNodeKernel } from '../kernel/nodeKernel.js';

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

const round = (v: number) => Math.round(v * 1e6) / 1e6;

/** What a user can observe about a result (no timings, no mesh ids). */
function digest(result: EvaluationResult): unknown {
  return {
    errors: result.errors,
    warnings: result.warnings,
    sketches: result.sketches.map((s) => s.featureId),
    bodies: result.bodies.map((b) => ({
      id: b.id,
      name: b.name,
      color: b.color,
      volume: round(b.volume),
      min: b.min.map(round),
      max: b.max.map(round),
      faces: b.faces.map((f) => [f.key, ...f.aliases].join(',')),
      edges: b.edges.map((e) => e.key),
    })),
  };
}

/** A cache-free replay of `features` (a new evaluator: no checkpoints). */
async function reference(features: Feature[]): Promise<unknown> {
  const { oc } = await loadNodeKernel();
  return digest(await createEvaluator(oc).evaluate(features));
}

function activeSlice(s: ReturnType<typeof store.getState>): Feature[] {
  const index = s.rollbackBefore ? s.features.findIndex((f) => f.id === s.rollbackBefore) : -1;
  return index < 0 ? s.features : s.features.slice(0, index);
}

void test('rollback, edits above the bar, reorder and roll-forward never reuse stale prefix-cache entries', async () => {
  store.getState().loadDocument(createDemoDocument());
  const full = await settled();
  assert.deepEqual(digest(full.evaluation), await reference(full.features));

  // Rolling back to a prefix of the evaluated document reuses its checkpoints.
  store.getState().setRollback('feature-fillet-3');
  const rolled = await settled();
  assert.equal(rolled.evaluation.stats.evaluatedFeatures, 0, 'the prefix was already computed');
  assert.deepEqual(digest(rolled.evaluation), await reference(activeSlice(rolled)));

  // Editing a step above the bar re-evaluates from that step and gives the replay result.
  store.getState().editFeatureParams('feature-extrude-2', { distance: 30 });
  const edited = await settled();
  assert.equal(edited.rollbackBefore, 'feature-fillet-3');
  assert.deepEqual(digest(edited.evaluation), await reference(activeSlice(edited)));
  assert.ok(edited.evaluation.bodies[0]!.max[2]! < 36 + 1e-6, 'the edited upright height (6 + 30)');

  // Rolling forward evaluates the later steps on the edited prefix (not the old checkpoints).
  store.getState().setRollback(null);
  const forward = await settled();
  assert.ok((forward.evaluation.stats.evaluatedFeatures ?? 0) > 0, 'later steps are recomputed');
  assert.deepEqual(digest(forward.evaluation), await reference(forward.features));
  assert.notDeepEqual(digest(forward.evaluation), digest(full.evaluation));

  // Reorder (fillet after the hole): same features, other order, other checkpoints.
  const reordered = moveFeature(forward.features, 4, 6);
  assert.equal(store.getState().commitDocumentChange(reordered, { keepRollback: true }), true);
  const moved = await settled();
  assert.deepEqual(moved.features.map((f) => f.id).slice(4), [
    'feature-sketch-4',
    'feature-extrude-5',
    'feature-fillet-3',
  ]);
  assert.deepEqual(digest(moved.evaluation), await reference(moved.features));

  // Rolling back inside the reordered list: the prefix differs from every earlier one.
  store.getState().setRollback('feature-extrude-5');
  const movedBack = await settled();
  assert.deepEqual(digest(movedBack.evaluation), await reference(activeSlice(movedBack)));

  // Undo all the way back gives exactly the first result again (from the caches).
  store.getState().setRollback(null);
  while (store.getState().history.canUndo) store.getState().undo();
  const original = await settled();
  assert.deepEqual(digest(original.evaluation), digest(full.evaluation));
});

void test('panel steps while rolled back (colour, material, Place on Plate) go in at the marker', async () => {
  store.getState().loadDocument(createDemoDocument());
  await settled();
  store.getState().setRollback('feature-fillet-3');
  const rolled = await settled();
  const bodyId = rolled.evaluation.bodies[0]!.id;
  const ids = () => store.getState().features.map((f) => f.id);
  const tail = ['feature-fillet-3', 'feature-sketch-4', 'feature-extrude-5'];

  // Colour dialog: a new setAppearance step directly above the bar, the bar stays.
  assert.equal(applyBodyColour([bodyId], '#FF0000'), true);
  const coloured = await settled();
  const colourStep = coloured.features[4]!;
  assert.equal(colourStep.kind, 'setAppearance');
  assert.deepEqual(ids().slice(5), tail, 'rolled-back steps stay below the new step');
  assert.equal(coloured.rollbackBefore, 'feature-fillet-3');
  assert.equal(coloured.evaluation.bodies[0]!.color.toUpperCase(), '#FF0000');

  // Material right after: the same step is updated (no new step, still above the bar).
  assert.equal(applyBodyMaterial([bodyId], 'petg'), true);
  const withMaterial = await settled();
  assert.equal(withMaterial.features.length, 8);
  const step = withMaterial.features[4]!;
  assert.ok(step.kind === 'setAppearance' && step.material === 'petg' && step.id === colourStep.id);
  assert.deepEqual(ids().slice(5), tail);

  // Two bodies at once (one of them unknown to the model is still a step): both above the bar.
  assert.equal(applyBodyColour([bodyId, 'body:other'], '#00FF00'), true);
  const two = await settled();
  assert.deepEqual(
    two.features.slice(5, 7).map((f) => f.kind),
    ['setAppearance', 'setAppearance'],
  );
  assert.deepEqual(ids().slice(7), tail);
  assert.equal(two.rollbackBefore, 'feature-fillet-3');

  // Print mode Place on Plate (a transform step created from the Printability panel).
  const side = two.evaluation.bodies[0]!.faces.find(
    (f) => f.normal && Math.abs(f.normal[0] + 1) < 1e-9,
  );
  assert.ok(side, 'a -X planar face');
  assert.equal(usePrintStore.getState().placeOnPlate(bodyId, side.key), null);
  const placed = await settled();
  assert.equal(placed.features[7]!.kind, 'transform');
  assert.deepEqual(ids().slice(8), tail);
  assert.equal(placed.rollbackBefore, 'feature-fillet-3');

  // Each was one undo step; undo keeps the bar.
  store.getState().undo();
  store.getState().undo();
  const undone = await settled();
  assert.equal(undone.features.length, 8);
  assert.equal(undone.rollbackBefore, 'feature-fillet-3');
});
