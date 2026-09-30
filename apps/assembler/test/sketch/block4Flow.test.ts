/**
 * The Block-4 demo flow through the app's stores (real solver and kernel):
 * L-profile sketch → leave the sketch with Escape → E → distance → Done,
 * then a second sketch, a History rollback with a distance edit, roll
 * forward and a body colour. The recording (2026-09-30) ended without the
 * Extrude: its single Escape only cleared the sketch selection (layered
 * Escape), so E was disabled while the sketch was still open and the typed
 * "12" + Enter finished the sketch. These checks pin that behaviour and
 * that no later step (rollback, parameter edit, colour) drops a feature.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { withBodyColour } from '../../renderer/src/model/appearance.js';
import {
  resolveShortcut,
  type KeyEvent,
} from '../../renderer/src/foundation/commands/shortcuts.js';
import type { ExtrudeFeature } from '../../renderer/src/foundation/document/document.js';
import { useAssemblerStore } from '../../renderer/src/foundation/commands/store.js';
import { hitTest, infer } from '../../renderer/src/sketch/inference.js';
import { useSketchStore } from '../../renderer/src/sketch/session.js';
import { setSketchSolverFactory } from '../../renderer/src/foundation/sketch-solver/solverProvider.js';
import { segmentStart } from '../../renderer/src/sketch/tools.js';
import type { Vec2 } from '../../renderer/src/foundation/sketch-solver/types.js';
import { createNodeKernelAdapter } from '../kernel/nodeKernel.js';
import { loadNodeSolver } from './nodeSolver.js';

const store = useAssemblerStore;
const sketch = useSketchStore;
store.getState().attachKernel(createNodeKernelAdapter());
setSketchSolverFactory(() => ({
  solve: async (request) => (await loadNodeSolver()).solve(request),
}));

const MM_PER_PX = 0.1;

async function click(raw: Vec2): Promise<void> {
  const s = sketch.getState().session!;
  const from = segmentStart(s.sketch, s.tool);
  const snap = infer(s.sketch, raw, {
    mmPerPx: MM_PER_PX,
    ...(from ? { from } : {}),
    gridStep: null,
  });
  await sketch
    .getState()
    .dispatch({ type: 'click', snap, hit: hitTest(s.sketch, raw, MM_PER_PX), raw });
}

const key = (k: string): KeyEvent => ({
  key: k,
  ctrlKey: false,
  metaKey: false,
  shiftKey: false,
  altKey: false,
  targetIsTextInput: false,
});

/** What the global keyboard does for a plain key (scope from the sketch session). */
function press(k: string): { id: string | null; ran: boolean; reason?: string | undefined } {
  const state = store.getState();
  const command = resolveShortcut(key(k), state, sketch.getState().session ? 'sketch' : 'model');
  if (!command) return { id: null, ran: false };
  const availability = command.availability(state);
  if (!availability.enabled) return { id: command.id, ran: false, reason: availability.reason };
  command.run(state);
  return { id: command.id, ran: true };
}

async function settle(): Promise<void> {
  await sketch.getState().whenIdle();
  await store.getState().whenSettled();
}

void test('Block-4 flow: Escape layering, E after the sketch, rollback edit and colour keep the Extrude', async () => {
  store.getState().loadDocument([]);
  await settle();

  // 1) L-profile with the line tool.
  assert.ok(sketch.getState().begin({ plane: 'XY', tool: 'line' }));
  for (const p of [
    [0, 0],
    [60, 0],
    [60, 15],
    [20, 15],
    [20, 40],
    [0, 40],
    [0, 0],
  ] as Vec2[]) {
    await click(p);
  }
  await settle();
  // Back to Select with the bottom line selected (the dimension tool leaves such a selection).
  assert.equal(sketch.getState().escape(), true);
  const bottom = sketch
    .getState()
    .session!.sketch.entities.find(
      (e) =>
        e.kind === 'line' &&
        hitTest(sketch.getState().session!.sketch, [30, 0], MM_PER_PX)?.id === e.id,
    );
  assert.ok(bottom, 'bottom line');
  sketch.getState().select([bottom.id]);
  assert.ok(sketch.getState().session!.selection.length > 0, 'a sketch item is selected');

  // One Escape only clears the selection: the sketch stays open.
  assert.equal(sketch.getState().escape(), true);
  await settle();
  assert.ok(sketch.getState().session, 'first Escape clears the selection, the sketch stays open');
  assert.equal(store.getState().features.length, 0);
  // E now is Extrude but disabled (no profile selected in the model yet) — the recording's step 2.
  const early = press('e');
  assert.equal(early.id, 'tools.extrude');
  assert.equal(early.ran, false);
  assert.match(early.reason ?? '', /Select a sketch profile/);

  // The second Escape leaves the sketch; its profile is selected.
  assert.equal(sketch.getState().escape(), true);
  await settle();
  assert.equal(sketch.getState().session, null);
  assert.deepEqual(
    store.getState().features.map((f) => f.name),
    ['Sketch 1'],
  );
  assert.equal(store.getState().selection[0]?.kind, 'sketchProfile');

  // 2) E starts Extrude; the typed distance applies, Done (Enter) commits.
  assert.deepEqual(press('e'), { id: 'tools.extrude', ran: true });
  assert.equal(store.getState().activeTool?.kind, 'extrude');
  store.getState().setDistance(12);
  await settle();
  store.getState().commit();
  await settle();
  assert.deepEqual(
    store.getState().features.map((f) => f.name),
    ['Sketch 1', 'Extrude 1'],
  );
  assert.equal(store.getState().evaluation.bodies.length, 1);

  // 3) A second sketch (rectangle on XZ), extruded as a second step to roll back over.
  assert.ok(sketch.getState().begin({ plane: 'XZ', tool: 'rectangle' }));
  await click([10, 20]);
  await click([25, 35]);
  await sketch.getState().finish();
  await settle();
  assert.deepEqual(press('e'), { id: 'tools.extrude', ran: true });
  store.getState().setDistance(5);
  await settle();
  store.getState().commit();
  await settle();
  const names = store.getState().features.map((f) => f.name);
  assert.deepEqual(names, ['Sketch 1', 'Extrude 1', 'Sketch 2', 'Extrude 2']);

  // 5) Roll back above the last step, edit the first Extrude's distance, roll forward.
  const features = store.getState().features;
  store.getState().setRollback(features[3]!.id);
  await settle();
  store.getState().editFeatureParams(features[1]!.id, { distance: 16 });
  await settle();
  store.getState().setRollback(null);
  await settle();
  const extrude = store.getState().features.find((f) => f.id === features[1]!.id) as ExtrudeFeature;
  assert.ok(extrude, 'Extrude 1 survives the rollback edit');
  assert.equal(extrude.distance, 16);

  // 6) Colour the first body (as the Colour dialog does).
  const s = store.getState();
  const body = s.evaluation.bodies[0]!;
  const next = withBodyColour(s.features, s.features.length, [body.id], '#2A9D8F', () => ({
    id: s.allocateFeatureId('appearance', new Set()),
    name: 'Appearance 1',
  }));
  s.commitDocumentChange(next, { keepRollback: true, selection: s.selection });
  await settle();
  assert.deepEqual(
    store.getState().features.map((f) => f.name),
    ['Sketch 1', 'Extrude 1', 'Sketch 2', 'Extrude 2', 'Appearance 1'],
  );
  assert.deepEqual(store.getState().evaluation.errors, {});
});
