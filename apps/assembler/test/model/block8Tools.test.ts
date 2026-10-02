/**
 * The Block 8 modelling tools on the store with the real OCCT kernel
 * (GAP-INVENTORY UI-02, MOD-03, MOD-05, MOD-16, MOD-18, MOD-19, UI-17):
 * the Add menu's primitives (placed on a face, Cut goes into it), the
 * extrude taper (pill value and drag handle), the helix of Revolve, Scale
 * (sizes and factor), Translate (steps with Next, snapped points), Move
 * Edge / Move Face from Move/Rotate, and the step badges of Rotate Around
 * Axis. Each commit is one undo step.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { COMMANDS, findCommand } from '../../renderer/src/foundation/commands/registry.js';
import type { Feature } from '../../renderer/src/foundation/document/document.js';
import {
  acceptPick,
  draftBadges,
  draftHandles,
  draftSteps,
  type FeatureDraft,
} from '../../renderer/src/foundation/commands/featureDrafts.js';
import {
  useAssemblerStore,
  type ToolSession,
} from '../../renderer/src/foundation/commands/store.js';
import { PICK_PLANS } from '../../renderer/src/foundation/commands/pickSession.js';
import {
  toolHandleSet,
  applyToolHandleValue,
} from '../../renderer/src/modules/modeling/toolHandles.js';
import { createNodeKernelAdapter } from '../kernel/nodeKernel.js';

const store = useAssemblerStore;
store.getState().attachKernel(createNodeKernelAdapter());

const base = (id: string) => ({ id, name: id, suppressed: false });

function cube(id: string, center: [number, number, number], size: number): Feature {
  return {
    ...base(id),
    kind: 'primitive',
    shape: 'box',
    plane: { kind: 'plane', plane: 'XY', offset: 0 },
    center,
    width: size,
    depth: size,
    height: size,
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

function run(id: string) {
  const command = findCommand(id);
  assert.ok(command, id);
  const availability = command.availability(store.getState());
  assert.equal(availability.enabled, true, `${id}: ${availability.reason ?? ''}`);
  command.run(store.getState());
}

async function commit() {
  store.getState().commit();
  await store.getState().whenSettled();
  assert.equal(store.getState().activeTool, null, 'the tool closed');
  assert.deepEqual(store.getState().evaluation.errors, {});
}

function badge(label: string) {
  const found = draftBadges(tool('feature').draft, store.getState().evaluation).find(
    (b) => b.ariaLabel === label,
  );
  assert.ok(found, `badge ${label}`);
  return found;
}

const body = (id: string) => store.getState().evaluation.bodies.find((b) => b.id === id)!;

void test('Add menu: five primitives in the Add group; Box on the grid is named "Box 1"', async () => {
  await load([]);
  const add = COMMANDS.filter((c) => c.group === 'add').map((c) => c.id);
  // The primitives (modeling, order 430) come before the canvas module's Image… (1550).
  assert.deepEqual(add, [
    'add.box',
    'add.cylinder',
    'add.sphere',
    'add.cone',
    'add.torus',
    'add.image',
  ]);
  run('add.box');
  const d = draft('primitive');
  assert.equal(d.shape, 'box');
  assert.equal(d.plane.kind, 'plane');
  await store.getState().whenSettled();
  assert.ok(tool('feature').previewEvaluation?.bodies.length === 1, 'previewed');
  await commit();
  const added = store.getState().features.at(-1)!;
  assert.equal(added.kind, 'primitive');
  assert.equal(added.name, 'Box 1');
  assert.equal(store.getState().evaluation.bodies.length, 1);
  store.getState().undo();
  await store.getState().whenSettled();
  assert.equal(store.getState().features.length, 0, 'one undo step');
});

void test('A primitive on a selected face joins it; Cut goes into the face as a pocket', async () => {
  await load([cube('a', [0, 0, 0], 20)]);
  const top = body('body:a').faces.find((f) => f.normal?.[2] === 1)!;
  store.getState().setSelection([{ kind: 'face', bodyId: 'body:a', faceKey: top.key }]);
  run('add.cylinder');
  let d = draft('primitive');
  assert.equal(d.plane.kind, 'face');
  assert.equal(d.operation, 'join');
  // Sized from the face: a quarter of the 20 mm side.
  assert.equal(d.sizes.radius, 5);
  store.getState().updateFeatureDraft((x, ev) => badge('Operation').apply(x, 'cut', ev));
  d = draft('primitive');
  assert.equal(d.operation, 'cut');
  assert.equal(d.flip, true, 'a cut on a face goes into it');
  const radius = draftHandles(d, store.getState().evaluation).find((h) => h.id === 'radius')!;
  store.getState().updateFeatureDraft((x) => radius.apply(x, 3));
  await commit();
  const volume = 8000 - Math.PI * 9 * 10;
  assert.ok(Math.abs(body('body:a').volume - volume) < 0.05, `pocket ${body('body:a').volume}`);
  assert.equal(store.getState().features.at(-1)!.name, 'Cylinder 1');
});

void test('Extrude taper: pill value, drag handle (whole degrees) and the committed step', async () => {
  const sketchId = 'feature-sketch-t';
  await load([
    {
      ...base(sketchId),
      kind: 'sketch',
      plane: { kind: 'plane', plane: 'XY', offset: 0 },
      entities: [
        { id: 'p1', kind: 'point', x: 0, y: 0 },
        { id: 'p2', kind: 'point', x: 20, y: 0 },
        { id: 'p3', kind: 'point', x: 20, y: 20 },
        { id: 'p4', kind: 'point', x: 0, y: 20 },
        { id: 'l1', kind: 'line', a: 'p1', b: 'p2' },
        { id: 'l2', kind: 'line', a: 'p2', b: 'p3' },
        { id: 'l3', kind: 'line', a: 'p3', b: 'p4' },
        { id: 'l4', kind: 'line', a: 'p4', b: 'p1' },
      ],
      constraints: [],
      dimensions: [],
    } as Feature,
  ]);
  store.getState().beginExtrude({ kind: 'sketch', featureId: sketchId });
  store.getState().setDistance(10);
  store.getState().setExtrudeOptions({ taper: 5 });
  const handles = toolHandleSet(store.getState());
  const arc = handles.angles.find((h) => h.handle === 'extrudeTaper');
  assert.ok(arc, 'the taper arc');
  assert.equal(arc.value, 5);
  // Block 9: the arc drags like a lever as long as the extrude, in whole degrees.
  assert.equal(arc.drag, 'lever');
  assert.equal(arc.lever, 10);
  assert.equal(arc.snapDeg, 1);
  applyToolHandleValue('extrudeTaper', 7.4, true);
  assert.equal(tool('extrude').taper, 7, 'drag snaps to whole degrees');
  await store.getState().whenSettled();
  await commit();
  const step = store.getState().features.at(-1)!;
  assert.ok(step.kind === 'extrude' && step.taper === 7);
  const t = Math.tan((7 * Math.PI) / 180);
  const top = 20 - 2 * 10 * t;
  const expected = (10 / 3) * (400 + top * top + 20 * top);
  assert.ok(Math.abs(store.getState().evaluation.bodies[0]!.volume - expected) < 0.05);
});

void test('Revolve › Helix: the badge switches to a coil; the height arrow sets the turns', async () => {
  await load([
    {
      ...base('w'),
      kind: 'sketch',
      plane: { kind: 'plane', plane: 'XZ', offset: 0 },
      entities: [
        { id: 'p1', kind: 'point', x: 10, y: 0 },
        { id: 'c1', kind: 'circle', center: 'p1', radius: 1 },
      ],
      constraints: [],
      dimensions: [],
    } as Feature,
  ]);
  store.getState().setSelection([{ kind: 'sketchProfile', featureId: 'w' }]);
  run('tools.revolve');
  store
    .getState()
    .updateFeatureDraft((d) =>
      d.kind === 'revolve' ? { ...d, axis: { kind: 'world', axis: 'Z' } } : d,
    );
  store.getState().updateFeatureDraft((x, ev) => badge('Revolve path').apply(x, 'helix', ev));
  const helix = draft('revolve').helix!;
  assert.ok(helix.pitch > 2, `pitch clears the 2 mm wire: ${helix.pitch}`);
  const height = draftHandles(draft('revolve'), store.getState().evaluation).find(
    (h) => h.id === 'height',
  )!;
  store.getState().updateFeatureDraft((d) => height.apply(d, helix.pitch * 2));
  assert.equal(draft('revolve').helix!.turns, 2);
  await store.getState().whenSettled();
  await commit();
  const step = store.getState().features.at(-1)!;
  assert.ok(step.kind === 'revolve' && step.helix?.turns === 2);
});

void test('Scale: needs bodies (pick plan); sizes and factor edit it; Copy keeps the original', async () => {
  await load([cube('a', [0, 0, 0], 10)]);
  assert.ok(PICK_PLANS['transform.scale'], 'Scale asks for its bodies before a selection');
  store.getState().setSelection([{ kind: 'body', bodyId: 'body:a' }]);
  run('transform.scale');
  const d = draft('scale');
  assert.deepEqual(d.center, [0, 0, 0], 'the base centre');
  const size = draftHandles(d, store.getState().evaluation).find((h) => h.kind === 'linear')!;
  store.getState().updateFeatureDraft((x) => size.apply(x, 12));
  assert.equal(draft('scale').factor, 1.2);
  store.getState().updateFeatureDraft((x, ev) => badge('Scale or copy').apply(x, 'copy', ev));
  await store.getState().whenSettled();
  await commit();
  assert.equal(store.getState().evaluation.bodies.length, 2);
  assert.ok(Math.abs(body('body:a').volume - 1000) < 1e-6);
  const copy = store.getState().evaluation.bodies.find((b) => b.id !== 'body:a')!;
  assert.ok(Math.abs(copy.volume - 1728) < 1e-3);
});

void test('Translate: Bodies › Start point › End point with Next; clicks snap to vertices', async () => {
  await load([cube('a', [0, 0, 0], 10), cube('b', [30, 0, 0], 10)]);
  store.getState().clearSelection();
  run('transform.translate');
  let d = draft('translate');
  assert.equal(d.step, 0, 'without a selection it asks for the bodies');
  const steps = draftSteps(d)!;
  assert.deepEqual(steps.labels, ['Bodies', 'Start point', 'End point']);
  assert.equal(steps.go(d, 1), d, 'no Next without bodies');
  const a = body('body:a');
  const topA = a.faces.find((f) => f.normal?.[2] === 1)!;
  store
    .getState()
    .updateFeatureDraft((x, ev) =>
      acceptPick(x, { kind: 'face', bodyId: 'body:a', faceKey: topA.key, point: [1, 1, 10] }, ev),
    );
  assert.deepEqual(draft('translate').bodyIds, ['body:a']);
  store.getState().updateFeatureDraft((x) => draftSteps(x)!.go(x, 1));
  // Near a corner of the top face: snaps to the vertex.
  store
    .getState()
    .updateFeatureDraft((x, ev) =>
      acceptPick(
        x,
        { kind: 'face', bodyId: 'body:a', faceKey: topA.key, point: [4.4, 4.5, 10] },
        ev,
      ),
    );
  d = draft('translate');
  assert.deepEqual(d.from, [5, 5, 10]);
  assert.equal(d.step, 2);
  const b = body('body:b');
  const topB = b.faces.find((f) => f.normal?.[2] === 1)!;
  store
    .getState()
    .updateFeatureDraft((x, ev) =>
      acceptPick(
        x,
        { kind: 'face', bodyId: 'body:b', faceKey: topB.key, point: [25.3, -4.6, 10] },
        ev,
      ),
    );
  assert.deepEqual(draft('translate').to, [25, -5, 10]);
  await store.getState().whenSettled();
  await commit();
  const moved = body('body:a');
  assert.deepEqual(
    moved.min.map((v) => Math.round(v * 1000) / 1000),
    [15, -15, 0],
  );
});

void test('Move/Rotate on an edge: Move Edge with arrows across the edge; one undo step', async () => {
  await load([cube('a', [0, 0, 0], 20)]);
  const edge = body('body:a').edges.find(
    (e) =>
      e.curve === 'line' &&
      Math.abs(e.midpoint[1] + 10) < 1e-6 &&
      Math.abs(e.midpoint[2] - 20) < 1e-6,
  )!;
  store.getState().setSelection([{ kind: 'edge', bodyId: 'body:a', edgeKey: edge.key }]);
  run('transform.moveRotate');
  const handles = draftHandles(draft('moveEdge'), store.getState().evaluation);
  assert.deepEqual(
    handles.map((h) => h.label),
    ['Y offset', 'Z offset'],
    'the axes across an X edge',
  );
  store.getState().updateFeatureDraft((x) => handles[1]!.apply(x, 10));
  await store.getState().whenSettled();
  await commit();
  assert.ok(Math.abs(body('body:a').volume - (8000 + 0.5 * 20 * 20 * 10)) < 1e-3);
  store.getState().undo();
  await store.getState().whenSettled();
  assert.ok(Math.abs(body('body:a').volume - 8000) < 1e-6);
});

void test('Split Body: a clicked sketch profile is the split element; Keep original', async () => {
  await load([
    cube('a', [0, 0, 0], 20),
    {
      ...base('c'),
      kind: 'sketch',
      plane: { kind: 'plane', plane: 'XY', offset: 30 },
      entities: [
        { id: 'p1', kind: 'point', x: 0, y: 0 },
        { id: 'c1', kind: 'circle', center: 'p1', radius: 4 },
      ],
      constraints: [],
      dimensions: [],
    } as Feature,
  ]);
  store.getState().setSelection([{ kind: 'body', bodyId: 'body:a' }]);
  run('tools.split');
  store
    .getState()
    .updateFeatureDraft((x, ev) => acceptPick(x, { kind: 'sketchProfile', featureId: 'c' }, ev));
  assert.ok(draft('split').profile, 'the profile splits');
  assert.equal(badge('Split with').value, 'profile');
  store.getState().updateFeatureDraft((x, ev) => badge('Keep original').apply(x, 'keep', ev));
  await store.getState().whenSettled();
  await commit();
  assert.equal(store.getState().evaluation.bodies.length, 3);
  assert.ok(Math.abs(body('body:a').volume - 8000) < 1e-6, 'the original is kept');
});

void test('Rotate Around Axis started with its bodies: the Axis step is current, Bodies is one click back', async () => {
  await load([cube('a', [0, 0, 0], 10), cube('b', [30, 0, 0], 10)]);
  store.getState().setSelection([{ kind: 'body', bodyId: 'body:a' }]);
  run('transform.rotateAxis');
  let steps = draftSteps(draft('rotateAxis'))!;
  assert.deepEqual(steps.labels, ['Bodies', 'Axis']);
  assert.equal(steps.current, 1);
  store.getState().updateFeatureDraft((x) => draftSteps(x)!.go(x, 0));
  steps = draftSteps(draft('rotateAxis'))!;
  assert.equal(steps.current, 0);
  // In the Bodies step an edge click adds its body instead of setting the axis.
  const edgeB = body('body:b').edges[0]!;
  store
    .getState()
    .updateFeatureDraft((x, ev) =>
      acceptPick(x, { kind: 'edge', bodyId: 'body:b', edgeKey: edgeB.key }, ev),
    );
  const d = draft('rotateAxis');
  assert.deepEqual(d.bodyIds, ['body:a', 'body:b']);
  assert.equal(d.axis.kind, 'world');
  store.getState().cancel();
});
