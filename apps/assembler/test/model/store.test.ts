import assert from 'node:assert/strict';
import test from 'node:test';

import { createDemoDocument, type SketchFeature } from '../../renderer/src/model/document.js';
import { useAssemblerStore } from '../../renderer/src/model/store.js';
import { createNodeKernelAdapter } from '../kernel/nodeKernel.js';

const store = useAssemblerStore;
store.getState().attachKernel(createNodeKernelAdapter());

const SKETCH: SketchFeature = {
  id: 'sketch-1',
  name: 'Sketch 1',
  suppressed: false,
  kind: 'sketch',
  plane: { kind: 'plane', plane: 'XY', offset: 0 },
  profiles: [{ kind: 'rectangle', x: 0, y: 0, width: 10, height: 10 }],
};

async function load(features: SketchFeature[] | ReturnType<typeof createDemoDocument>) {
  store.getState().loadDocument(features);
  await store.getState().whenSettled();
}

void test('kernel attaches and reports ready; the demo document evaluates asynchronously', async () => {
  await load(createDemoDocument());
  const state = store.getState();
  assert.equal(state.kernelStatus, 'ready');
  assert.equal(state.evaluationPending, false);
  assert.equal(state.evaluation.bodies.length, 1);
  assert.deepEqual(state.evaluation.errors, {});
});

void test('extrude tool: setDistance previews without touching features; cancel restores exactly', async () => {
  await load([SKETCH]);
  const before = store.getState().features;
  store.getState().beginExtrude({ kind: 'sketch', featureId: SKETCH.id });
  assert.equal(store.getState().activeTool?.kind, 'extrude');

  store.getState().setDistance(12);
  await store.getState().whenSettled();
  const tool = store.getState().activeTool;
  assert.equal(tool?.kind, 'extrude');
  if (tool?.kind === 'extrude') {
    assert.equal(tool.previewEvaluation?.bodies.length, 1);
    assert.ok(Math.abs(tool.previewEvaluation!.bodies[0]!.max[2] - 12) < 1e-6);
  }
  // The provisional feature never appears in the committed document.
  assert.equal(store.getState().features, before);
  assert.equal(store.getState().features.length, 1);
  assert.equal(store.getState().history.canUndo, false);
  assert.equal(store.getState().evaluation.bodies.length, 0);

  store.getState().cancel();
  assert.equal(store.getState().activeTool, null);
  assert.equal(store.getState().features, before);
  assert.equal(store.getState().history.canUndo, false);
});

void test('extrude tool: commit is exactly one undo step; undo/redo round-trip reuses cached results', async () => {
  await load([SKETCH]);
  store.getState().beginExtrude({ kind: 'sketch', featureId: SKETCH.id });
  store.getState().setDistance(10);
  store.getState().commit();
  assert.equal(store.getState().activeTool, null);
  assert.equal(store.getState().features.length, 2);
  assert.equal(store.getState().evaluationPending, true);
  await store.getState().whenSettled();
  assert.equal(store.getState().evaluation.bodies.length, 1);
  assert.equal(store.getState().history.canUndo, true);
  assert.equal(store.getState().history.canRedo, false);

  // Both states were evaluated before, so undo/redo apply synchronously.
  store.getState().undo();
  assert.equal(store.getState().features.length, 1);
  assert.equal(store.getState().evaluationPending, false);
  assert.equal(store.getState().evaluation.bodies.length, 0);
  assert.equal(store.getState().history.canUndo, false);
  assert.equal(store.getState().history.canRedo, true);

  store.getState().redo();
  assert.equal(store.getState().features.length, 2);
  assert.equal(store.getState().evaluationPending, false);
  assert.equal(store.getState().evaluation.bodies.length, 1);
  assert.equal(store.getState().history.canUndo, true);
  assert.equal(store.getState().history.canRedo, false);
});

void test('selection is pruned after undo removes the selected body', async () => {
  await load([SKETCH]);
  store.getState().beginExtrude({ kind: 'sketch', featureId: SKETCH.id });
  store.getState().setDistance(10);
  store.getState().commit();
  await store.getState().whenSettled();

  const bodyId = store.getState().evaluation.bodies[0]!.id;
  store.getState().select({ kind: 'body', bodyId });
  assert.equal(store.getState().selection.length, 1);

  store.getState().undo();
  await store.getState().whenSettled();
  assert.equal(store.getState().evaluation.bodies.length, 0);
  assert.equal(store.getState().selection.length, 0);
});

void test('sketchRectangle tool: commit adds exactly one feature and selects its profile; cancel adds nothing', async () => {
  await load([]);
  store.getState().beginSketchRectangle();
  store.getState().setPreviewRect(1, 2, 30, 40);
  store.getState().commit();
  await store.getState().whenSettled();

  assert.equal(store.getState().features.length, 1);
  const feature = store.getState().features[0];
  assert.equal(feature?.kind, 'sketch');
  assert.equal(store.getState().selection.length, 1);
  assert.equal(store.getState().selection[0]?.kind, 'sketchProfile');
  assert.equal(store.getState().evaluation.sketches.length, 1);

  store.getState().beginSketchRectangle();
  store.getState().setPreviewRect(0, 0, 5, 5);
  store.getState().cancel();
  assert.equal(store.getState().features.length, 1);
  assert.equal(store.getState().history.canRedo, false);
});

void test('rapid parameter edits: only the newest revision is applied', async () => {
  await load([
    SKETCH,
    {
      id: 'extrude-2',
      name: 'Extrude 1',
      suppressed: false,
      kind: 'extrude',
      profile: { kind: 'sketch', featureId: SKETCH.id },
      distance: 5,
      symmetric: false,
      operation: 'new',
    },
  ]);
  const seen: number[] = [];
  const unsubscribe = store.subscribe((state, previous) => {
    if (state.evaluation !== previous.evaluation)
      seen.push(state.evaluation.bodies[0]?.max[0] ?? -1);
  });
  for (const width of [20, 30, 40]) {
    store.getState().editFeatureParams(SKETCH.id, {
      profiles: [{ kind: 'rectangle', x: 0, y: 0, width, height: 10 }],
    });
  }
  await store.getState().whenSettled();
  unsubscribe();
  assert.ok(Math.abs(store.getState().evaluation.bodies[0]!.max[0] - 40) < 1e-6);
  assert.ok(seen.length >= 1);
  assert.ok(Math.abs(seen[seen.length - 1]! - 40) < 1e-6, `last applied ${seen}`);
  // No result older than an already applied one is ever shown.
  for (let i = 1; i < seen.length; i += 1) assert.ok(seen[i]! >= seen[i - 1]!);
});

void test('a selected face survives re-evaluation after an earlier parameter edit', async () => {
  await load(createDemoDocument());
  const bodyId = 'body:feature-extrude-1';
  store.getState().select({ kind: 'face', bodyId, faceKey: 'feature-fillet-3:round:0' });
  store.getState().editFeatureParams('feature-sketch-1', {
    profiles: [{ kind: 'rectangle', x: 0, y: 0, width: 120, height: 50 }],
  });
  await store.getState().whenSettled();
  assert.deepEqual(store.getState().selection, [
    { kind: 'face', bodyId, faceKey: 'feature-fillet-3:round:0' },
  ]);
  assert.ok(Math.abs(store.getState().evaluation.bodies[0]!.max[0] - 120) < 1e-6);
});

void test('fillet command on a selected edge adds one feature that evaluates without errors', async () => {
  await load(createDemoDocument());
  const body = store.getState().evaluation.bodies[0]!;
  const edge = body.edges.find(
    (e) =>
      e.curve === 'line' &&
      Math.abs(e.midpoint[2] - 46) < 1e-6 &&
      Math.abs(e.midpoint[1] - 42) < 1e-6,
  )!;
  store.getState().select({ kind: 'edge', bodyId: body.id, edgeKey: edge.key });
  store.getState().addEdgeBlend('fillet', 2);
  await store.getState().whenSettled();
  const added = store.getState().features.at(-1)!;
  assert.equal(added.kind, 'fillet');
  assert.deepEqual(store.getState().selection, [{ kind: 'feature', featureId: added.id }]);
  assert.equal(store.getState().evaluation.errors[added.id], undefined);
  assert.ok(
    store.getState().evaluation.bodies[0]!.faces.some((f) => f.key === `${added.id}:round:0`),
  );
  store.getState().undo();
  assert.equal(store.getState().features.length, createDemoDocument().length);
});
