/// <reference lib="webworker" />
/**
 * Sketch solver Web Worker: loads FreeCAD's planeGCS (LGPL-2.0-or-later,
 * `@salusoft89/planegcs`) at runtime — its JavaScript glue and wrapper as a
 * separately emitted chunk and its `.wasm` as a separate asset, so both
 * stay replaceable (`LICENSES/THIRD_PARTY.md`) — and solves sketches off
 * the UI thread.
 *
 * Protocol (main -> worker): `{ id, request }`.
 * Protocol (worker -> main): `{ id, result }` or `{ id, error }`.
 */
import wasmUrl from '@salusoft89/planegcs/dist/planegcs_dist/planegcs.wasm?url';

import { createPlanegcsSolver } from './planegcsSolver.js';
import type { SolveRequest, SolveResult } from './solverTypes.js';

declare const self: DedicatedWorkerGlobalScope;

export interface SolverWorkerRequest {
  id: number;
  request: SolveRequest;
}

export type SolverWorkerResponse =
  | { id: number; result: SolveResult }
  | { id: number; error: string };

const ready = (async () => {
  // Dynamic import on purpose: the LGPL glue stays its own chunk (see file comment).
  const lib = await import('@salusoft89/planegcs');
  const module = await lib.init_planegcs_module({ locateFile: () => wasmUrl });
  return createPlanegcsSolver({ module, GcsWrapper: lib.GcsWrapper });
})();

self.onmessage = (event: MessageEvent<SolverWorkerRequest>) => {
  const { id, request } = event.data;
  void ready.then(
    (solver) => {
      let response: SolverWorkerResponse;
      try {
        response = { id, result: solver.solveSync(request) };
      } catch (error) {
        response = { id, error: error instanceof Error ? error.message : String(error) };
      }
      self.postMessage(response);
    },
    (error: unknown) => {
      self.postMessage({
        id,
        error: `Sketch solver failed to load: ${error instanceof Error ? error.message : String(error)}`,
      } satisfies SolverWorkerResponse);
    },
  );
};
