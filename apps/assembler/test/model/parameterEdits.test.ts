/**
 * Parameter edits on the store (the Parameters panel path) with the real
 * OCCT kernel and the planeGCS solver: a changed parameter re-solves every
 * sketch whose dimensions read it (directly or through other parameters),
 * re-resolves feature `*Expression` fields (a shell's thickness), and all of
 * it is ONE undo step; a value a sketch cannot satisfy is refused with
 * nothing changed; a stale plan is never committed.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import type { Feature, ShellFeature, SketchFeature } from '../../renderer/src/model/document.js';
import { makeFaceRef, useAssemblerStore } from '../../renderer/src/model/store.js';
import { addRectangle } from '../../renderer/src/sketch/builders.js';
import { setSketchDimension } from '../../renderer/src/sketch/featureOps.js';
import { rememberRegions } from '../../renderer/src/sketch/regionMemory.js';
import { setSketchSolverFactory } from '../../renderer/src/sketch/solverProvider.js';
import { EMPTY_SKETCH } from '../../renderer/src/sketch/types.js';
import { createNodeKernelAdapter } from '../kernel/nodeKernel.js';
import { loadNodeSolver } from '../sketch/nodeSolver.js';

const store = useAssemblerStore;
store.getState().attachKernel(createNodeKernelAdapter());
setSketchSolverFactory(() => ({
  solve: async (request) => (await loadNodeSolver()).solve(request),
}));

async function settled() {
  await store.getState().whenSettled();
  return store.getState();
}

const sketchOf = (id: string) =>
  store.getState().features.find((f): f is SketchFeature => f.id === id && f.kind === 'sketch')!;
const body = () => store.getState().evaluation.bodies.find((b) => b.id === 'body:e1')!;
const size = () => {
  const b = body();
  return [0, 1, 2].map((i) => Math.round((b.max[i]! - b.min[i]!) * 1e6) / 1e6);
};
/** Open-top shell of a W x 30 x 10 box with walls t. */
const shellVolume = (w: number, t: number) => w * 30 * 10 - (w - 2 * t) * (30 - 2 * t) * (10 - t);

/** A dimensioned 40 x 30 rectangle, extruded 10; returns the width dimension id. */
async function plateWithWallParameter(): Promise<{ widthDim: string; wallId: string }> {
  const sketch: SketchFeature = {
    id: 's1',
    name: 'Sketch 1',
    suppressed: false,
    kind: 'sketch',
    plane: { kind: 'plane', plane: 'XY', offset: 0 },
    ...rememberRegions(
      addRectangle(EMPTY_SKETCH, [0, 0], [40, 30], { position: true, size: true }).sketch,
    ),
  };
  const extrude: Feature = {
    id: 'e1',
    name: 'Extrude 1',
    suppressed: false,
    kind: 'extrude',
    profile: { kind: 'sketch', featureId: 's1' },
    distance: 10,
    symmetric: false,
    operation: 'new',
  };
  store.getState().loadDocument([sketch, extrude]);
  await settled();
  const created = await store.getState().upsertParameter({ name: 'wall', unit: 'mm', value: 3 });
  assert.ok(created.ok, 'wall created');
  const widthDim = sketchOf('s1').dimensions.find((d) => Math.abs(d.value - 40) < 1e-9)!.id;
  assert.equal(await setSketchDimension('s1', widthDim, 'wall * 10'), null);
  await settled();
  assert.deepEqual(size(), [30, 30, 10]);
  return { widthDim, wallId: created.id };
}

async function addShell(): Promise<void> {
  const s = store.getState();
  const top = body().faces.find((f) => f.normal?.[2] === 1)!;
  const face = makeFaceRef(s.evaluation, 'body:e1', top.key)!;
  const shell: ShellFeature = {
    id: 'sh1',
    name: 'Shell 1',
    suppressed: false,
    kind: 'shell',
    bodyId: 'body:e1',
    faces: [face],
    thickness: 3,
    thicknessExpression: 'wall',
  };
  s.addFeature(shell);
  await settled();
  assert.deepEqual(store.getState().evaluation.errors, {});
  assert.ok(Math.abs(body().volume - shellVolume(30, 3)) < 1e-3);
}

void test('changing a parameter re-solves the sketch that uses it and re-resolves the shell, in one undo step', async () => {
  const { widthDim, wallId } = await plateWithWallParameter();
  await addShell();
  const before = store.getState();
  const steps = before.features.length;

  const outcome = await store.getState().upsertParameter({
    id: wallId,
    name: 'wall',
    unit: 'mm',
    value: 5,
  });
  assert.ok(outcome.ok, outcome.ok ? '' : outcome.message);
  assert.deepEqual(outcome.ok && outcome.resolvedSketchIds, ['s1']);
  assert.deepEqual(outcome.ok && [...outcome.changedFeatureIds].sort(), ['s1', 'sh1']);
  const after = await settled();
  assert.equal(after.features.length, steps, 'no History step is added');
  assert.equal(sketchOf('s1').dimensions.find((d) => d.id === widthDim)!.value, 50);
  assert.deepEqual(size(), [50, 30, 10], 'the sketch was re-solved: the extrude follows');
  const shell = after.features.find((f) => f.id === 'sh1') as ShellFeature;
  assert.equal(shell.thickness, 5);
  assert.ok(Math.abs(body().volume - shellVolume(50, 5)) < 1e-3, 'shell walls follow');

  // One undo restores parameter, sketch and shell together; redo re-applies all.
  store.getState().undo();
  const undone = await settled();
  assert.equal(undone.parameters[0]!.value, 3);
  assert.equal(sketchOf('s1').dimensions.find((d) => d.id === widthDim)!.value, 30);
  assert.deepEqual(size(), [30, 30, 10]);
  assert.ok(Math.abs(body().volume - shellVolume(30, 3)) < 1e-3);
  assert.strictEqual(undone.features, before.features, 'exactly the state before the edit');
  store.getState().redo();
  await settled();
  assert.deepEqual(size(), [50, 30, 10]);
});

void test('a sketch that reads a parameter through another parameter is re-solved too', async () => {
  const { widthDim, wallId } = await plateWithWallParameter();
  const derived = await store
    .getState()
    .upsertParameter({ name: 'span', unit: 'mm', expression: 'wall * 12' });
  assert.ok(derived.ok);
  assert.equal(await setSketchDimension('s1', widthDim, 'span + 4'), null);
  await settled();
  assert.deepEqual(size(), [40, 30, 10]);
  const outcome = await store.getState().editParameter({ id: wallId, value: 2 });
  assert.ok(outcome.ok && outcome.resolvedSketchIds.includes('s1'));
  await settled();
  assert.equal(store.getState().parameters.find((p) => p.name === 'span')!.value, 24);
  assert.deepEqual(size(), [28, 30, 10]);
});

void test('a value a dependent sketch cannot satisfy refuses the whole edit (nothing changes)', async () => {
  const { wallId } = await plateWithWallParameter();
  await addShell();
  const before = store.getState();
  const outcome = await store.getState().editParameter({ id: wallId, value: 0 });
  assert.equal(outcome.ok, false);
  assert.ok(!outcome.ok && outcome.conflicts?.[0]?.featureId === 's1', 'the sketch is named');
  assert.match(!outcome.ok ? outcome.message : '', /Sketch 1: .*Nothing was changed/);
  const after = await settled();
  assert.strictEqual(after.features, before.features);
  assert.strictEqual(after.parameters, before.parameters);
  assert.equal(after.history.canUndo, before.history.canUndo);
  assert.deepEqual(size(), [30, 30, 10]);
});

void test('a plan made against an older document is not committed; editParameter re-plans', async () => {
  const { wallId } = await plateWithWallParameter();
  const plan = await store.getState().planParameterChange({ id: wallId, value: 4 });
  assert.ok(plan.ok);
  store.getState().renameFeature('e1', 'Plate');
  const stale = store.getState().applyParameterPlan(plan);
  assert.equal(stale.ok, false);
  assert.equal(store.getState().parameters[0]!.value, 3);
  const edited = await store.getState().editParameter({ id: wallId, value: 4 });
  assert.ok(edited.ok);
  await settled();
  assert.deepEqual(size(), [40, 30, 10]);
  assert.equal(store.getState().features.find((f) => f.id === 'e1')!.name, 'Plate');
});

void test('rename + value in one edit is one undo step; rolled-back sketches are re-solved too', async () => {
  const { widthDim, wallId } = await plateWithWallParameter();
  await addShell();
  store.getState().setRollback('sh1');
  await settled();
  const outcome = await store.getState().editParameter({ id: wallId, name: 'side', value: 4 });
  assert.ok(outcome.ok);
  const after = await settled();
  assert.equal(after.rollbackBefore, 'sh1', 'the History rollback bar stays');
  assert.equal(sketchOf('s1').dimensions.find((d) => d.id === widthDim)!.expression, 'side * 10');
  assert.equal(
    (after.features.find((f) => f.id === 'sh1') as ShellFeature).thicknessExpression,
    'side',
  );
  assert.deepEqual(size(), [40, 30, 10]);
  store.getState().undo();
  const undone = await settled();
  assert.equal(undone.parameters[0]!.name, 'wall');
  assert.equal(undone.parameters[0]!.value, 3);
  assert.deepEqual(size(), [30, 30, 10]);
});
