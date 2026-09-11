import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createKernelBackendWithFallback,
  KernelViewerSessionError,
} from '../src/kernel/KernelViewerSession.js';
import type { KernelBackendPreference } from '../src/kernel/WgpuKernelViewer.js';

void test('surface creation retries WebGPU once before falling back to WebGL2', async () => {
  const calls: KernelBackendPreference[] = [];
  const result = await createKernelBackendWithFallback(
    async (backend) => {
      calls.push(backend);
      if (calls.length < 3) throw new Error(`failed ${backend} surface`);
      return { backend };
    },
    { initialBackend: 'automatic' },
  );

  assert.deepEqual(calls, ['webgpu', 'webgpu', 'webgl2']);
  assert.equal(result.backend, 'webgl2');
  assert.deepEqual(result.fallbacks, [
    { from: 'webgpu', to: 'webgl2', reason: 'failed webgpu surface' },
  ]);
});

void test('a failed live backend gets one retry and WebGL2 gets its initial attempt plus retry', async () => {
  const calls: KernelBackendPreference[] = [];
  await assert.rejects(
    createKernelBackendWithFallback(
      async (backend) => {
        calls.push(backend);
        throw new Error(`failed ${backend} surface`);
      },
      { initialBackend: 'webgpu', currentBackendAlreadyFailed: true },
    ),
    (error: unknown) =>
      error instanceof KernelViewerSessionError &&
      error.code === 'softwareRenderingRequired' &&
      /failed webgl2 surface/.test(error.message),
  );
  assert.deepEqual(calls, ['webgpu', 'webgl2', 'webgl2']);
});

void test('a software launch stays on WebGL2 and never loops back to hardware', async () => {
  const calls: KernelBackendPreference[] = [];
  const result = await createKernelBackendWithFallback(
    async (backend) => {
      calls.push(backend);
      return backend;
    },
    { initialBackend: 'automatic', softwareRendering: true },
  );
  assert.deepEqual(calls, ['webgl2']);
  assert.equal(result.backend, 'software');
  assert.deepEqual(result.fallbacks, []);
});
