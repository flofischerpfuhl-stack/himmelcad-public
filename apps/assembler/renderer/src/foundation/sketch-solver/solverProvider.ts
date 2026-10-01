/**
 * Process-wide access to the sketch solver. The app registers a factory
 * that starts the solver Web Worker lazily (first sketch session or first
 * dimension edit); tests register the in-process planeGCS solver.
 *
 * Also the single place that injects the document's current parameter
 * values (`model/parameters.ts`) into every solve request, so every caller
 * — the interactive sketch tool (`sketch/session.ts`), one-shot feature
 * edits (`sketch/featureOps.ts`), the agent API (`api/sketchApi.ts`) — gets
 * the same values without threading them through each call site. The store
 * updates the provider whenever parameters change (`model/store.ts`).
 */
import type { SketchSolver, SolveRequest, SolveResult } from './solverTypes.js';

let factory: (() => SketchSolver) | null = null;
let instance: SketchSolver | null = null;
let paramValuesProvider: (() => ReadonlyMap<string, number>) | null = null;

export function setSketchSolverFactory(next: (() => SketchSolver) | null): void {
  instance?.dispose?.();
  instance = null;
  factory = next;
}

/** Registers the function the solver asks for current document parameter values. `null` clears it. */
export function setParameterValuesProvider(next: (() => ReadonlyMap<string, number>) | null): void {
  paramValuesProvider = next;
}

function withParams(solver: SketchSolver): SketchSolver {
  return {
    solve: (request: SolveRequest): Promise<SolveResult> =>
      solver.solve({
        ...request,
        paramValues: request.paramValues ?? [...(paramValuesProvider?.() ?? new Map())],
      }),
    dispose: () => solver.dispose?.(),
  };
}

/** The shared solver; throws when no factory was registered. */
export function getSketchSolver(): SketchSolver {
  if (!instance) {
    if (!factory) throw new Error('No sketch solver is available');
    instance = withParams(factory());
  }
  return instance;
}
