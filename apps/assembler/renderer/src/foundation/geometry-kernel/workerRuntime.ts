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

async function download(url: string): Promise<ArrayBuffer> {
  const response = await fetch(url);
  if (!response.ok || !response.body) throw new Error(`HTTP ${response.status} for ${url}`);
  const total = Number(response.headers.get('content-length')) || 0;
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;
  let lastReport = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    received += value.byteLength;
    const now = performance.now();
    if (now - lastReport > 100) {
      lastReport = now;
      const mb = (n: number) => (n / 1048576).toFixed(1);
      status({
        status: 'loading',
        message: total
          ? `Loading CAD kernel… ${mb(received)} of ${mb(total)} MB`
          : `Loading CAD kernel… ${mb(received)} MB`,
        progress: total ? Math.min(1, received / total) * 0.8 : null,
        loadMs: null,
      });
    }
  }
  const bytes = new Uint8Array(received);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes.buffer;
}

async function load(): Promise<KernelEvaluator> {
  const start = performance.now();
  status({ status: 'loading', message: 'Loading CAD kernel…', progress: 0, loadMs: null });
  const wasmBinary = await download(wasmUrl);
  status({ status: 'loading', message: 'Starting CAD kernel…', progress: 0.85, loadMs: null });
  // Dynamic import on purpose: the LGPL Emscripten glue stays its own chunk
  // next to the .wasm instead of being bundled into this worker's code, so
  // both LGPL files remain separately replaceable (docs/DEPENDENCY-POLICY.md).
  const { default: init } = await import('replicad-opencascadejs');
  const oc = await init({ wasmBinary, locateFile: () => wasmUrl });
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
