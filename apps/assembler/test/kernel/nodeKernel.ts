/**
 * Loads the real OCCT WebAssembly kernel in Node for tests (once per test
 * file — every `node --test` file runs in its own process).
 */
import { createRequire } from 'node:module';

import init from 'replicad-opencascadejs';

import { createEvaluator, type KernelEvaluator } from '../../renderer/src/kernel/evaluator.js';
import { InProcessKernelAdapter } from '../../renderer/src/kernel/adapter.js';

let loading: Promise<{ evaluator: KernelEvaluator; loadMs: number }> | null = null;

export function loadNodeKernel(): Promise<{ evaluator: KernelEvaluator; loadMs: number }> {
  loading ??= (async () => {
    const require = createRequire(import.meta.url);
    const wasmPath = require.resolve('replicad-opencascadejs/wasm');
    const start = performance.now();
    const oc = await init({ locateFile: () => wasmPath });
    const loadMs = performance.now() - start;
    return { evaluator: createEvaluator(oc), loadMs };
  })();
  return loading;
}

export function createNodeKernelAdapter(): InProcessKernelAdapter {
  return new InProcessKernelAdapter(async () => (await loadNodeKernel()).evaluator);
}
