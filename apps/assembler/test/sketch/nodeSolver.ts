/**
 * Loads the real planeGCS WebAssembly solver in Node for tests (once per
 * test file — every `node --test` file runs in its own process).
 */
import { createRequire } from 'node:module';

import { GcsWrapper, init_planegcs_module } from '@salusoft89/planegcs';

import { createPlanegcsSolver } from '../../renderer/src/sketch/planegcsSolver.js';

let loading: Promise<ReturnType<typeof createPlanegcsSolver>> | null = null;

export function loadNodeSolver(): Promise<ReturnType<typeof createPlanegcsSolver>> {
  loading ??= (async () => {
    const require = createRequire(import.meta.url);
    const wasmPath = require.resolve('@salusoft89/planegcs/dist/planegcs_dist/planegcs.wasm');
    const module = await init_planegcs_module({ locateFile: () => wasmPath });
    return createPlanegcsSolver({ module, GcsWrapper });
  })();
  return loading;
}
