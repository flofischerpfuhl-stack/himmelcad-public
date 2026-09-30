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

import type { Feature, ShellFeature } from '../../renderer/src/foundation/document/document.js';
import type { SketchFeature } from '../../renderer/src/foundation/sketch-solver/sketchFeature.js';
import {
  makeEdgeRef,
  makeFaceRef,
  useAssemblerStore,
} from '../../renderer/src/foundation/commands/store.js';
import { addRectangle } from '../../renderer/src/foundation/sketch-solver/builders.js';
import { setSketchDimension } from '../../renderer/src/sketch/featureOps.js';
import { rememberRegions } from '../../renderer/src/foundation/sketch-solver/regionMemory.js';
import { setSketchSolverFactory } from '../../renderer/src/foundation/sketch-solver/solverProvider.js';
import { EMPTY_SKETCH } from '../../renderer/src/foundation/sketch-solver/types.js';
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

void test('a value that makes a feature fail in the kernel is refused with the reason (like the API)', async () => {
  const { wallId } = await plateWithWallParameter();
  // A round of radius `wall` along a top edge of the 10 mm tall plate.
  const edge = body().edges.find(
    (e) => e.curve === 'line' && Math.abs(e.direction?.[0] ?? 0) > 0.99 && e.midpoint[2] > 9.99,
  )!;
  store.getState().addFeature({
    id: 'f1',
    name: 'Fillet 1',
    suppressed: false,
    kind: 'fillet',
    edges: [makeEdgeRef(store.getState().evaluation, 'body:e1', edge.key)!],
    radius: 3,
    radiusExpression: 'wall',
  });
  await settled();
  assert.deepEqual(store.getState().evaluation.errors, {});
  const before = store.getState();
  // wall = 12: the sketch solves (120 mm wide), a 12 mm round on a 10 mm tall plate cannot.
  const outcome = await store.getState().editParameter({ id: wallId, value: 12 });
  assert.equal(outcome.ok, false, 'refused');
  assert.match(
    !outcome.ok ? outcome.message : '',
    /^Fillet 1 would fail: .*Nothing was changed\.$/,
  );
  const after = await settled();
  assert.strictEqual(after.features, before.features, 'features unchanged');
  assert.strictEqual(after.parameters, before.parameters, 'parameters unchanged');
  assert.deepEqual(after.evaluation.errors, {});
});

void test('hole diameter, fillet end radius and chamfer second distance take parameter names', async () => {
  await plateWithWallParameter();
  const hd = await store.getState().upsertParameter({ name: 'hole_d', unit: 'mm', value: 5 });
  assert.ok(hd.ok);
  const s = store.getState();
  const top = body().faces.find((f) => f.normal?.[2] === 1)!;
  const hole: Feature = {
    id: 'h1',
    name: 'Hole 1',
    suppressed: false,
    kind: 'hole',
    face: makeFaceRef(s.evaluation, 'body:e1', top.key)!,
    placements: [{ kind: 'point', u: 15, v: 15 }],
    holeType: 'simple',
    diameter: 1,
    extent: { kind: 'through' },
  };
  s.addFeature(hole);
  await settled();
  // The History card's field commits the formula; the store resolves it immediately.
  store.getState().editFeatureParams('h1', { diameterExpression: 'hole_d' } as never);
  await settled();
  const volume = (d: number) => 30 * 30 * 10 - Math.PI * (d / 2) ** 2 * 10;
  assert.ok(Math.abs(body().volume - volume(5)) < 1e-3, `Ø5 hole (${body().volume})`);
  const outcome = await store.getState().editParameter({ id: 'hole_d', value: 8 });
  assert.ok(outcome.ok, outcome.ok ? '' : outcome.message);
  assert.deepEqual(outcome.ok && outcome.changedFeatureIds, ['h1']);
  await settled();
  assert.ok(Math.abs(body().volume - volume(8)) < 1e-3, `Ø8 hole (${body().volume})`);

  // Deleting the parameter is refused while the hole reads it.
  const refused = await store.getState().deleteParameter(hd.ok ? hd.id : '');
  assert.equal(refused.ok, false);
  assert.deepEqual(!refused.ok && refused.usages?.map((u) => `${u.featureId}.${u.field}`), [
    'h1.diameterExpression',
  ]);

  // Fillet `radius2` and chamfer `distance2` resolve through the same path.
  const edgeKey = body().edges.find(
    (e) => e.curve === 'line' && Math.abs(e.direction?.[2] ?? 0) > 0.99,
  )!.key;
  store.getState().addFeature({
    id: 'f1',
    name: 'Fillet 1',
    suppressed: false,
    kind: 'fillet',
    edges: [makeEdgeRef(store.getState().evaluation, 'body:e1', edgeKey)!],
    radius: 1,
    radius2: 1,
  });
  await settled();
  store.getState().editFeatureParams('f1', { radius2Expression: 'hole_d / 4' } as never);
  await settled();
  const fillet = () =>
    store.getState().features.find((f) => f.id === 'f1') as Feature & {
      radius2: number;
    };
  assert.equal(fillet().radius2, 2);
  assert.ok((await store.getState().editParameter({ id: 'hole_d', value: 10 })).ok);
  await settled();
  assert.equal(fillet().radius2, 2.5);
  assert.deepEqual(store.getState().evaluation.errors, {});
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
