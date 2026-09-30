/**
 * Loads the real OCCT WebAssembly kernel in Node for tests (once per test
 * file — every `node --test` file runs in its own process). The module is
 * chosen by `HIMMELCAD_OCCT` (`headless/occtModule.ts`).
 */
import { loadOcct, type OpenCascadeModule } from '../../headless/occtModule.js';
import {
  createEvaluator,
  type KernelEvaluator,
} from '../../renderer/src/foundation/geometry-kernel/evaluator.js';
import { InProcessKernelAdapter } from '../../renderer/src/foundation/geometry-kernel/adapter.js';

type OpenCascade = OpenCascadeModule;

let loading: Promise<{ evaluator: KernelEvaluator; loadMs: number; oc: OpenCascade }> | null = null;

export function loadNodeKernel(): Promise<{
  evaluator: KernelEvaluator;
  loadMs: number;
  oc: OpenCascade;
}> {
  loading ??= (async () => {
    const start = performance.now();
    const oc = await loadOcct();
    const loadMs = performance.now() - start;
    return { evaluator: createEvaluator(oc), loadMs, oc };
  })();
  return loading;
}

export function createNodeKernelAdapter(): InProcessKernelAdapter {
  return new InProcessKernelAdapter(async () => (await loadNodeKernel()).evaluator);
}
