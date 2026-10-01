/**
 * Kernel time budgets (assembler/ROBUSTNESS.md finding F13). An OCCT call
 * can run forever on unusual geometry (a fillet on some lofts); wasm cannot
 * be interrupted on its own thread. Where the kernel runs in a worker (the
 * app's Web Worker, the headless CLI's worker thread) the adapter stops a
 * job that exceeds its budget by terminating and restarting the worker and
 * fails it with a {@link KernelTimeoutError} — the agent API answers
 * `kernelTimeout`, nothing is committed, the document is unchanged.
 *
 * Kept free of OCCT imports: the adapters on the calling thread use it.
 */

/** Default budget of one kernel job on the headless CLI (env `HIMMELCAD_KERNEL_TIMEOUT_MS`). */
export const DEFAULT_HEADLESS_KERNEL_TIMEOUT_MS = 120_000;

/** A kernel job exceeded its time budget and was stopped (the kernel was restarted). */
export class KernelTimeoutError extends Error {
  readonly code = 'kernelTimeout';

  constructor(
    /** What ran out of time ("evaluating the document", "STEP export", …). */
    readonly what: string,
    readonly budgetMs: number,
  ) {
    super(
      `The CAD kernel did not finish ${what} within ${formatBudget(budgetMs)}; it was stopped and restarted.`,
    );
    this.name = 'KernelTimeoutError';
  }
}

function formatBudget(ms: number): string {
  return ms >= 1000 ? `${Math.round(ms / 100) / 10} s` : `${ms} ms`;
}

/** `true` for a {@link KernelTimeoutError} (also across a structured clone: by `code`). */
export function isKernelTimeout(error: unknown): boolean {
  return (
    error instanceof KernelTimeoutError ||
    (typeof error === 'object' &&
      error !== null &&
      (error as { code?: unknown }).code === 'kernelTimeout')
  );
}

/**
 * The job budget from `HIMMELCAD_KERNEL_TIMEOUT_MS` (a positive number of
 * milliseconds; `0` switches the budget off), else `fallback`.
 */
export function kernelTimeoutFromEnv(
  env: Readonly<Record<string, string | undefined>>,
  fallback: number,
): number | undefined {
  const raw = env.HIMMELCAD_KERNEL_TIMEOUT_MS;
  if (raw === undefined || raw.trim() === '') return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`HIMMELCAD_KERNEL_TIMEOUT_MS must be a non-negative number, got "${raw}"`);
  }
  return value === 0 ? undefined : value;
}
