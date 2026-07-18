import type { HimmelcadViewerWasmModule, KernelDecodeExecutor } from '../../src/kernel/index.js';
import { loadBrowserMixedScene } from '../browser/public-session-host.js';
import { loadElectronMixedScene } from '../electron/public-session-host.js';

declare global {
  interface Window {
    __HCAD_PUBLIC_HOST__?: {
      ready: boolean;
      environment: string;
      entityIds: readonly string[];
      error: string | null;
      dispose: () => boolean;
    };
  }
}

const canvas = document.querySelector<HTMLCanvasElement>('canvas');
if (!canvas) throw new Error('public consumer process has no canvas');
const environment = new URL(location.href).searchParams.get('host') ?? 'browser';
const state = {
  ready: false,
  environment,
  entityIds: [] as readonly string[],
  error: null as string | null,
  dispose: () => false,
};
window.__HCAD_PUBLIC_HOST__ = state;

void (async () => {
  try {
    const load = environment === 'electron' ? loadElectronMixedScene : loadBrowserMixedScene;
    const host = await load({
      canvas,
      wasmLoader: () => Promise.resolve(fakeModule(canvas)),
      createDecodeExecutor: fakeDecodeExecutor,
    });
    state.entityIds = host.handles.map((handle) => handle.entityId);
    state.dispose = () => {
      host.session.dispose();
      try {
        host.session.diagnostics();
        return false;
      } catch {
        return true;
      }
    };
    state.ready = true;
  } catch (error) {
    state.error = error instanceof Error ? error.message : String(error);
    state.ready = true;
  }
})();

function fakeModule(canvas: HTMLCanvasElement): HimmelcadViewerWasmModule {
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
          adapterName: `${environment}-public-consumer`,
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
      hardware_policy_json: () => JSON.stringify(policy(zeroCost)),
      runtime_quality_json: () => JSON.stringify({ renderScale: 1, detailScale: 1 }),
      begin_hardware_calibration: () =>
        JSON.stringify({
          completedSamples: 0,
          totalSamples: 12,
          inFlight: true,
          submitted: true,
          calibration: null,
        }),
      width: () => canvas.width,
      height: () => canvas.height,
      free(): void {},
    },
    {
      get: (target, property) =>
        property === 'then' ? undefined : (Reflect.get(target, property) ?? (() => undefined)),
    },
  );
  return { WasmViewer: { create: () => Promise.resolve(binding as never) } };
}

function policy(resources: Readonly<Record<string, number>>): Readonly<Record<string, unknown>> {
  return {
    deploymentProfile: 'desktop',
    resources,
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
  };
}

function fakeDecodeExecutor(): KernelDecodeExecutor {
  return {
    setWorkerCount(): void {},
    decode: () => Promise.reject(new Error('minimal process host does not decode tiles')),
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
