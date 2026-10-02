/**
 * Hook point for the document's stored checks ("Checks", ROADMAP-LATER §2b
 * item 2) as other modules use them without importing the checks module:
 * a parameter sweep (`modules/parameters/sweep.ts`) runs the stored checks
 * on each sample. The checks module owns the checks, their storage and
 * `checks.run`; it registers one runner here (`onInstall` of its
 * `defineAssemblerModule`: `modules/checks/documentRunner.ts`, which runs
 * the enabled stored checks with `runChecks` from `checks.ts`). Without a
 * checks module a sweep reports `checks: null` ("not available"), never an
 * empty pass; with it but without stored checks, `checks: []`.
 *
 * Contract for the runner (assembler/MODULES.md §3 "Document checks"):
 * - evaluate the checks stored in the **current** document against the
 *   given sample (`features`, `parameters` and their `evaluation`), which is
 *   not the committed document — never read the store's evaluation for it;
 * - never change the document, the selection or the stored results;
 * - use `kernel` only for one-off queries (`measureDistance`,
 *   `measureClearance`, exports) of `features`; a missing kernel is a check
 *   `error`, not a crash;
 * - return within bounded time and stop early when `signal.aborted`.
 */
import type { Feature } from '../document/document.js';
import type { Parameter } from '../document/parameters.js';
import type { KernelAdapter } from '../geometry-kernel/adapter.js';
import type { EvaluationResult } from '../geometry-kernel/types.js';

/** The result of one stored check on one document state. */
export interface DocumentCheckResult {
  /** The check's stable id in the document. */
  checkId: string;
  /** Display name ("Wall ≥ 1.2 mm"). */
  name: string;
  /** `error`: the check could not be evaluated (missing reference, kernel failure). */
  status: 'pass' | 'fail' | 'error';
  /** Why it failed or could not run; absent on a pass. */
  message?: string;
  /** The measured value, when the check measures one (mm, mm³, degrees). */
  measured?: number;
  /** Unit of `measured` (`mm`, `deg`, `mm³`, `g`, `''` for counts). */
  unit?: string;
}

export interface DocumentCheckInput {
  features: readonly Feature[];
  parameters: readonly Parameter[];
  evaluation: EvaluationResult;
  kernel: KernelAdapter | null;
  signal: { readonly aborted: boolean };
}

export interface DocumentCheckRunner {
  /** Owning module id (`apps/assembler/modules.json`). */
  module: string;
  run(input: DocumentCheckInput): Promise<DocumentCheckResult[]>;
}

let runner: DocumentCheckRunner | null = null;

/** Installs the checks module's runner (one module; a second one throws). */
export function registerDocumentCheckRunner(next: DocumentCheckRunner): void {
  if (runner && runner !== next && runner.module !== next.module) {
    throw new Error(
      `A document check runner is already registered (${runner.module}, ${next.module})`,
    );
  }
  runner = next;
}

/** The registered runner, or `null` when no checks module is installed. */
export function documentCheckRunner(): DocumentCheckRunner | null {
  return runner;
}

/** Test hook: removes the runner. */
export function clearDocumentCheckRunner(): void {
  runner = null;
}
