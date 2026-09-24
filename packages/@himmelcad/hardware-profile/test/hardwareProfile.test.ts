import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
  RendererFallbackController,
  deriveChromiumLaunchSwitches,
  deriveRenderingStatus,
  resolveMatchedQuirks,
  validateQuirkRegistry,
  type PersistedRendererFallback,
  type RendererFallbackDecision,
  type RendererFallbackStore,
} from '../src/index.js';

class MemoryStore implements RendererFallbackStore {
  private value: PersistedRendererFallback = { mode: 'hardware' };
  status(): PersistedRendererFallback {
    return this.value;
  }
  useSoftware(input: {
    readonly reason: string;
    readonly gpu: string;
    readonly driver: string;
    readonly decidedAt?: string;
  }): RendererFallbackDecision {
    this.value = {
      mode: 'software',
      from: 'webgl2',
      reason: input.reason,
      gpu: input.gpu,
      driver: input.driver,
      decidedAt: input.decidedAt ?? '2026-09-24T00:00:00.000Z',
    };
    return this.value;
  }
  clear(): void {
    this.value = { mode: 'hardware' };
  }
}

void test('GPU process loss advances once through retry, WebGL2 and persisted software', () => {
  const store = new MemoryStore();
  const controller = new RendererFallbackController(store);
  assert.equal(
    controller.gpuProcessGone('exit 34', 'AMD Radeon Vega 8', '31.0.21925.1001').kind,
    'retryCurrent',
  );
  assert.equal(
    controller.gpuProcessGone('exit 34', 'AMD Radeon Vega 8', '31.0.21925.1001').kind,
    'fallbackWebgl2',
  );
  assert.equal(
    controller.gpuProcessGone('exit 34', 'AMD Radeon Vega 8', '31.0.21925.1001').kind,
    'relaunchSoftware',
  );
  assert.equal(
    controller.gpuProcessGone('exit 34', 'AMD Radeon Vega 8', '31.0.21925.1001').kind,
    'none',
  );
});

void test('switch derivation preserves Windows, Linux development and software policies', () => {
  assert.deepEqual(
    deriveChromiumLaunchSwitches({
      os: 'windows',
      development: false,
      electronVersion: '43.1.0',
      persistedFallback: { mode: 'hardware' },
    }),
    [{ name: 'use-angle', value: 'd3d11' }],
  );
  assert.deepEqual(
    deriveChromiumLaunchSwitches({
      os: 'linux',
      development: true,
      electronVersion: '43.1.0',
      persistedFallback: { mode: 'hardware' },
    }),
    [{ name: 'enable-unsafe-webgpu' }],
  );
  assert.deepEqual(
    deriveChromiumLaunchSwitches({
      os: 'macos',
      development: false,
      electronVersion: '43.1.0',
      persistedFallback: { mode: 'hardware' },
    }),
    [],
  );
  assert.deepEqual(
    deriveChromiumLaunchSwitches({
      os: 'windows',
      development: false,
      electronVersion: '43.1.0',
      persistedFallback: {
        mode: 'software',
        from: 'webgl2',
        reason: 'failed',
        gpu: 'GPU',
        driver: 'driver',
        decidedAt: '2026-09-24T00:00:00Z',
      },
    }),
    [
      { name: 'use-gl', value: 'angle' },
      { name: 'use-angle', value: 'swiftshader' },
      { name: 'enable-unsafe-swiftshader' },
    ],
  );
});

void test('status requires affirmative Chromium and non-fallback adapter evidence', () => {
  const hardware = { gpu_compositing: 'enabled', webgl: 'enabled', webgpu: 'enabled' };
  assert.equal(
    deriveRenderingStatus({
      chromiumFeatureStatus: null,
      persistedFallback: { mode: 'hardware' },
      viewer: null,
    }).state,
    'initializing',
  );
  assert.equal(
    deriveRenderingStatus({
      chromiumFeatureStatus: hardware,
      persistedFallback: { mode: 'hardware' },
      viewer: { backend: 'webgpu', adapter: { isFallbackAdapter: false } },
    }).label,
    'WebGPU (hardware)',
  );
  assert.equal(
    deriveRenderingStatus({
      chromiumFeatureStatus: hardware,
      persistedFallback: { mode: 'hardware' },
      viewer: { backend: 'webgl2', adapter: { isFallbackAdapter: false } },
    }).label,
    'WebGL2 (hardware)',
  );
  assert.equal(
    deriveRenderingStatus({
      chromiumFeatureStatus: hardware,
      persistedFallback: { mode: 'hardware' },
      viewer: { backend: 'webgpu', adapter: { isFallbackAdapter: true } },
    }).label,
    'Software',
  );
});

void test('WIN-21/22 Vega 8 software compositing and readback facts resolve to Software', () => {
  const status = deriveRenderingStatus({
    chromiumFeatureStatus: {
      gpu_compositing: 'disabled_software',
      webgl: 'enabled_readback',
      webgpu: 'disabled_software',
    },
    chromiumGpuInfo: {
      gpuDevice: [{ vendorId: 0x1002, deviceId: 0x15d8, driverVersion: '31.0.21925.1001' }],
    },
    persistedFallback: { mode: 'hardware' },
    viewer: {
      backend: 'webgl2',
      adapter: {
        vendorId: 0x1002,
        deviceId: 0x15d8,
        driver: '31.0.21925.1001',
        isFallbackAdapter: false,
      },
    },
  });
  assert.equal(status.label, 'Software');
});

void test('quirk schema validates bounds and deterministic priority/conflicts', () => {
  const canonical = JSON.parse(readFileSync('quirks-v1.json', 'utf8')) as unknown;
  assert.deepEqual(validateQuirkRegistry(canonical).rules, []);
  const base = {
    match: { os: 'windows' as const, vendorId: 0x1002, deviceId: 0x15d8 },
    reason: 'test',
    expires: '2099-01-01',
  };
  const high = {
    ...base,
    id: 'high',
    priority: 2,
    actions: { forceAngle: 'd3d11', renderBudgetScale: 0.8 },
  };
  const low = {
    ...base,
    id: 'low',
    priority: 1,
    actions: { forceAngle: 'gl', computeBudgetScale: 0.9 },
  };
  assert.deepEqual(
    resolveMatchedQuirks([low, high]).map(({ id }) => id),
    ['high', 'low'],
  );
  assert.throws(() =>
    resolveMatchedQuirks([
      { ...high, id: 'alpha', priority: 1 },
      { ...low, id: 'beta', priority: 1 },
    ]),
  );
  assert.throws(() =>
    validateQuirkRegistry({
      schemaVersion: 1,
      rules: [{ ...high, actions: { renderBudgetScale: 1.1 } }],
    }),
  );
  assert.throws(() =>
    validateQuirkRegistry({ schemaVersion: 1, rules: [{ ...high, match: { gpuName: 'Vega' } }] }),
  );
});
