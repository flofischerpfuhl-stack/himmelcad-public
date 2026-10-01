/**
 * Block 8, SEL-12: sketch curves are selectable outside sketch mode — the
 * adaptive bar suggests Edit Sketch (which opens the sketch with the curve
 * selected), Delete from Sketch and Toggle Construction are one undo step
 * each, Delete (Del) removes the curve, and the selection follows
 * re-evaluations.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import type { Feature } from '../../renderer/src/foundation/document/document.js';
import { findCommand, resolveAdaptive } from '../../renderer/src/foundation/commands/registry.js';
import { useAssemblerStore } from '../../renderer/src/foundation/commands/store.js';
import { addRectangle } from '../../renderer/src/foundation/sketch-solver/builders.js';
import type { SketchFeature } from '../../renderer/src/foundation/sketch-solver/sketchFeature.js';
import { setSketchSolverFactory } from '../../renderer/src/foundation/sketch-solver/solverProvider.js';
import { EMPTY_SKETCH } from '../../renderer/src/foundation/sketch-solver/types.js';
import { draftPickOf } from '../../renderer/src/foundation/commands/draftTools.js';
import { useSketchStore } from '../../renderer/src/modules/sketching/session.js';
import { createNodeKernelAdapter } from '../kernel/nodeKernel.js';
import { loadNodeSolver } from '../sketch/nodeSolver.js';

const store = useAssemblerStore;
store.getState().attachKernel(createNodeKernelAdapter());
setSketchSolverFactory(() => ({
  solve: async (request) => (await loadNodeSolver()).solve(request),
}));

const SKETCH = 'feature-sketch-1';

function rect(): SketchFeature {
  return {
    id: SKETCH,
    name: 'Sketch 1',
    suppressed: false,
    kind: 'sketch',
    plane: { kind: 'plane', plane: 'XY', offset: 0 },
    ...addRectangle(EMPTY_SKETCH, [0, 0], [20, 10], { position: true, size: true }).sketch,
  };
}

async function load(features: Feature[]): Promise<void> {
  store.getState().loadDocument(features);
  await store.getState().whenSettled();
}

function sketchOf(): SketchFeature {
  return store.getState().features.find((f) => f.id === SKETCH) as SketchFeature;
}

/** Waits until the document is evaluated after an asynchronous edit. */
async function settle(): Promise<void> {
  for (let i = 0; i < 50; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10));
    await store.getState().whenSettled();
  }
}

void test('a selected sketch curve suggests Edit Sketch, which opens the sketch with the curve selected', async () => {
  await load([rect()]);
  const evaluated = store.getState().evaluation.sketches.find((s) => s.featureId === SKETCH);
  assert.ok(
    evaluated?.curves?.some((c) => c.entityId === 'l1'),
    'curves carry entity ids',
  );
  store.getState().select({ kind: 'sketchCurve', featureId: SKETCH, entityId: 'l1' });
  const adaptive = resolveAdaptive(store.getState()).map((c) => c.id);
  assert.equal(adaptive[0], 'sketch.edit', `adaptive order ${adaptive.join(', ')}`);
  assert.ok(adaptive.includes('sketch.deleteCurves'));
  assert.ok(adaptive.includes('sketch.curvesConstruction'));
  findCommand('sketch.edit')!.run(store.getState());
  const session = useSketchStore.getState().session;
  assert.equal(session?.featureId, SKETCH);
  assert.deepEqual(session?.selection, ['l1']);
  useSketchStore.getState().discard();
  // A selected line is a sketch-line pick for tools (revolve axis, construction axes).
  assert.deepEqual(draftPickOf({ kind: 'sketchCurve', featureId: SKETCH, entityId: 'l1' }), {
    kind: 'sketchLine',
    featureId: SKETCH,
    entityId: 'l1',
  });
});

void test('Delete from Sketch and Toggle Construction are one undo step each; Del deletes curves', async () => {
  await load([rect()]);
  const lines = () => sketchOf().entities.filter((e) => e.kind === 'line').length;
  assert.equal(lines(), 4);
  store.getState().select({ kind: 'sketchCurve', featureId: SKETCH, entityId: 'l2' });
  findCommand('sketch.curvesConstruction')!.run(store.getState());
  await settle();
  assert.equal(sketchOf().entities.find((e) => e.id === 'l2')?.construction, true);
  // The selection survives the re-evaluation (the curve still exists).
  assert.deepEqual(store.getState().selection, [
    { kind: 'sketchCurve', featureId: SKETCH, entityId: 'l2' },
  ]);
  findCommand('sketch.deleteCurves')!.run(store.getState());
  await settle();
  assert.equal(lines(), 3);
  assert.deepEqual(store.getState().selection, [], 'the deleted curve left the selection');
  store.getState().undo();
  await settle();
  assert.equal(lines(), 4, 'one undo step brings it back');
  // Del (transform.delete) on sketch curves deletes them from the sketch.
  store.getState().setSelection([
    { kind: 'sketchCurve', featureId: SKETCH, entityId: 'l1' },
    { kind: 'sketchCurve', featureId: SKETCH, entityId: 'l3' },
  ]);
  findCommand('transform.delete')!.run(store.getState());
  await settle();
  assert.equal(lines(), 2);
  assert.ok(
    store.getState().features.some((f) => f.id === SKETCH),
    'the sketch itself stays',
  );
});
