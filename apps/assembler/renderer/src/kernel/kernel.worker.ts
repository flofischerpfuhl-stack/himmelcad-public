/// <reference lib="webworker" />
/**
 * CAD kernel Web Worker: downloads the OCCT WebAssembly module and its
 * Emscripten glue (separate, runtime-loaded, user-replaceable files — see
 * `LICENSES/THIRD_PARTY.md`), reports progress, and evaluates feature lists
 * off the UI thread.
 *
 * Protocol (main -> worker): `{ type: 'evaluate', jobId, features }`.
 * Protocol (worker -> main): `{ type: 'status', status }`,
 * `{ type: 'result', jobId, result }` (typed arrays transferred) or
 * `{ type: 'failed', jobId, message }`.
 */
import wasmUrl from 'replicad-opencascadejs/wasm?url';

import type { Feature } from '../model/document.js';
import { createEvaluator, type KernelEvaluator } from './evaluator.js';
import type { EvaluationResult, KernelStatusInfo } from './types.js';

declare const self: DedicatedWorkerGlobalScope;

export type WorkerRequest =
  | { type: 'evaluate'; jobId: number; features: Feature[] }
  | { type: 'exportStep'; jobId: number; features: Feature[]; bodyIds?: string[] };

export type WorkerResponse =
  | { type: 'status'; status: KernelStatusInfo }
  | { type: 'result'; jobId: number; result: EvaluationResult }
  | { type: 'failed'; jobId: number; message: string }
  | { type: 'exportResult'; jobId: number; bytes: ArrayBuffer }
  | { type: 'exportFailed'; jobId: number; message: string };

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
  status({ status: 'ready', message: 'CAD kernel ready', progress: 1, loadMs });
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

self.onmessage = (event: MessageEvent<WorkerRequest>) => {
  const message = event.data;
  if (message.type === 'exportStep') {
    void ready.then(
      async (evaluator) => {
        try {
          const bytes = (await evaluator.exportStep(message.features, message.bodyIds)).slice();
          post({ type: 'exportResult', jobId: message.jobId, bytes: bytes.buffer }, [bytes.buffer]);
        } catch (error) {
          post({
            type: 'exportFailed',
            jobId: message.jobId,
            message: error instanceof Error ? error.message : String(error),
          });
        }
      },
      () => undefined,
    );
    return;
  }
  if (message.type !== 'evaluate') return;
  void ready.then(
    async (evaluator) => {
      let result: EvaluationResult;
      try {
        result = await evaluator.evaluate(message.features);
      } catch (error) {
        post({
          type: 'failed',
          jobId: message.jobId,
          message: error instanceof Error ? error.message : String(error),
        });
        return;
      }
      const transfer: Transferable[] = [];
      for (const body of result.bodies) {
        transfer.push(
          body.mesh.positions.buffer,
          body.mesh.normals.buffer,
          body.mesh.indices.buffer,
          body.mesh.triangleFaces.buffer,
        );
        for (const edge of body.edges) transfer.push(edge.segments.buffer);
      }
      post({ type: 'result', jobId: message.jobId, result }, transfer);
    },
    () => undefined,
  );
};
