/**
 * The Block 9 parity tools on the store with the real OCCT kernel
 * (GAP-INVENTORY UI-04/MOD-23 Replace Face): the adaptive suggestion for two
 * faces of two bodies, the input steps with Next, the tool-before-selection
 * pick plan, preview, commit as one undo step, cancel.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { findCommand, resolveAdaptive } from '../../renderer/src/foundation/commands/registry.js';
import type { Feature } from '../../renderer/src/foundation/document/document.js';
import {
  acceptPick,
  draftSteps,
  type FeatureDraft,
} from '../../renderer/src/foundation/commands/featureDrafts.js';
import {
  useAssemblerStore,
  type ToolSession,
} from '../../renderer/src/foundation/commands/store.js';
import { PICK_PLANS } from '../../renderer/src/foundation/commands/pickSession.js';
import {
  buildItemTree,
  EMPTY_ITEMS_META,
  useItemsStore,
  withoutAbsentStepFolders,
} from '../../renderer/src/foundation/commands/items.js';
import { installStepFolderSync } from '../../renderer/src/foundation/commands/stepFolders.js';
import { IMAGE_CLICK, imageAtRay } from '../../renderer/src/modules/canvas/viewportImages.js';
import { createNodeKernelAdapter } from '../kernel/nodeKernel.js';

const store = useAssemblerStore;
store.getState().attachKernel(createNodeKernelAdapter());

const base = (id: string) => ({ id, name: id, suppressed: false });

function cube(id: string, center: [number, number, number], size: number, height = size): Feature {
  return {
    ...base(id),
    kind: 'primitive',
    shape: 'box',
    plane: { kind: 'plane', plane: 'XY', offset: 0 },
    center,
    width: size,
    depth: size,
    height,
    operation: 'new',
  } as Feature;
}

async function load(features: Feature[]) {
  store.getState().loadDocument(features);
  await store.getState().whenSettled();
  assert.deepEqual(store.getState().evaluation.errors, {});
}

function tool<K extends ToolSession['kind']>(kind: K): Extract<ToolSession, { kind: K }> {
  const active = store.getState().activeTool;
  assert.equal(active?.kind, kind);
  return active as Extract<ToolSession, { kind: K }>;
}

function draft<K extends FeatureDraft['kind']>(kind: K): Extract<FeatureDraft, { kind: K }> {
  const d = tool('feature').draft;
  assert.equal(d.kind, kind);
  return d as Extract<FeatureDraft, { kind: K }>;
}

const body = (id: string) => store.getState().evaluation.bodies.find((b) => b.id === id)!;

/** The top face (outward +Z, highest) of a body as a selection item. */
function top(bodyId: string) {
  const face = body(bodyId)
    .faces.filter((f) => f.normal && f.normal[2] > 0.99)
    .sort((a, b) => b.centroid[2] - a.centroid[2])[0]!;
  return { kind: 'face' as const, bodyId, faceKey: face.key };
}

void test('Replace Face: suggested for two faces of two bodies, Next steps, one undo step', async () => {
  await load([cube('a', [0, 0, 0], 10), cube('b', [20, 0, 0], 10, 16)]);
  const low = top('body:a');
  const high = top('body:b');
  store.getState().setSelection([low, high]);
  const adaptive = resolveAdaptive(store.getState()).map((c) => c.id);
  assert.ok(adaptive.includes('tools.replaceFace'), `adaptive: ${adaptive.join(', ')}`);
  assert.ok(
    adaptive.indexOf('transform.align') < adaptive.indexOf('tools.replaceFace'),
    'Align first, then Replace Face',
  );
  findCommand('tools.replaceFace')!.run(store.getState());
  const d = draft('replaceFace');
  assert.equal(d.faces.length, 1);
  assert.equal(d.target?.bodyId, 'body:b', 'the last selected face replaces');
  const steps = draftSteps(d)!;
  assert.deepEqual(steps.labels, ['Faces to replace', 'Replacing face']);
  assert.equal(steps.current, 1);
  await store.getState().whenSettled();
  const preview = tool('feature').previewEvaluation!;
  const previewed = preview.bodies.find((b) => b.id === 'body:a')!;
  assert.ok(Math.abs(previewed.max[2] - 16) < 1e-6, 'previewed at the replacing plane');
  // Back to the first step: a click on b's face does not join the faces to replace (other body).
  const back = steps.go(d, 0);
  const unchanged = acceptPick(
    back,
    { kind: 'face', bodyId: 'body:b', faceKey: high.faceKey },
    store.getState().evaluation,
  );
  assert.equal(unchanged, back);
  const before = store.getState().features.length;
  store.getState().commit();
  await store.getState().whenSettled();
  assert.equal(store.getState().activeTool, null);
  assert.deepEqual(store.getState().evaluation.errors, {});
  const added = store.getState().features.at(-1)!;
  assert.equal(added.kind, 'replaceFace');
  assert.equal(added.name, 'Replace Face 1');
  assert.ok(Math.abs(body('body:a').volume - 1600) < 1e-3, 'extended to the taller box');
  store.getState().undo();
  await store.getState().whenSettled();
  assert.equal(store.getState().features.length, before, 'one undo step');
  assert.ok(Math.abs(body('body:a').volume - 1000) < 1e-3);
});

void test('Replace Face: tool before selection asks for the faces, then the replacing face', async () => {
  await load([cube('a', [0, 0, 0], 10), cube('b', [20, 0, 0], 10, 16)]);
  store.getState().clearSelection();
  const plan = PICK_PLANS['tools.replaceFace'];
  assert.ok(plan, 'pick plan registered');
  assert.deepEqual(
    plan.steps.map((s) => s.role),
    ['Faces to replace', 'Replacing face'],
  );
  const command = findCommand('tools.replaceFace')!;
  assert.equal(command.availability(store.getState()).enabled, true, 'starts as a pick session');
  command.run(store.getState());
  assert.equal(tool('pick').commandId, 'tools.replaceFace');
  store.getState().cancel();
  assert.equal(store.getState().activeTool, null, 'cancelled');
  // A curved face cannot be replaced: the command explains why.
  await load([
    {
      ...cube('c', [0, 0, 0], 10),
      shape: 'cylinder',
      radius: 5,
    } as Feature,
    cube('b', [20, 0, 0], 10, 16),
  ]);
  const wall = body('body:c').faces.find((f) => f.surface === 'cylinder')!;
  store
    .getState()
    .setSelection([{ kind: 'face', bodyId: 'body:c', faceKey: wall.key }, top('body:b')]);
  const availability = command.availability(store.getState());
  assert.equal(availability.enabled, false);
  assert.match(availability.reason ?? '', /Only planar faces/);
});

// ---- Pattern copies in an Items folder (MOD-20) -----------------------------------------------

void test('Pattern: a new step files its instances into an Items folder; undo hides it', async () => {
  installStepFolderSync(store);
  useItemsStore.getState().setItemsMeta(EMPTY_ITEMS_META);
  await load([cube('a', [0, 0, 0], 4)]);
  const pattern = {
    ...base('p'),
    name: 'Pattern 1',
    kind: 'pattern',
    bodyIds: ['body:a'],
    pattern: { kind: 'linear', direction: { kind: 'world', axis: 'X' }, count: 3, spacing: 10 },
  } as Feature;
  store.getState().addFeature(pattern);
  await store.getState().whenSettled();
  const items = useItemsStore.getState();
  assert.equal(items.folders.length, 1);
  const folder = items.folders[0]!;
  assert.equal(folder.name, 'Pattern 1');
  assert.equal(folder.featureId, 'p');
  const filed = Object.entries(items.parent)
    .filter(([, f]) => f === folder.id)
    .map(([key]) => key)
    .sort();
  assert.equal(filed.length, 3, `original and two copies: ${filed.join(', ')}`);
  assert.ok(filed.includes('body:body:a'));
  const rows = store
    .getState()
    .evaluation.bodies.map((b) => ({ key: `body:${b.id}`, kind: 'body' as const }));
  const live = () => new Set(store.getState().features.map((f) => f.id));
  assert.equal(buildItemTree(rows, useItemsStore.getState(), live())[0]?.type, 'folder');
  store.getState().undo();
  await store.getState().whenSettled();
  const afterUndo = buildItemTree(
    store.getState().evaluation.bodies.map((b) => ({ key: `body:${b.id}`, kind: 'body' as const })),
    useItemsStore.getState(),
    live(),
  );
  assert.deepEqual(
    afterUndo.map((n) => n.type),
    ['leaf'],
    'the folder is hidden; the original is back at the top level',
  );
  assert.deepEqual(
    withoutAbsentStepFolders(useItemsStore.getState(), live()).folders,
    [],
    'Save leaves the folder out',
  );
  store.getState().redo();
  await store.getState().whenSettled();
  assert.equal(useItemsStore.getState().folders.length, 1, 'no second folder on redo');
  assert.equal(
    buildItemTree(rows, useItemsStore.getState(), live())[0]?.type,
    'folder',
    'shown again',
  );
  // Opening a document with a pattern makes no folder.
  useItemsStore.getState().setItemsMeta(EMPTY_ITEMS_META);
  await load([cube('a', [0, 0, 0], 4), pattern]);
  assert.equal(useItemsStore.getState().folders.length, 0);
});

// ---- Align with edges and axes (MOD-22) -----------------------------------------------------

void test('Align: two round edges of two bodies suggest Align; the axes line up; planar faces stay face/target', async () => {
  const cylinder = (id: string, center: [number, number, number], radius: number, height: number) =>
    ({ ...cube(id, center, 1, height), shape: 'cylinder', radius }) as Feature;
  await load([cylinder('a', [30, 10, 0], 2, 10), cylinder('b', [0, 0, 0], 5, 20)]);
  const circleAt = (bodyId: string, end: 'min' | 'max') => {
    const z = body(bodyId)[end][2];
    const edge = body(bodyId).edges.find(
      (e) => e.curve === 'circle' && Math.abs(e.midpoint[2] - z) < 1e-6,
    )!;
    return { kind: 'edge' as const, bodyId, edgeKey: edge.key };
  };
  store.getState().setSelection([circleAt('body:a', 'min'), circleAt('body:b', 'max')]);
  const adaptive = resolveAdaptive(store.getState()).map((c) => c.id);
  assert.equal(adaptive[0], 'transform.align', `adaptive: ${adaptive.join(', ')}`);
  findCommand('transform.align')!.run(store.getState());
  const d = draft('align');
  assert.equal(d.from.kind, 'axis');
  assert.equal(d.to.kind, 'axis');
  assert.deepEqual(draftSteps(d)!.labels, ['Moving reference', 'Target']);
  store.getState().commit();
  await store.getState().whenSettled();
  assert.deepEqual(store.getState().evaluation.errors, {});
  const added = store.getState().features.at(-1)! as Feature & { from?: unknown; face?: unknown };
  assert.equal(added.kind, 'align');
  assert.ok(added.from && !added.face, 'edges are stored as from/to');
  const a = body('body:a');
  assert.ok(Math.abs((a.min[0] + a.max[0]) / 2) < 1e-6, 'coaxial (x)');
  assert.ok(Math.abs(a.min[2] - 20) < 1e-6, 'its bottom circle on the post top circle');
  // Two planar faces: the stored fields stay face/target.
  store.getState().setSelection([top('body:a'), top('body:b')]);
  findCommand('transform.align')!.run(store.getState());
  store.getState().commit();
  await store.getState().whenSettled();
  const planes = store.getState().features.at(-1)! as Feature & { from?: unknown; face?: unknown };
  assert.ok(planes.face && !planes.from, 'planar faces keep face/target');
});

// ---- Move/Rotate copy with Link off (MOD-16) ----------------------------------------------------

async function until(condition: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 400; i += 1) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.fail(`timed out waiting for ${what}`);
}

void test('Move/Rotate: an unlinked copy keeps its geometry when the original changes; one undo step', async () => {
  await load([cube('a', [0, 0, 0], 10)]);
  store.getState().beginMove('body:a');
  store.getState().setDelta(20, 0, 0);
  store.getState().setMoveCopy(true);
  store.getState().setMoveLinked(false);
  const before = store.getState().features.length;
  store.getState().commit();
  const pending = tool('move');
  assert.equal(pending.unlinking, true, 'the pill shows the copy being written');
  await until(() => store.getState().activeTool === null, 'the unlinked copy');
  await store.getState().whenSettled();
  assert.deepEqual(store.getState().evaluation.errors, {});
  const added = store.getState().features.at(-1)!;
  assert.equal(added.kind, 'importStep');
  assert.equal(added.name, 'Unlinked copy 1');
  assert.equal(store.getState().features.length, before + 1);
  const copy = body(`body:${added.id}`);
  assert.ok(Math.abs(copy.volume - 1000) < 1e-3);
  assert.ok(Math.abs(copy.min[0] - 15) < 1e-6, `moved by 20 (min x ${copy.min[0]})`);
  // The original grows; the unlinked copy does not follow.
  store.getState().editFeatureParams('a', { width: 14 } as never);
  await store.getState().whenSettled();
  assert.ok(Math.abs(body('body:a').volume - 1400) < 1e-3, 'the original changed');
  assert.ok(Math.abs(body(`body:${added.id}`).volume - 1000) < 1e-3, 'the copy kept its geometry');
  // A linked copy follows (the default).
  store.getState().undo();
  store.getState().undo();
  await store.getState().whenSettled();
  assert.equal(store.getState().features.length, before, 'one undo step for the copy');
  // Cancel while writing: nothing is added.
  store.getState().beginMove('body:a');
  store.getState().setDelta(0, 20, 0);
  store.getState().setMoveCopy(true);
  store.getState().setMoveLinked(false);
  store.getState().commit();
  store.getState().cancel();
  await new Promise((resolve) => setTimeout(resolve, 500));
  await store.getState().whenSettled();
  assert.equal(store.getState().features.length, before, 'a cancelled unlinked copy adds nothing');
});

// ---- Split Body with several bodies (MOD-12) ------------------------------------------------------

void test('Split Body: two selected bodies are split in one step; a double-clicked body joins', async () => {
  // In a row along Y: the default plane (YZ through the first body's centre) cuts them all.
  await load([cube('a', [0, 0, 0], 10), cube('b', [0, 20, 0], 10), cube('c', [0, 40, 0], 10)]);
  store.getState().setSelection([
    { kind: 'body', bodyId: 'body:a' },
    { kind: 'body', bodyId: 'body:b' },
  ]);
  findCommand('tools.split')!.run(store.getState());
  const d = draft('split');
  assert.deepEqual(d.bodyIds, ['body:b']);
  store
    .getState()
    .updateFeatureDraft((current, evaluation) =>
      acceptPick(current, { kind: 'body', bodyId: 'body:c' }, evaluation),
    );
  assert.deepEqual(draft('split').bodyIds, ['body:b', 'body:c']);
  store.getState().commit();
  await store.getState().whenSettled();
  assert.deepEqual(store.getState().evaluation.errors, {});
  assert.equal(store.getState().evaluation.bodies.length, 6, 'a, b and c split');
  store.getState().undo();
  await store.getState().whenSettled();
  assert.equal(store.getState().evaluation.bodies.length, 3, 'one undo step');
});

// ---- Reference images pickable in the viewport (HIS-15) -------------------------------------------

void test('Reference images: a click on the picture selects it unless a body lies in front', async () => {
  const image = {
    ...base('img'),
    kind: 'referenceImage',
    imageId: 'pic-1',
    fileName: 'plan.png',
    pixelWidth: 200,
    pixelHeight: 100,
    plane: { kind: 'plane', plane: 'XY', offset: 0 },
    center: [0, 0],
    width: 100,
    rotation: 0,
    opacity: 0.6,
  } as unknown as Feature;
  await load([image, cube('a', [30, 0, 0], 10)]);
  const down = (x: number, y: number) => ({
    origin: [x, y, 100] as [number, number, number],
    direction: [0, 0, -1] as [number, number, number],
  });
  assert.equal(imageAtRay(store.getState(), down(0, 0))?.featureId, 'img');
  assert.equal(imageAtRay(store.getState(), down(0, 40)), null, 'outside the picture (height 50)');
  const click = (x: number, y: number, pick: unknown, surface: [number, number, number] | null) =>
    IMAGE_CLICK.click({
      state: store.getState(),
      pick: pick as never,
      item: null,
      isDouble: false,
      touch: false,
      hostPoint: [0, 0],
      project: () => null,
      visibleBodies: () => store.getState().evaluation.bodies,
      surfacePoint: () => surface,
      ray: () => down(x, y),
    });
  store.getState().clearSelection();
  assert.equal(click(0, 0, null, null), true);
  assert.deepEqual(store.getState().selection, [{ kind: 'feature', featureId: 'img' }]);
  // Over the cube (its top at z = 10, in front of the picture at z = 0) the body keeps the click.
  store.getState().clearSelection();
  assert.equal(click(30, 0, { kind: 'face', bodyId: 'body:a', faceKey: 'x' }, [30, 0, 10]), false);
  assert.deepEqual(store.getState().selection, []);
});

// ---- History multi-select (SEL-11) -----------------------------------------------------------------

void test('History: several selected steps are suppressed or deleted as one undo step', async () => {
  await load([cube('a', [0, 0, 0], 4), cube('b', [10, 0, 0], 4), cube('c', [20, 0, 0], 4)]);
  store.getState().setSuppressed(['a', 'b'], true);
  await store.getState().whenSettled();
  assert.deepEqual(
    store.getState().features.map((f) => f.suppressed),
    [true, true, false],
  );
  assert.equal(store.getState().evaluation.bodies.length, 1);
  store.getState().undo();
  await store.getState().whenSettled();
  assert.equal(store.getState().evaluation.bodies.length, 3, 'one undo step');
  store.getState().deleteFeature(['b', 'c']);
  await store.getState().whenSettled();
  assert.deepEqual(
    store.getState().features.map((f) => f.id),
    ['a'],
  );
  store.getState().undo();
  await store.getState().whenSettled();
  assert.equal(store.getState().features.length, 3, 'one undo step');
});
