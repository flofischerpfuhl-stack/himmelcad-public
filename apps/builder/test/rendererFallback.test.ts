import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import test from 'node:test';

import {
  appendSoftwareRenderingSwitches,
  BuilderRendererFallbackController,
  BuilderRendererFallbackStore,
} from '../electron/rendererFallback.js';

void test('GPU process loss advances once through retry, D3D11 WebGL2 and persisted software', async () => {
  const root = await mkdtemp(resolve(tmpdir(), 'hcad-renderer-fallback-'));
  const path = resolve(root, 'builder-settings.v1.json');
  const store = new BuilderRendererFallbackStore(path);
  assert.deepEqual(store.load(), { mode: 'hardware' });
  const controller = new BuilderRendererFallbackController(store);

  assert.equal(
    controller.gpuProcessGone('exit 34', 'AMD Radeon Vega 8', '31.0.12027.9001').kind,
    'retryCurrent',
  );
  assert.equal(
    controller.gpuProcessGone('exit 34', 'AMD Radeon Vega 8', '31.0.12027.9001').kind,
    'fallbackWebgl2',
  );
  assert.equal(
    controller.gpuProcessGone('exit 34', 'AMD Radeon Vega 8', '31.0.12027.9001').kind,
    'relaunchSoftware',
  );
  assert.equal(
    controller.gpuProcessGone('exit 34', 'AMD Radeon Vega 8', '31.0.12027.9001').kind,
    'none',
  );
  assert.equal(
    controller.tryHardwareAgain(),
    false,
    'one session may request at most one relaunch',
  );

  const persisted = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>;
  assert.equal(persisted.schemaVersion, 1);
  const relaunchedStore = new BuilderRendererFallbackStore(path);
  const relaunched = relaunchedStore.load();
  assert.equal(relaunched.mode, 'software');
  if (relaunched.mode === 'software') {
    assert.equal(relaunched.gpu, 'AMD Radeon Vega 8');
    assert.equal(relaunched.driver, '31.0.12027.9001');
    assert.equal(relaunched.reason, 'exit 34');
  }
  assert.equal(
    new BuilderRendererFallbackController(relaunchedStore).gpuProcessGone(
      'exit 34',
      'AMD Radeon Vega 8',
      '31.0.12027.9001',
    ).kind,
    'none',
    'a persisted software launch never relaunches itself',
  );
});

void test('Try hardware rendering again clears the decision and is guarded per session', () => {
  const root = resolve(
    tmpdir(),
    `hcad-renderer-retry-${String(process.pid)}-${String(Date.now())}`,
  );
  const store = new BuilderRendererFallbackStore(resolve(root, 'builder-settings.v1.json'));
  store.useSoftware({
    reason: 'surface failed',
    gpu: 'AMD Radeon Vega 8',
    driver: '31.0.12027.9001',
  });
  const controller = new BuilderRendererFallbackController(store);
  assert.equal(controller.tryHardwareAgain(), true);
  assert.deepEqual(store.status(), { mode: 'hardware' });
  assert.equal(controller.tryHardwareAgain(), false);
});

void test('Electron 43 software rendering switches opt into unsafe SwiftShader', () => {
  const switches: [string, string | undefined][] = [];
  appendSoftwareRenderingSwitches(
    { appendSwitch: (name, value) => switches.push([name, value]) },
    {
      mode: 'software',
      from: 'webgl2',
      reason: 'surface failed',
      gpu: 'AMD Radeon Vega 8',
      driver: '31.0.12027.9001',
      decidedAt: '2026-09-10T00:00:00.000Z',
    },
    '43.1.0',
  );
  assert.deepEqual(switches, [
    ['use-gl', 'angle'],
    ['use-angle', 'swiftshader'],
    ['enable-unsafe-swiftshader', undefined],
  ]);
});
