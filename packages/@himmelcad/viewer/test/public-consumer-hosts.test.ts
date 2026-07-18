import assert from 'node:assert/strict';
import test from 'node:test';

import type { HimmelcadViewerWasmModule, KernelDecodeExecutor } from '../src/kernel/index.js';
import { loadBrowserMixedScene } from './browser/public-session-host.js';
import { loadPublicMixedScene } from './consumer/public-mixed-scene.js';
import { loadElectronMixedScene } from './electron/public-session-host.js';

void test('headless, browser and Electron hosts share one public mixed-scene loader', async () => {
  assert.equal(loadBrowserMixedScene, loadElectronMixedScene);
  let freed = 0;
  const canvas = { width: 1, height: 1, clientWidth: 640, clientHeight: 480 } as HTMLCanvasElement;
  for (const load of [loadPublicMixedScene, loadBrowserMixedScene, loadElectronMixedScene]) {
    const host = await load({
      canvas,
      wasmLoader: () => Promise.resolve(fakeModule(canvas, () => (freed += 1))),
      createDecodeExecutor: fakeDecodeExecutor,
    });

    assert.deepEqual(
      host.handles.map((handle) => handle.entityId),
      ['public-point', 'public-plan-curve', 'public-extension', 'public-splat'],
    );
    assert.equal(host.session.diagnostics().deviceGeneration, 1);
    host.session.dispose();
  }
  assert.equal(freed, 3);
});

function fakeModule(canvas: HTMLCanvasElement, free: () => void): HimmelcadViewerWasmModule {
  const zeroCost = {
    cpuCompressedBytes: 0,
    cpuDecodedBytes: 0,
    gpuBufferBytes: 0,
    gpuTextureBytes: 0,
    stagingBytes: 0,
    points: 0,
    triangles: 0,
    splats: 0,
    drawCalls: 0,
  };
  const binding = new Proxy<Record<string, unknown>>(
    {
      canonical_entity_version_hash_json: () => '22'.repeat(32),
      geometry_object_content_hash_json: () => '11'.repeat(32),
      publish_canonical_representations_json: () =>
        JSON.stringify({ entities: 3, slots: 3, proxies: 3, generation: 1, bindings: [] }),
      register_prepared_dataset_and_publish_canonical_json: () =>
        JSON.stringify({
          entities: 1,
          slots: 1,
          proxies: 1,
          generation: 2,
          bindings: [
            {
              key: {
                slot: { entityId: 'public-splat', representationSlot: 'primary' },
                entityRevision: 1,
                entityVersionHash: '22'.repeat(32),
                geometryRef: '11'.repeat(32),
              },
              generation: 1,
            },
          ],
        }),
      capabilities_json: () =>
        JSON.stringify({
          adapterName: 'headless-public-consumer',
          deviceKind: 'cpu',
          backend: 'webGl2',
          driver: '',
          driverInfo: '',
          features: [],
          maxTextureDimension2d: 8_192,
          maxStorageBufferBindingSize: 1,
          maxBufferSize: 1,
          maxSampleCount: 1,
        }),
      hardware_policy_json: () =>
        JSON.stringify({
          deploymentProfile: 'desktop',
          resources: zeroCost,
          frame: {
            targetFrameMs: 16.7,
            traversalMs: 1,
            decodeMs: 3,
            uploadBytes: 1_048_576,
            newRequests: 4,
          },
          maximumTraversedNodes: 100_000,
          interaction: {
            frame: {
              targetFrameMs: 16.7,
              traversalMs: 0.5,
              decodeMs: 1.5,
              uploadBytes: 524_288,
              newRequests: 1,
            },
            maximumTraversedNodes: 6_250,
          },
          workload: { points: 1, triangles: 1, splats: 1 },
          maximumRenderScale: 1,
          maximumDetailScale: 1,
          maximumMsaaSamples: 1,
          decoderWorkers: 1,
          contentRequests: 4,
          transparency: 'weightedBlended',
        }),
      runtime_quality_json: () => JSON.stringify({ renderScale: 1, detailScale: 1 }),
      begin_hardware_calibration: () =>
        JSON.stringify({
          completedSamples: 0,
          totalSamples: 12,
          inFlight: true,
          submitted: true,
          calibration: null,
        }),
      streaming_runtime_json: () =>
        JSON.stringify({
          limits: { decoderWorkers: 1, contentRequests: 4 },
          activeDecodes: 0,
          inFlightContentRequests: 0,
          trackedEntries: 0,
          residencyStageCounts: {
            unloaded: 0,
            fetching: 0,
            queuedDecode: 0,
            decoding: 0,
            queuedUpload: 0,
            uploading: 0,
            resident: 0,
            failed: 0,
          },
          residencyCost: zeroCost,
        }),
      gpu_model_cache_json: () => JSON.stringify({ allocations: 0, owners: 0, gpuBufferBytes: 0 }),
      gpu_texture_cache_json: () =>
        JSON.stringify({
          allocations: 0,
          retainedAllocations: 0,
          owners: 0,
          stagedOwners: 0,
          gpuTextureBytes: 0,
          decodedSources: 0,
          factoryCalls: 0,
        }),
      gpu_frame_timing_json: () =>
        JSON.stringify({
          supported: false,
          pendingReadbacks: 0,
          latestGpuMs: null,
          completedSamples: 0,
          saturatedFrames: 0,
          failedReadbacks: 0,
        }),
      width: () => canvas.width,
      height: () => canvas.height,
      free,
    },
    {
      get: (target, property) =>
        property === 'then' ? undefined : (Reflect.get(target, property) ?? (() => undefined)),
    },
  );
  return {
    WasmViewer: {
      create: () => Promise.resolve(binding as never),
    },
  };
}

function fakeDecodeExecutor(): KernelDecodeExecutor {
  return {
    setWorkerCount(): void {},
    decode: () => Promise.reject(new Error('public fixture has no resident streaming work')),
    diagnostics: () => ({
      requestedDecodeWorkers: 1,
      actualDecodeWorkers: 1,
      workerRamBudgetBytes: 1,
      perWorkerReservationBytes: 1,
      activeDecodes: 0,
      queuedDecodes: 0,
      transferredInputBytes: 0,
      transferredOutputBytes: 0,
      peakTransferBytes: 0,
      completedDecodes: 0,
      failedDecodes: 0,
      canceledDecodes: 0,
      workerDecodeMs: 0,
      mainThreadDispatchMs: 0,
      maximumWorkerBaselineLinearMemoryBytes: 0,
      maximumWorkerLinearMemoryBytes: 0,
    }),
    dispose(): void {},
  };
}
