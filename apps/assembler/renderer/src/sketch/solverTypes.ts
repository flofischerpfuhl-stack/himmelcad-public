/**
 * App-owned contract of the sketch constraint solver. The implementation
 * (`planegcsSolver.ts`, FreeCAD's planeGCS compiled to WebAssembly) runs in
 * a Web Worker in the app (`solver.worker.ts` + `workerSolver.ts`) and
 * in-process in Node tests; callers only see this interface, so the LGPL
 * solver stays a separately replaceable unit.
 */
import type { SketchData, Vec2 } from './types.js';

export interface SolveRequest {
  sketch: SketchData;
  /**
   * Points dragged by the user: pulled towards `target` with temporary
   * (lower-priority) constraints that never over-constrain the sketch.
   */
  drag?: { pointId: string; target: Vec2 }[];
  /** Also report which points/curves are fully determined (probes; slower). */
  analyze?: boolean;
}

export type SolveStatus =
  /** Solved; `sketch` holds the new positions. */
  | 'ok'
  /** Conflicting or redundant constraints/dimensions (see `conflicting` / `redundant`). */
  | 'overconstrained'
  /** The solver did not converge, or the solution collapses geometry. */
  | 'failed'
  /** A dimension expression is invalid (see `message`). */
  | 'invalid';

export interface SolveResult {
  status: SolveStatus;
  /** Solved sketch when `status === 'ok'`, else the request's sketch unchanged. */
  sketch: SketchData;
  /** Remaining degrees of freedom (0 = fully constrained). */
  dof: number;
  /** Constraint/dimension ids in conflict (over-constrained and inconsistent). */
  conflicting: string[];
  /** Constraint/dimension ids that are redundant (over-constrained but consistent). */
  redundant: string[];
  /** Human-readable reason when `status !== 'ok'`. */
  message: string | null;
  /**
   * Ids of points and curves whose position/size is fully determined
   * (only with `analyze`; `null` when not analysed or too large to analyse).
   */
  determined: string[] | null;
  /** Wall-clock solve time inside the solver, ms. */
  ms: number;
}

export interface SketchSolver {
  solve(request: SolveRequest): Promise<SolveResult>;
  /** Frees the solver (terminates the worker). */
  dispose?(): void;
}
