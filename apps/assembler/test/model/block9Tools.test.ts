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
