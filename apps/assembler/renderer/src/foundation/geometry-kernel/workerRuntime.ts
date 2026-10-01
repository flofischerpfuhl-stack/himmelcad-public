/// <reference lib="webworker" />
/**
 * CAD kernel Web Worker: downloads the OCCT WebAssembly module and its
 * Emscripten glue (separate, runtime-loaded, user-replaceable files — see
 * `LICENSES/THIRD_PARTY.md`), reports progress, and evaluates feature lists
 * off the UI thread.
 *
 * Protocol (main -> worker): `{ type: 'evaluate', jobId, features, quality }`,
 * `{ type: 'exportStep', jobId, features, bodyIds? }`,
 * `{ type: 'measureDistance', jobId, features, a, b }` (→ `measureResult` |
 * `measureFailed`).
 * Protocol (worker -> main): `{ type: 'status', status }`,
 * `{ type: 'progress', jobId, progress }` between features,
 * `{ type: 'result', jobId, result }`, `{ type: 'failed', jobId, message }`,
 * `{ type: 'fatal', jobId, message }` when the kernel itself died (wasm
 * abort, out of memory — the main thread restarts the worker),
 * `{ type: 'exportResult' | 'exportFailed', … }`.
 *
 * The requests are answered by the transport-independent handler
 * (`workerHost.ts`), which the headless CLI's worker thread shares.
 */
import wasmUrl from 'replicad-opencascadejs/wasm?url';

import { createEvaluator, type KernelEvaluator } from './evaluator.js';
import { occtFormatCapabilities } from './stepImport.js';
import type { KernelStatusInfo } from './types.js';
import { createKernelRequestHandler } from './workerHost.js';
import type { WorkerRequest, WorkerResponse } from './workerProtocol.js';

export type { WireBody, WorkerRequest, WorkerResponse } from './workerProtocol.js';

declare const self: DedicatedWorkerGlobalScope;

function post(message: WorkerResponse, transfer: Transferable[] = []): void {
  self.postMessage(message, transfer);
}

function status(status: KernelStatusInfo): void {
  post({ type: 'status', status });
}

/**
 * Downloads and compiles the OCCT module in one pass: the response streams
 * through a byte counter (progress) into `WebAssembly.instantiateStreaming`,
 * so compilation overlaps the download and no second 25 MB copy is held.
 * A compressed response (`Content-Encoding: br/gzip`, static web hosting)
 * has a `Content-Length` of the compressed size while the stream yields
 * decoded bytes, so its total is unknown and progress is indeterminate.
 */
async function instantiateOcct(
  url: string,
  imports: WebAssembly.Imports,
): Promise<WebAssembly.WebAssemblyInstantiatedSource> {
  const response = await fetch(url, { credentials: 'same-origin' });
  if (!response.ok || !response.body) throw new Error(`HTTP ${response.status} for ${url}`);
  const encoding = (response.headers.get('content-encoding') ?? '').trim().toLowerCase();
  const total =
    encoding === '' || encoding === 'identity'
      ? Number(response.headers.get('content-length')) || 0
      : 0;
  let received = 0;
  let lastReport = 0;
  const mb = (n: number) => (n / 1048576).toFixed(1);
  const counter = new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      received += chunk.byteLength;
      const now = performance.now();
      if (now - lastReport > 100) {
        lastReport = now;
        status({
          status: 'loading',
          message: total
            ? `Loading CAD kernel… ${mb(received)} of ${mb(total)} MB`
            : `Loading CAD kernel… ${mb(received)} MB`,
          progress: total ? Math.min(1, received / total) * 0.8 : null,
          loadMs: null,
        });
      }
      controller.enqueue(chunk);
    },
    flush() {
      status({ status: 'loading', message: 'Starting CAD kernel…', progress: 0.85, loadMs: null });
    },
  });
  const counted = new Response(response.body.pipeThrough(counter), {
    headers: { 'Content-Type': 'application/wasm' },
  });
  if (typeof WebAssembly.instantiateStreaming === 'function') {
    return WebAssembly.instantiateStreaming(counted, imports);
  }
  return WebAssembly.instantiate(await counted.arrayBuffer(), imports);
}

async function load(): Promise<KernelEvaluator> {
  const start = performance.now();
  status({ status: 'loading', message: 'Loading CAD kernel…', progress: 0, loadMs: null });
  // Dynamic import on purpose: the LGPL Emscripten glue stays its own chunk
  // next to the .wasm instead of being bundled into this worker's code, so
  // both LGPL files remain separately replaceable (docs/DEPENDENCY-POLICY.md).
  const { default: init } = await import('replicad-opencascadejs');
  // The glue's `instantiateWasm` hook (Emscripten MODULARIZE) hands us the
  // imports; a failure there must reject the load, not leave `init` pending.
  let failLoad: (error: unknown) => void = () => undefined;
  const failed = new Promise<never>((_, reject) => {
    failLoad = reject;
  });
  const options = {
    locateFile: () => wasmUrl,
    instantiateWasm: (
      imports: WebAssembly.Imports,
      receive: (instance: WebAssembly.Instance, module: WebAssembly.Module) => void,
    ) => {
      instantiateOcct(wasmUrl, imports).then(
        (source) => receive(source.instance, source.module),
        failLoad,
      );
      return {};
    },
  } as unknown as Parameters<typeof init>[0];
  const oc = await Promise.race([init(options), failed]);
  const evaluator = createEvaluator(oc);
  const loadMs = performance.now() - start;
  status({
    status: 'ready',
    message: 'CAD kernel ready',
    progress: 1,
    loadMs,
    capabilities: occtFormatCapabilities(oc),
  });
  return evaluator;
}

const ready = load();
ready.catch((error: unknown) => {
  status({
    status: 'error',
    message: `CAD kernel failed to load: ${error instanceof Error ? error.message : String(error)}`,
    progress: null,
    loadMs: null,
  });
});

const handle = createKernelRequestHandler(ready, post);

self.onmessage = (event: MessageEvent<WorkerRequest>) => handle(event.data);
