/**
 * The planeGCS sketch solver (FreeCAD, WebAssembly, LGPL — see
 * `LICENSES/THIRD_PARTY.md`) in-process under Node for the headless CLI:
 * the same solver the app runs in its solver worker, loaded lazily on the
 * first sketch write.
 */
import { createRequire } from 'node:module';

import { GcsWrapper, init_planegcs_module } from '@salusoft89/planegcs';

import { createPlanegcsSolver } from '../renderer/src/sketch/planegcsSolver.js';
import type { SketchSolver } from '../renderer/src/sketch/solverTypes.js';

export function createHeadlessSketchSolver(): SketchSolver {
  let loading: Promise<ReturnType<typeof createPlanegcsSolver>> | null = null;
  const load = () =>
    (loading ??= (async () => {
      const require = createRequire(import.meta.url);
      const wasmPath = require.resolve('@salusoft89/planegcs/dist/planegcs_dist/planegcs.wasm');
      const module = await init_planegcs_module({ locateFile: () => wasmPath });
      return createPlanegcsSolver({ module, GcsWrapper });
    })());
  return { solve: async (request) => (await load()).solve(request) };
}
