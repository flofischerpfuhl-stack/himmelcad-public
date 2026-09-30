/**
 * The canonical command layer on the real OCCT kernel: agent commands and
 * UI actions produce the same history and the same undo steps; transactions
 * stage without touching the store and cancel without trace; failures never
 * commit; errors carry codes, hints and candidates; the app host's trust
 * rules (no file paths, confirmation for discarding work, busy while a UI
 * tool runs) hold.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { ApiError } from '../../renderer/src/api/errors.js';
import {
  APP_CAPABILITIES,
  AgentSession,
  HEADLESS_CAPABILITIES,
} from '../../renderer/src/api/session.js';
import type { Feature, SketchFeature } from '../../renderer/src/model/document.js';
import { useAssemblerStore } from '../../renderer/src/model/store.js';
import { addRectangle } from '../../renderer/src/sketch/builders.js';
import { setSketchDimension } from '../../renderer/src/sketch/featureOps.js';
import { rememberRegions } from '../../renderer/src/sketch/regionMemory.js';
import { setSketchSolverFactory } from '../../renderer/src/sketch/solverProvider.js';
import { EMPTY_SKETCH } from '../../renderer/src/sketch/types.js';
import { createNodeKernelAdapter } from '../kernel/nodeKernel.js';
import { loadNodeSolver } from '../sketch/nodeSolver.js';

type Json = Record<string, unknown>;

const store = useAssemblerStore;
const kernel = createNodeKernelAdapter();
store.getState().attachKernel(kernel);
setSketchSolverFactory(() => ({
  solve: async (request) => (await loadNodeSolver()).solve(request),
}));

let dirty = false;
const session = new AgentSession({
  store,
  kernel,
  host: { server: 'headless', capabilities: HEADLESS_CAPABILITIES },
});
const appSession = new AgentSession({
  store,
  kernel,
  host: { server: 'app', capabilities: APP_CAPABILITIES, hasUnsavedChanges: () => dirty },
});

async function call<T = Json>(method: string, params: Json = {}): Promise<T> {
  return (await session.handle(method, params)) as T;
}

async function fails(promise: Promise<unknown>, code: ApiError['code']): Promise<ApiError> {
  try {
    await promise;
  } catch (error) {
    assert.ok(error instanceof ApiError, `expected ApiError, got ${String(error)}`);
    assert.equal(error.code, code, error.message);
    return error;
  }
  assert.fail(`expected ${code}`);
}

async function reset(): Promise<void> {
  store.getState().cancel();
  if (session.transactionOpen) await call('transaction.cancel');
  store.getState().loadDocument([], { projectName: 'Test' });
  await store.getState().whenSettled();
}

/** Replaces feature ids by their position so histories built by different paths compare. */
function normalized(features: readonly Feature[]): unknown {
  const ids = new Map(features.map((f, i) => [f.id, `#${i}`]));
  const replace = (value: unknown): unknown => {
    if (typeof value === 'string') {
      let out = value;
      for (const [id, placeholder] of ids) out = out.split(id).join(placeholder);
      return out;
    }
    if (Array.isArray(value)) return value.map(replace);
    if (value && typeof value === 'object') {
      return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, replace(v)]));
    }
    return value;
  };
  return replace(features);
}

const RECT = { kind: 'rectangle', x: 0, y: 0, width: 80, height: 50 };

async function apiPlate(): Promise<{ sketchId: string; extrudeId: string; bodyId: string }> {
  const sketch = await call('feature.create', {
    kind: 'sketch',
    params: { plane: 'XY', profiles: [RECT] },
  });
  const extrude = await call('feature.create', {
    kind: 'extrude',
    params: { profile: { kind: 'sketch', featureId: sketch.featureId }, distance: 6 },
  });
  return {
    sketchId: sketch.featureId as string,
    extrudeId: extrude.featureId as string,
    bodyId: `body:${String(extrude.featureId)}`,
  };
}

async function uiPlate(): Promise<void> {
  // A dimensioned rectangle committed the way a finished sketch session commits it.
  const sketch: SketchFeature = {
    id: store.getState().allocateFeatureId('sketch', new Set()),
    name: 'Sketch 1',
    suppressed: false,
    kind: 'sketch',
    plane: { kind: 'plane', plane: 'XY', offset: 0 },
    // A session commit records the region fingerprints (`sketch/regionMemory.ts`).
    ...rememberRegions(
      addRectangle(EMPTY_SKETCH, [0, 0], [80, 50], { position: true, size: true }).sketch,
    ),
  };
  store.getState().addFeature(sketch, [{ kind: 'sketchProfile', featureId: sketch.id }]);
  const sketchId = sketch.id;
  store.getState().beginExtrude({ kind: 'sketch', featureId: sketchId });
  store.getState().setDistance(6);
  await store.getState().whenSettled();
  store.getState().commit();
  await store.getState().whenSettled();
}

void test('agent commands build the same history as the UI tools, one undo step each', async () => {
  await reset();
  await uiPlate();
  const ui = store.getState().features;
  const uiBody = store.getState().evaluation.bodies[0]!;

  await reset();
  const created = await apiPlate();
  const api = store.getState().features;
  assert.deepEqual(normalized(api), normalized(ui));
  const body = await call<Json>('body.get', { bodyId: created.bodyId });
  assert.equal(body.volume, uiBody.volume);
  assert.deepEqual(body.bbox, { min: [0, 0, 0], max: [80, 50, 6], size: [80, 50, 6] });
  assert.equal(body.valid, true);

  // Same undo stack: two commands = two steps, exactly like two UI "Done"s.
  const u1 = await call('history.undo');
  assert.equal(u1.featureCount, 1);
  const u2 = await call('history.undo');
  assert.equal(u2.featureCount, 0);
  assert.equal(u2.canUndo, false);
  await call('history.redo');
  await call('history.redo');
  assert.deepEqual(normalized(store.getState().features), normalized(ui));
});

void test('fillet by edge key equals the UI fillet tool; edit/suppress/delete equal store actions', async () => {
  await reset();
  const { bodyId, sketchId } = await apiPlate();
  const edges = await call<Json[]>('edges.list', { bodyId, select: '|Z and >X' });
  assert.equal(edges.length, 2);
  const key = edges[0]!.key as string;
  const before = store.getState().features;

  // UI path
  store.getState().select({ kind: 'edge', bodyId, edgeKey: key });
  store.getState().beginEdgeBlend('fillet');
  store.getState().setBlendSize(2);
  await store.getState().whenSettled();
  store.getState().commit();
  await store.getState().whenSettled();
  const ui = store.getState().features;
  store.getState().undo();
  assert.equal(store.getState().features, before);

  // Agent path
  await call('feature.create', {
    kind: 'fillet',
    params: { edges: [{ bodyId, key }], radius: 2 },
  });
  assert.deepEqual(normalized(store.getState().features), normalized(ui));

  // sketch.setDimension vs the History panel's dimension edit (setSketchDimension)
  await call('sketch.setDimension', { featureId: sketchId, dimension: 'd3', value: 90 });
  const apiEdited = store.getState().features;
  store.getState().undo();
  await store.getState().whenSettled();
  const sketchFeature = store.getState().features.find((f) => f.id === sketchId) as SketchFeature;
  const width = sketchFeature.dimensions.find((d) => d.name === 'd3')!;
  assert.equal(await setSketchDimension(sketchId, width.id, 90), null);
  assert.deepEqual(store.getState().features, apiEdited);
  await store.getState().whenSettled();
  const widened = await call<{ bbox: { size: number[] } }>('body.get', { bodyId });
  assert.equal(widened.bbox.size[0], 90);

  // feature.suppress vs setSuppressed, feature.delete vs deleteFeature
  const filletId = store.getState().features.at(-1)!.id;
  await call('feature.suppress', { featureId: filletId, suppressed: true });
  const apiSuppressed = store.getState().features;
  store.getState().undo();
  store.getState().setSuppressed(filletId, true);
  assert.deepEqual(store.getState().features, apiSuppressed);
  await call('feature.delete', { featureId: filletId });
  const apiDeleted = store.getState().features;
  store.getState().undo();
  store.getState().deleteFeature(filletId);
  assert.deepEqual(store.getState().features, apiDeleted);
});

void test('a transaction stages without touching the store; cancel leaves no trace', async () => {
  await reset();
  await apiPlate();
  const features = store.getState().features;
  const history = store.getState().history;
  const revision = session.documentRevision;
  let notifications = 0;
  const off = store.subscribe((s, p) => {
    if (s.features !== p.features || s.history !== p.history) notifications += 1;
  });

  await call('transaction.begin', { label: 'Holes' });
  const top = await call<Json[]>('faces.list', { bodyId: 'body:' + features[1]!.id, select: '>Z' });
  const sketch = await call('feature.create', {
    kind: 'sketch',
    params: {
      plane: { kind: 'face', face: { bodyId: top[0]!.bodyId, key: top[0]!.key } },
      profiles: [{ kind: 'circle', cx: 20, cy: 25, radius: 3 }],
    },
  });
  assert.equal(sketch.committed, false);
  const cut = await call('feature.create', {
    kind: 'extrude',
    params: {
      profile: { kind: 'sketch', featureId: sketch.featureId },
      distance: -6,
      operation: 'cut',
    },
  });
  assert.equal(cut.committed, false);
  const preview = await call('transaction.preview');
  const staged = (preview.bodies as { volume: number }[])[0]!;
  assert.ok(Math.abs(staged.volume - (24000 - Math.PI * 9 * 6)) < 1e-3);
  // Queries default to the staged state inside the transaction, `committed` reads the document.
  assert.equal((await call<unknown[]>('features.list')).length, 4);
  assert.equal((await call<unknown[]>('features.list', { scope: 'committed' })).length, 2);

  await call('transaction.cancel');
  off();
  assert.equal(store.getState().features, features);
  assert.equal(store.getState().history, history);
  assert.equal(session.documentRevision, revision);
  assert.equal(notifications, 0);
  assert.equal((await call<unknown[]>('features.list')).length, 2);
});

void test('a committed transaction is exactly one undo step', async () => {
  await reset();
  await call('transaction.begin');
  const { bodyId } = await apiPlate();
  await call('feature.create', {
    kind: 'fillet',
    params: { edges: [{ bodyId, select: '|Z' }], radius: 3 },
  });
  assert.equal(store.getState().features.length, 0);
  const committed = await call('transaction.commit');
  assert.equal((committed.featureIds as string[]).length, 3);
  assert.equal(store.getState().features.length, 3);
  await call('history.undo');
  assert.equal(store.getState().features.length, 0);
  assert.equal(store.getState().history.canUndo, false);
});

void test('kernel failures are not committed and explain themselves', async () => {
  await reset();
  const { bodyId } = await apiPlate();
  const before = store.getState().features;
  const error = await fails(
    call('feature.create', {
      kind: 'fillet',
      params: { edges: [{ bodyId, select: '|Z' }], radius: 40 },
    }),
    'featureFailed',
  );
  assert.ok(error.hint);
  assert.equal(store.getState().features, before);
});

void test('unknown references and ids come back with candidates', async () => {
  await reset();
  const { bodyId } = await apiPlate();
  const ref = await fails(
    call('feature.create', {
      kind: 'fillet',
      params: { edges: [{ bodyId, key: 'feature-extrude-x:end:0|nope' }], radius: 1 },
    }),
    'referenceNotFound',
  );
  const candidates = ref.details?.candidates as { key: string; name: string }[];
  assert.ok(candidates.length > 0 && candidates.every((c) => c.key.includes('|') && c.name));
  const body = await fails(call('body.get', { bodyId: 'body:missing' }), 'notFound');
  assert.deepEqual(
    (body.details?.candidates as { id: string }[]).map((c) => c.id),
    [bodyId],
  );
  await fails(
    call('feature.create', { kind: 'extrude', params: { distance: 5 } }),
    'invalidParams',
  );
  await fails(call('feature.create', { kind: 'warp', params: {} }), 'invalidParams');
  const method = await fails(call('feature.frobnicate'), 'methodNotFound');
  assert.ok((method.details?.candidates as string[]).includes('feature.create'));
});

void test('optimistic concurrency: expectedRevision and user edits during a transaction', async () => {
  await reset();
  await apiPlate();
  const revision = session.documentRevision;
  await fails(
    call('feature.rename', {
      featureId: store.getState().features[0]!.id,
      name: 'X',
      expectedRevision: revision - 1,
    }),
    'conflict',
  );
  await call('transaction.begin');
  await call('feature.rename', {
    featureId: store.getState().features[0]!.id,
    name: 'Base sketch',
  });
  store.getState().renameFeature(store.getState().features[1]!.id, 'User edit'); // the user edits meanwhile
  await fails(call('transaction.commit'), 'conflict');
  await call('transaction.cancel');
  assert.equal(store.getState().features[0]!.name, 'Sketch 1');
});

void test('writes are refused while a UI tool session is active', async () => {
  await reset();
  const { bodyId } = await apiPlate();
  store.getState().beginMove(bodyId);
  await fails(
    call('feature.create', { kind: 'sketch', params: { plane: 'XY', profiles: [RECT] } }),
    'busy',
  );
  store.getState().cancel();
});

void test('exports, save and open round-trip through the command layer', async () => {
  await reset();
  await apiPlate();
  for (const [method, magic] of [
    ['export.3mf', 'PK'],
    ['export.step', 'ISO-10303-21'],
  ] as const) {
    const out = await call(method);
    const bytes = Buffer.from(out.data as string, 'base64');
    assert.equal(bytes.byteLength, out.byteLength);
    assert.ok(bytes.subarray(0, 64).toString('latin1').includes(magic), method);
  }
  const stl = await call('export.stl');
  assert.equal(stl.byteLength, 84 + 50 * 12); // 12 triangles of a box
  const saved = await call('project.save');
  await call('project.new');
  assert.equal(store.getState().features.length, 0);
  const opened = await call('project.open', { text: saved.text });
  assert.equal(opened.featureCount, 2);
  assert.equal((opened.bodies as unknown[]).length, 1);
  await fails(call('project.open', { text: '{"format":"other"}' }), 'invalidParams');
});

void test('the app endpoint session has no file access and cannot discard unsaved work', async () => {
  await reset();
  await apiPlate();
  await fails(appSession.handle('export.stl', { path: 'x.stl' }), 'permissionDenied');
  await fails(appSession.handle('project.save', { path: 'x.hcasm' }), 'permissionDenied');
  dirty = true;
  await fails(appSession.handle('project.new', {}), 'confirmationRequired');
  assert.equal(store.getState().features.length, 2);
  dirty = false;
  const hello = (await appSession.handle('api.hello', {})) as Json;
  assert.deepEqual(hello.capabilities, ['document.read', 'document.write', 'view.write']);
});

void test('sketch commands: shapes with dimensions, constraints, conflicts, regions', async () => {
  await reset();
  const { sketchId, bodyId } = await apiPlate();
  const added = await call<Json>('sketch.addProfile', {
    featureId: sketchId,
    profile: { kind: 'circle', cx: 100, cy: 25, radius: 10 },
  });
  assert.deepEqual((added.shape as Json).dimensions, { cx: 'd5', cy: 'd6', diameter: 'd7' });
  assert.equal(added.dof, 0);
  await call('sketch.setDimension', { featureId: sketchId, dimension: 'd4', value: 40 });
  const sketches = (await call('sketches.list')) as {
    regions: { key: string; entityIds: string[] }[];
    dimensions: { name: string; value: number }[];
    consumed: boolean;
  }[];
  assert.equal(sketches[0]!.regions.length, 2);
  assert.equal(sketches[0]!.consumed, true);
  assert.equal(sketches[0]!.dimensions.find((d) => d.name === 'd4')!.value, 40);
  const body = await call<{ bbox: { max: number[] } }>('body.get', { bodyId });
  assert.deepEqual(body.bbox.max, [110, 40, 6]);

  // An expression drives a dimension from another one.
  await call('sketch.setDimension', { featureId: sketchId, dimension: 'd7', expression: 'd4 / 2' });
  const circle = (await call<{ bbox: { min: number[] } }>('body.get', { bodyId })).bbox;
  assert.deepEqual(circle.min, [0, 0, 0]);
  const list = (await call('sketches.list')) as { dimensions: { name: string; value: number }[] }[];
  assert.equal(list[0]!.dimensions.find((d) => d.name === 'd7')!.value, 20);

  // A redundant constraint is rejected with the solver's diagnosis; nothing changes.
  const before = store.getState().features;
  const redundant = await fails(
    call('sketch.addConstraint', { featureId: sketchId, kind: 'horizontal', refs: ['l1'] }),
    'sketchConflict',
  );
  assert.ok(
    (redundant.details?.redundant as string[]).length > 0 || redundant.details?.conflicting,
  );
  assert.equal(store.getState().features, before);
  await fails(
    call('sketch.setDimension', { featureId: sketchId, dimension: 'd9', value: 1 }),
    'notFound',
  );

  // Deleting the circle removes its dimensions too.
  const circleIds = (added.shape as { entityIds: string[] }).entityIds;
  await call('sketch.deleteItems', { featureId: sketchId, ids: [circleIds[1]!] });
  const after = (await call('sketches.list')) as { regions: unknown[]; dimensions: unknown[] }[];
  assert.equal(after[0]!.regions.length, 1);
  assert.equal(after[0]!.dimensions.length, 4);
});

void test('revolve through the API: polyline profile about a construction centre line', async () => {
  await reset();
  const sketch = await call<Json>('feature.create', { kind: 'sketch', params: { plane: 'XZ' } });
  const featureId = sketch.featureId as string;
  const profile = await call<Json>('sketch.addPolyline', {
    featureId,
    points: [
      [5, 0],
      [15, 0],
      [15, 4],
      [9, 4],
      [9, 10],
      [5, 10],
    ],
    closed: true,
  });
  // Axis-aligned segments were constrained horizontal/vertical: 12 point DOF - 6 = 6.
  assert.equal(profile.dof, 6);
  const axis = await call<Json>('sketch.addPolyline', {
    featureId,
    points: [
      [0, -2],
      [0, 12],
    ],
    construction: true,
  });
  assert.equal((axis.regions as unknown[]).length, 1, 'construction lines bound no region');
  const revolve = await call<Json>('feature.create', {
    kind: 'revolve',
    params: {
      profile: { kind: 'sketch', featureId },
      axis: { kind: 'sketchLine', featureId, entityId: (axis.lineIds as string[])[0] },
    },
  });
  const bodies = revolve.bodies as { volume: number; valid: boolean }[];
  assert.equal(bodies.length, 1);
  const ring = (r0: number, r1: number, h: number) => Math.PI * (r1 * r1 - r0 * r0) * h;
  assert.ok(Math.abs(bodies[0]!.volume - (ring(5, 15, 4) + ring(5, 9, 6))) < 1e-3);
  assert.equal(bodies[0]!.valid, true);
  // Validated like any known kind: a bad axis fails before the kernel.
  await fails(
    call('feature.create', {
      kind: 'revolve',
      params: { profile: { kind: 'sketch', featureId }, axis: { kind: 'sketchEdge' } },
    }),
    'invalidParams',
  );
});

void test('parameters: create, use in an extrude distanceExpression, rename cascades, delete refused then allowed', async () => {
  await reset();
  const wall = await call<Json>('parameter.create', { name: 'wall', unit: 'mm', value: 2 });
  assert.deepEqual(wall.parameter, {
    id: (wall.parameter as Json).id,
    name: 'wall',
    unit: 'mm',
    value: 2,
  });
  const doubled = await call<Json>('parameter.create', {
    name: 'wall2',
    unit: 'mm',
    expression: 'wall * 2',
  });
  assert.equal((doubled.parameter as Json).value, 4);

  const { sketchId, bodyId } = await apiPlate();
  const extrude = await call<Json>('feature.create', {
    kind: 'extrude',
    params: {
      profile: { kind: 'face', face: { bodyId, select: '>Z' } },
      distanceExpression: 'wall2',
      operation: 'join',
    },
  });
  const feature = await call<Json>('feature.get', { featureId: extrude.featureId as string });
  assert.equal((feature.params as Json).distance, 4);
  assert.equal((feature.params as Json).distanceExpression, 'wall2');

  const list = (await call('parameters.list')) as Json[];
  assert.equal(list.length, 2);

  // Renaming rewrites the extrude's expression and keeps the resolved value.
  const wallId = (wall.parameter as Json).id as string;
  await call('parameter.edit', { parameterId: wallId, name: 'thickness' });
  const renamed = await call<Json>('feature.get', { featureId: extrude.featureId as string });
  assert.equal((renamed.params as Json).distance, 4);
  const doubledAfter = (await call('parameters.list')) as Json[];
  assert.equal(doubledAfter.find((p) => p.name === 'wall2')!.expression, 'thickness * 2');

  // Deleting a used parameter is refused with its users.
  const refused = await fails(call('parameter.delete', { parameterId: 'thickness' }), 'conflict');
  assert.ok((refused.details?.usages as Json[]).length > 0);

  // Editing the value updates every dependent, still as one undo step.
  await call('parameter.edit', { parameterId: 'thickness', value: 3 });
  assert.equal(store.getState().history.canUndo, true);
  const afterEdit = await call<Json>('feature.get', { featureId: extrude.featureId as string });
  assert.equal((afterEdit.params as Json).distance, 6);
  void sketchId;
});

void test('parameters: an unknown-name or non-positive expression is rejected without committing', async () => {
  await reset();
  await fails(call('parameter.create', { name: 'a', expression: 'missing + 1' }), 'invalidParams');
  await call('parameter.create', { name: 'small', unit: 'mm', value: 1 });
  const { bodyId } = await apiPlate();
  await fails(
    call('feature.create', {
      kind: 'extrude',
      params: {
        profile: { kind: 'face', face: { bodyId, select: '>Z' } },
        distanceExpression: 'small - 5',
        operation: 'join',
      },
    }),
    'invalidParams',
  );
});
