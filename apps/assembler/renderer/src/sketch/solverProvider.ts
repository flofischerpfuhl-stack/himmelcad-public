/**
 * Process-wide access to the sketch solver. The app registers a factory
 * that starts the solver Web Worker lazily (first sketch session or first
 * dimension edit); tests register the in-process planeGCS solver.
 */
import type { SketchSolver } from './solverTypes.js';

let factory: (() => SketchSolver) | null = null;
let instance: SketchSolver | null = null;

export function setSketchSolverFactory(next: (() => SketchSolver) | null): void {
  instance?.dispose?.();
  instance = null;
  factory = next;
}

/** The shared solver; throws when no factory was registered. */
export function getSketchSolver(): SketchSolver {
  if (!instance) {
    if (!factory) throw new Error('No sketch solver is available');
    instance = factory();
  }
  return instance;
}
