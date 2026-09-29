import assert from 'node:assert/strict';
import test from 'node:test';

import type { SketchRectFeature } from '../../renderer/src/model/mockDocument.js';
import { useAssemblerStore } from '../../renderer/src/model/store.js';

const SKETCH: SketchRectFeature = {
  id: 'sketch-1',
  name: 'Sketch 1',
  suppressed: false,
  kind: 'sketchRect',
  plane: 'XY',
  offset: 0,
  x: 0,
  y: 0,
  width: 10,
  height: 10,
};

void test('extrude tool: setDistance previews without touching features; cancel restores exactly', () => {
  const store = useAssemblerStore;
  store.getState().loadDocument([SKETCH]);

  const before = store.getState().features;
  store.getState().beginExtrude({ kind: 'sketch', featureId: SKETCH.id });
  assert.equal(store.getState().activeTool?.kind, 'extrude');

  store.getState().setDistance(12);
  const tool = store.getState().activeTool;
  assert.equal(tool?.kind, 'extrude');
  if (tool?.kind === 'extrude') {
    assert.equal(tool.previewEvaluation.bodies.length, 1);
    assert.equal(tool.previewEvaluation.bodies[0]?.max[2], 12);
  }
  // The provisional feature must never appear in the committed document.
  assert.equal(store.getState().features, before);
  assert.equal(store.getState().features.length, 1);
  assert.equal(store.getState().history.canUndo, false);

  store.getState().cancel();
  assert.equal(store.getState().activeTool, null);
  assert.equal(store.getState().features, before);
  assert.equal(store.getState().history.canUndo, false);
});

void test('extrude tool: commit is exactly one undo step; undo/redo round-trip', () => {
  const store = useAssemblerStore;
  store.getState().loadDocument([SKETCH]);

  store.getState().beginExtrude({ kind: 'sketch', featureId: SKETCH.id });
  store.getState().setDistance(10);
  store.getState().commit();

  assert.equal(store.getState().activeTool, null);
  assert.equal(store.getState().features.length, 2);
  assert.equal(store.getState().evaluation.bodies.length, 1);
  assert.equal(store.getState().history.canUndo, true);
  assert.equal(store.getState().history.canRedo, false);

  store.getState().undo();
  assert.equal(store.getState().features.length, 1);
  assert.equal(store.getState().evaluation.bodies.length, 0);
  assert.equal(store.getState().history.canUndo, false);
  assert.equal(store.getState().history.canRedo, true);

  store.getState().redo();
  assert.equal(store.getState().features.length, 2);
  assert.equal(store.getState().evaluation.bodies.length, 1);
  assert.equal(store.getState().history.canUndo, true);
  assert.equal(store.getState().history.canRedo, false);
});

void test('selection is pruned after undo removes the selected body', () => {
  const store = useAssemblerStore;
  store.getState().loadDocument([SKETCH]);

  store.getState().beginExtrude({ kind: 'sketch', featureId: SKETCH.id });
  store.getState().setDistance(10);
  store.getState().commit();

  const bodyId = store.getState().evaluation.bodies[0]!.id;
  store.getState().select({ kind: 'body', bodyId });
  assert.equal(store.getState().selection.length, 1);

  store.getState().undo();
  assert.equal(store.getState().evaluation.bodies.length, 0);
  assert.equal(store.getState().selection.length, 0);
});

void test('sketchRectangle tool: commit adds exactly one feature and selects its profile; cancel adds nothing', () => {
  const store = useAssemblerStore;
  store.getState().loadDocument([]);

  store.getState().beginSketchRectangle();
  store.getState().setPreviewRect(1, 2, 30, 40);
  store.getState().commit();

  assert.equal(store.getState().features.length, 1);
  const feature = store.getState().features[0];
  assert.equal(feature?.kind, 'sketchRect');
  assert.equal(store.getState().selection.length, 1);
  assert.equal(store.getState().selection[0]?.kind, 'sketchProfile');

  store.getState().beginSketchRectangle();
  store.getState().setPreviewRect(0, 0, 5, 5);
  store.getState().cancel();
  assert.equal(store.getState().features.length, 1);
  assert.equal(store.getState().history.canRedo, false);
});
