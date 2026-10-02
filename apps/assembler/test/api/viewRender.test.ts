/**
 * `view.render` / `view.inspect` on the command layer with the real kernel
 * (software renderer, as in the headless CLI): PNGs of the requested size,
 * isolate/highlight/section/overlay parameters, structured errors, the
 * bundle budget, and no change to the document or the view state.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { ApiError } from '../../renderer/src/foundation/commands/api/errors.js';
import { useAssemblerStore } from '../../renderer/src/foundation/commands/store.js';
import { setSketchSolverFactory } from '../../renderer/src/foundation/sketch-solver/solverProvider.js';
import {
  AgentSession,
  HEADLESS_CAPABILITIES,
} from '../../renderer/src/interface/agent-api/session.js';
import { pngSize } from '../../renderer/src/platform/viewport/png.js';
import { createNodeKernelAdapter } from '../kernel/nodeKernel.js';
import { loadNodeSolver } from '../sketch/nodeSolver.js';

type Json = Record<string, unknown>;

const store = useAssemblerStore;
const kernel = createNodeKernelAdapter();
store.getState().attachKernel(kernel);
setSketchSolverFactory(() => ({
  solve: async (request) => (await loadNodeSolver()).solve(request),
}));
const session = new AgentSession({
  store,
  kernel,
  host: { server: 'headless', capabilities: HEADLESS_CAPABILITIES },
});
const call = async <T = Json>(method: string, params: Json = {}) =>
  (await session.handle(method, params)) as T;

async function fails(promise: Promise<unknown>, code: ApiError['code']): Promise<void> {
  await assert.rejects(
    promise,
    (error: unknown) => error instanceof ApiError && error.code === code,
  );
}

const png = (result: Json) => Buffer.from(String(result.data), 'base64');

let bodyId = '';
test.before(async () => {
  store.getState().loadDocument([], { projectName: 'Render' });
  await store.getState().whenSettled();
  const sketch = await call('feature.create', {
    kind: 'sketch',
    params: {
      plane: { kind: 'plane', plane: 'XY', offset: 0 },
      profiles: [{ kind: 'rectangle', x: -20, y: -10, width: 40, height: 20 }],
    },
  });
  const extrude = await call('feature.create', {
    kind: 'extrude',
    params: { profile: { kind: 'sketch', featureId: sketch.featureId }, distance: 10 },
  });
  bodyId = `body:${String(extrude.featureId)}`;
});

void test('view.render returns a PNG of the requested size and leaves document and view alone', async () => {
  const before = store.getState();
  const result = await call('view.render', { view: 'front', width: 200, height: 120 });
  assert.equal(result.renderer, 'software');
  assert.equal(result.mediaType, 'image/png');
  assert.deepEqual(pngSize(png(result)), { width: 200, height: 120 });
  assert.deepEqual((result.view as Json).name, 'front');
  assert.deepEqual(result.bounds, { min: [-20, -10, 0], max: [20, 10, 10] });
  const after = store.getState();
  assert.equal(after.features, before.features);
  assert.equal(after.viewState, before.viewState);
  assert.equal(after.history.canUndo, before.history.canUndo);
});

void test('azimuth/elevation, perspective, highlight, tint, section and modes all render', async () => {
  const faces = await call<Json[]>('faces.list', { bodyId });
  const edges = await call<Json[]>('edges.list', { bodyId });
  const result = await call('view.render', {
    view: { azimuth: 30, elevation: 20 },
    projection: 'perspective',
    width: 128,
    height: 128,
    highlight: {
      bodyIds: [bodyId],
      faces: [{ bodyId, key: faces[0]!.key }],
      edges: [{ bodyId, key: edges[0]!.key }],
    },
    tint: [{ bodyId, faceKeys: [String(faces[1]!.key)], color: 'red' }],
    section: { axis: 'x', offset: 0, flip: true },
    background: 'dark',
  });
  assert.deepEqual(result.view, { azimuth: 30, elevation: 20, projection: 'perspective' });
  for (const displayMode of ['shaded', 'wireframe', 'xray']) {
    const mode = await call('view.render', { displayMode, width: 64, height: 64 });
    assert.ok(Number(mode.byteLength) > 100, displayMode);
  }
  const overlay = await call('view.render', { overlay: ['printFindings'], width: 64, height: 64 });
  assert.equal(typeof (overlay.findings as Json).count, 'number');
});

void test('errors: unknown bodies and faces, GPU headless, size limits, inspect budget', async () => {
  await fails(call('view.render', { bodyIds: ['body:nope'] }), 'notFound');
  await fails(
    call('view.render', { highlight: { faces: [{ bodyId, key: 'nope' }] } }),
    'referenceNotFound',
  );
  await fails(call('view.render', { renderer: 'gpu' }), 'unsupported');
  await fails(call('view.render', { width: 5000 }), 'invalidParams');
  await fails(
    call('view.inspect', {
      views: ['iso', 'top', 'front', 'back', 'left', 'right', 'bottom', 'iso'],
      size: 1024,
    }),
    'invalidParams',
  );
});

void test('view.inspect bundles four views with a manifest of the bodies', async () => {
  const result = await call('view.inspect', { size: 96 });
  const images = result.images as Json[];
  assert.equal(images.length, 4);
  for (const image of images) assert.deepEqual(pngSize(png(image)), { width: 96, height: 96 });
  const manifest = result.manifest as Json;
  const bodies = manifest.bodies as Json[];
  assert.equal(bodies.length, 1);
  assert.deepEqual((bodies[0]!.bbox as Json).size, [40, 20, 10]);
  assert.equal((manifest.totals as Json).volume, 8000);
});

void test('the path parameter writes the PNG in the headless CLI only', async () => {
  const app = new AgentSession({
    store,
    kernel,
    host: { server: 'app', capabilities: new Set(['document.read']) },
  });
  await assert.rejects(
    app.handle('view.render', { path: 'x.png' }),
    (error: unknown) => error instanceof ApiError && error.code === 'permissionDenied',
  );
});
