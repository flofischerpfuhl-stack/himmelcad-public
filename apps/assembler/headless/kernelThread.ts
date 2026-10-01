/**
 * The OCCT kernel in a Node worker thread (headless CLI, fuzzer): the same
 * module kernel parts and request handler as the app's kernel Web Worker
 * (`renderer/src/app/kernel.worker.ts`, `foundation/geometry-kernel/
 * workerHost.ts`), with OCCT loaded from disk (`occtModule.ts`). Running
 * the kernel off the calling thread lets `threadKernel.ts` stop an OCCT
 * call that never returns (time budget, assembler/ROBUSTNESS.md F13).
 *
 * Host query `evaluateFresh`: a cold evaluation with a fresh evaluator on
 * this thread's OCCT instance (optionally after `perturbation` extra OCCT
 * allocations, a different heap layout; optionally `staged`: the steps
 * before the last one first) — the fuzzer's determinism checks.
 *
 * Output: everything the kernel prints goes to stderr (stdout of the
 * headless CLI is the JSON-RPC stream), including anything written to this
 * thread's stdout.
 */
import { parentPort, workerData } from 'node:worker_threads';

import '../renderer/src/app/kernelModules.js';
import { createEvaluator } from '../renderer/src/foundation/geometry-kernel/evaluator.js';
import { arenaInterleavings } from '../renderer/src/foundation/geometry-kernel/occtArena.js';
import { occtFormatCapabilities } from '../renderer/src/foundation/geometry-kernel/stepImport.js';
import type { Feature } from '../renderer/src/foundation/document/document.js';
import {
  createKernelRequestHandler,
  type KernelPost,
} from '../renderer/src/foundation/geometry-kernel/workerHost.js';
import type { WorkerRequest } from '../renderer/src/foundation/geometry-kernel/workerProtocol.js';
import { loadOcct, type OpenCascadeModule } from './occtModule.js';

/** Params of the `evaluateFresh` host query. */
export interface EvaluateFreshParams {
  features: Feature[];
  staged?: boolean;
  perturbation?: number;
}

const port = parentPort;
if (!port) throw new Error('kernelThread.ts must run in a worker thread');

const toStderr = (...args: unknown[]) =>
  process.stderr.write(
    `${args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ')}\n`,
  );
// A thread's stdout would reach the parent's stdout, the CLI's JSON-RPC stream.
process.stdout.write = process.stderr.write.bind(process.stderr) as typeof process.stdout.write;
console.log = toStderr;
console.info = toStderr;
console.debug = toStderr;

const post: KernelPost = (message, transfer = []) =>
  port.postMessage(message, transfer as unknown as readonly ArrayBuffer[]);

let oc: OpenCascadeModule | null = null;
/** OCCT objects kept alive to shift the heap layout of later cold evaluations. */
const ballast: unknown[] = [];

const ready = (async () => {
  const start = performance.now();
  post({
    type: 'status',
    status: { status: 'loading', message: 'Loading CAD kernel…', progress: 0, loadMs: null },
  });
  const quiet = (workerData as { quiet?: boolean } | null)?.quiet === true;
  const print = quiet ? () => undefined : (text: string) => process.stderr.write(`${text}\n`);
  oc = await loadOcct({ print, printErr: print });
  const evaluator = createEvaluator(oc);
  post({
    type: 'status',
    status: {
      status: 'ready',
      message: 'CAD kernel ready',
      progress: 1,
      loadMs: performance.now() - start,
      capabilities: occtFormatCapabilities(oc),
    },
  });
  return evaluator;
})();
ready.catch((error: unknown) => {
  post({
    type: 'status',
    status: {
      status: 'error',
      message: `CAD kernel failed to load: ${error instanceof Error ? error.message : String(error)}`,
      progress: null,
      loadMs: null,
    },
  });
});

const handle = createKernelRequestHandler(ready, post, {
  evaluateFresh: async (_evaluator, raw) => {
    const params = raw as EvaluateFreshParams;
    if (!oc) throw new Error('the kernel is not loaded');
    const OC = oc as unknown as { gp_Pnt: new (x: number, y: number, z: number) => unknown };
    for (let i = 0; i < (params.perturbation ?? 0) * 7; i += 1) {
      ballast.push(new OC.gp_Pnt(i, params.perturbation ?? 0, 0));
    }
    // A fresh evaluator: empty caches, the same OCCT instance (replicad's global stays this one).
    const fresh = createEvaluator(oc);
    try {
      if (params.staged) await fresh.evaluate(params.features.slice(0, -1), { quality: 'final' });
      const result = await fresh.evaluate(params.features, { quality: 'final' });
      return { result, arenaInterleavings: arenaInterleavings() };
    } finally {
      fresh.clearCache();
    }
  },
  diagnostics: async () => ({ arenaInterleavings: arenaInterleavings() }),
});

port.on('message', (message: WorkerRequest) => handle(message));
