/**
 * Home screen templates through the project store (real kernel and
 * solver): a template becomes a clean, editable baseline (history built by
 * the agent API, undo cleared, not dirty, Home closed); with unsaved work
 * the same "Unsaved changes" pending action as New/Open is asked first.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { useProjectStore } from '../../../renderer/src/model/project/projectStore.js';
import { useAssemblerStore } from '../../../renderer/src/foundation/commands/store.js';
import { useWorkspaceStore } from '../../../renderer/src/model/workspace.js';
import { PROJECT_TEMPLATES } from '../../../renderer/src/templates/projectTemplates.js';
import { setSketchSolverFactory } from '../../../renderer/src/foundation/sketch-solver/solverProvider.js';
import { createNodeKernelAdapter } from '../../kernel/nodeKernel.js';
import { loadNodeSolver } from '../../sketch/nodeSolver.js';

const kernel = createNodeKernelAdapter();
useAssemblerStore.getState().attachKernel(kernel);
useProjectStore.getState().attachKernelAdapter(kernel);
setSketchSolverFactory(() => ({
  solve: async (request) => (await loadNodeSolver()).solve(request),
}));

void test('every template id is unique and Blank comes first', () => {
  assert.equal(PROJECT_TEMPLATES[0]!.id, 'blank');
  assert.equal(new Set(PROJECT_TEMPLATES.map((t) => t.id)).size, PROJECT_TEMPLATES.length);
});

void test('a template becomes a clean baseline: editable history, no undo, not dirty, Home closed', async () => {
  useWorkspaceStore.getState().setHomeOpen(true);
  assert.equal(await useProjectStore.getState().newFromTemplate('bracket'), true);
  const doc = useAssemblerStore.getState();
  await doc.whenSettled();
  const state = useAssemblerStore.getState();
  assert.equal(state.projectName, 'Bracket');
  assert.deepEqual(
    state.features.map((f) => f.kind),
    ['sketch', 'extrude', 'sketch', 'extrude', 'fillet', 'sketch', 'extrude', 'hole', 'fillet'],
  );
  assert.deepEqual(state.evaluation.errors, {});
  assert.equal(state.evaluation.bodies.length, 1);
  assert.equal(state.history.canUndo, false, 'the template is the starting point');
  assert.equal(useProjectStore.getState().dirty, false);
  assert.equal(useProjectStore.getState().filePath, null);
  assert.equal(useWorkspaceStore.getState().homeOpen, false);
});

void test('with unsaved work a template asks first; Discard builds it, Cancel keeps the document', async () => {
  // An edit makes the project dirty.
  useAssemblerStore.getState().renameFeature(useAssemblerStore.getState().features[0]!.id, 'Base');
  assert.equal(useProjectStore.getState().dirty, true);
  useProjectStore.getState().requestTemplate('cableClip');
  assert.equal(useProjectStore.getState().pendingAction, 'template');
  useProjectStore.getState().cancelPending();
  assert.equal(useAssemblerStore.getState().projectName, 'Bracket');

  useProjectStore.getState().requestTemplate('cableClip');
  useProjectStore.getState().confirmDiscard();
  // The build runs asynchronously; wait for the project to switch and settle.
  for (let i = 0; i < 400 && useAssemblerStore.getState().projectName !== 'Cable clip'; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  for (let i = 0; i < 400 && useProjectStore.getState().busyMessage !== null; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  await useAssemblerStore.getState().whenSettled();
  assert.equal(useAssemblerStore.getState().projectName, 'Cable clip');
  assert.equal(useAssemblerStore.getState().evaluation.bodies[0]?.name, 'Cable clip');
  assert.equal(useProjectStore.getState().dirty, false);
});
