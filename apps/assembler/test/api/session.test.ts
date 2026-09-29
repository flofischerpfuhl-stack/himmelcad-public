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
import type { Feature } from '../../renderer/src/model/document.js';
import { useAssemblerStore } from '../../renderer/src/model/store.js';
import { createNodeKernelAdapter } from '../kernel/nodeKernel.js';

type Json = Record<string, unknown>;

const store = useAssemblerStore;
const kernel = createNodeKernelAdapter();
store.getState().attachKernel(kernel);

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
  const s = store.getState();
  s.beginSketchRectangle();
  store.getState().setPreviewRect(0, 0, 80, 50);
  store.getState().commit();
  const sketchId = store.getState().features.at(-1)!.id;
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

  // feature.edit vs editFeatureParams
  await call('feature.edit', {
    featureId: sketchId,
    params: { profiles: [{ ...RECT, width: 90 }] },
  });
  const apiEdited = store.getState().features;
  store.getState().undo();
  store.getState().editFeatureParams(sketchId, { profiles: [{ ...RECT, width: 90 }] as never });
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
  store.getState().beginSketchRectangle();
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

void test('sketch profile commands edit dimensions in place', async () => {
  await reset();
  const { sketchId, bodyId } = await apiPlate();
  const added = await call('sketch.addProfile', {
    featureId: sketchId,
    profile: { kind: 'circle', cx: 100, cy: 25, radius: 10 },
  });
  assert.equal(added.profileIndex, 1);
  await call('sketch.editProfile', {
    featureId: sketchId,
    index: 0,
    profile: { ...RECT, height: 40 },
  });
  const sketches = (await call('sketches.list')) as { profiles: unknown[]; consumed: boolean }[];
  assert.equal(sketches[0]!.profiles.length, 2);
  assert.equal(sketches[0]!.consumed, true);
  const body = await call<{ bbox: { max: number[] } }>('body.get', { bodyId });
  assert.deepEqual(body.bbox.max, [110, 40, 6]);
  await call('sketch.removeProfile', { featureId: sketchId, index: 1 });
  await fails(call('sketch.removeProfile', { featureId: sketchId, index: 0 }), 'invalidParams');
});
