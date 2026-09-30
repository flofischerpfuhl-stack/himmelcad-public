/**
 * Print mode state on the real kernel (inline runner): the analysis runs
 * when the mode turns on and again, debounced, after a document change;
 * Cancel keeps the last report; Place on Plate / Auto orient commit exactly
 * one undo step each; the place-on-plate pick reacts to a face click.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { useAssemblerStore } from '../../renderer/src/foundation/commands/store.js';
import { usePrintStore } from '../../renderer/src/print/printStore.js';
import { createNodeKernelAdapter } from '../kernel/nodeKernel.js';
import { boxFeatures, mushroom } from './fixtures.js';

const store = useAssemblerStore;
store.getState().attachKernel(createNodeKernelAdapter());

async function until(check: () => boolean, what: string, timeoutMs = 20000): Promise<void> {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > timeoutMs) throw new Error(`timed out: ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

async function load(features: Parameters<ReturnType<typeof store.getState>['loadDocument']>[0]) {
  store.getState().loadDocument(features, { projectName: 'Print' });
  await store.getState().whenSettled();
}

void test('analysis on enable, debounced re-analysis on document change, cancel', async () => {
  await load(mushroom());
  usePrintStore.getState().setEnabled(true);
  await until(() => usePrintStore.getState().status === 'done', 'first analysis');
  const first = usePrintStore.getState().report!;
  assert.equal(first.bodies.length, 1);
  assert.ok(
    first.findings.some((f) => f.kind === 'overhang'),
    'the cap overhangs',
  );
  assert.equal(usePrintStore.getState().reportEvaluation, store.getState().evaluation);

  // A document change schedules a new analysis (debounced), for the new evaluation.
  store.getState().addFeature(boxFeatures('x', 5, 5, 5, 40, 0)[0]!);
  store.getState().addFeature(boxFeatures('x', 5, 5, 5, 40, 0)[1]!);
  await store.getState().whenSettled();
  assert.equal(usePrintStore.getState().status, 'scheduled');
  await until(
    () =>
      usePrintStore.getState().status === 'done' &&
      usePrintStore.getState().reportEvaluation === store.getState().evaluation,
    'debounced re-analysis',
  );
  assert.equal(usePrintStore.getState().report!.bodies.length, 2);

  // Cancel: the last report stays, marked cancelled.
  usePrintStore.getState().analyzeNow();
  assert.equal(usePrintStore.getState().status, 'running');
  usePrintStore.getState().cancelAnalysis();
  await until(() => usePrintStore.getState().status === 'cancelled', 'cancelled');
  assert.equal(usePrintStore.getState().report!.bodies.length, 2);

  usePrintStore.getState().setEnabled(false);
  assert.equal(usePrintStore.getState().status, 'idle');
});

void test('Place on Plate and Auto orient are one undo step each', async () => {
  await load(mushroom());
  const bodyId = store.getState().evaluation.bodies[0]!.id;
  const top = store
    .getState()
    .evaluation.bodies[0]!.faces.find((f) => f.normal && f.normal[2] > 0.99 && f.centroid[2] > 13)!;
  const count = store.getState().features.length;
  assert.equal(usePrintStore.getState().placeOnPlate(bodyId, top.key), null);
  await store.getState().whenSettled();
  assert.equal(store.getState().features.length, count + 1);
  const placed = store.getState().evaluation.bodies[0]!;
  assert.ok(Math.abs(placed.min[2]) < 1e-6 && Math.abs(placed.max[2] - 14) < 1e-6);
  store.getState().undo();
  await store.getState().whenSettled();
  assert.equal(store.getState().features.length, count);

  usePrintStore.getState().startAutoOrient(bodyId);
  await until(() => usePrintStore.getState().orient?.status === 'done', 'orientation ranking');
  const orient = usePrintStore.getState().orient!;
  assert.equal(orient.candidates.length, 3);
  assert.equal(orient.preview, 0, 'the best candidate is previewed');
  usePrintStore.getState().applyOrientation(0);
  await store.getState().whenSettled();
  assert.equal(store.getState().features.length, count + 1);
  assert.match(store.getState().features.at(-1)!.name, /^Orient for Print 1$/);
  assert.equal(usePrintStore.getState().orient, null);
  usePrintStore.getState().setEnabled(false);
});

void test('an orientation or placement that moves nothing adds no History step', async () => {
  await load(boxFeatures('n', 30, 20, 5));
  const body = store.getState().evaluation.bodies[0]!;
  const count = store.getState().features.length;
  // A flat plate on the plate: "as modelled" ranks first.
  usePrintStore.getState().startAutoOrient(body.id);
  await until(() => usePrintStore.getState().orient?.status === 'done', 'orientation ranking');
  usePrintStore.getState().applyOrientation(0);
  await store.getState().whenSettled();
  assert.equal(store.getState().features.length, count, 'no identity transform step');
  assert.equal(usePrintStore.getState().orient, null, 'the candidate list closes');
  // Its bottom face already lies on the plate.
  const bottom = body.faces.find((f) => f.normal && f.normal[2] < -0.99)!;
  assert.equal(usePrintStore.getState().placeOnPlate(body.id, bottom.key), null);
  await store.getState().whenSettled();
  assert.equal(store.getState().features.length, count);
});

void test('place-on-plate pick: the next face click places the body; empty selection cancels', async () => {
  await load(boxFeatures('p', 30, 20, 10));
  const body = store.getState().evaluation.bodies[0]!;
  const side = body.faces.find((f) => f.normal && f.normal[0] > 0.99)!;
  const count = store.getState().features.length;

  store.getState().setSelection([{ kind: 'body', bodyId: body.id }]);
  usePrintStore.getState().startPlacePicking(body.id);
  store.getState().setSelection([{ kind: 'face', bodyId: body.id, faceKey: side.key }]);
  await store.getState().whenSettled();
  assert.equal(usePrintStore.getState().placePicking, null);
  assert.equal(store.getState().features.length, count + 1);
  assert.ok(Math.abs(store.getState().evaluation.bodies[0]!.max[2] - 30) < 1e-6);

  usePrintStore.getState().startPlacePicking(body.id);
  store.getState().clearSelection();
  assert.equal(usePrintStore.getState().placePicking, null, 'Escape / empty click cancels');
  assert.equal(store.getState().features.length, count + 1);
});
