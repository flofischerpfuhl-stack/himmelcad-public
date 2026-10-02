/**
 * Runs the document's checks in the background after every rebuild
 * (assembler/CHECKS.md "Evaluation"), without getting in the way of
 * interactive editing:
 *
 * - Nothing runs while the document has no checks.
 * - A run starts {@link CHECKS_DEBOUNCE_MS} after the evaluation (or the
 *   check list) changed, never while a tool or drag is active or the kernel
 *   computes the document: results are then shown as out of date.
 * - Incremental: a check whose bodies kept their geometry keeps its result
 *   (`runChecks` fingerprints).
 * - Instant checks (volume, mass, body count, fit, sizes) take microseconds
 *   on the main thread; kernel checks (distance, angle, clearance) run in
 *   the kernel worker, each only once the kernel is idle; print checks in a
 *   printability worker. Each within {@link CHECK_BUDGET_MS}.
 * - A newer change cancels the run between checks (a kernel query in
 *   progress finishes, its result is dropped).
 * - A failing check never notifies, opens a dialog or takes the focus: the
 *   result only updates the panel and the badge.
 */
import { runChecks, type CheckEnv, type CheckResult } from '../../foundation/commands/checks.js';
import { displayBodyName, useItemsStore } from '../../foundation/commands/items.js';
import { useAssemblerStore, type AssemblerState } from '../../foundation/commands/store.js';
import type { StoredCheck } from '../../foundation/document/checks.js';
import type { Feature } from '../../foundation/document/document.js';
import type { KernelAdapter } from '../../foundation/geometry-kernel/adapter.js';
import type { EvaluationResult } from '../../foundation/geometry-kernel/types.js';
import { useCheckResults } from './checksStore.js';

/** Quiet time after a change before checks run, ms. */
export const CHECKS_DEBOUNCE_MS = 250;
/** Kernel/worker time of one check, ms. */
export const CHECK_BUDGET_MS = 5000;

let kernel: KernelAdapter | null = null;
let started = false;
let timer: ReturnType<typeof setTimeout> | null = null;
let generation = 0;

/** The steps the shown evaluation comes from (above the History rollback bar). */
export function activeFeaturesOf(
  state: Pick<AssemblerState, 'features' | 'rollbackBefore'>,
): Feature[] {
  if (!state.rollbackBefore) return state.features;
  const index = state.features.findIndex((f) => f.id === state.rollbackBefore);
  return index < 0 ? state.features : state.features.slice(0, index);
}

/** Display name of a body (Items renames) of `evaluation`. */
export function bodyNamer(evaluation: EvaluationResult): (bodyId: string) => string {
  const meta = useItemsStore.getState();
  return (bodyId) => {
    const body = evaluation.bodies.find((b) => b.id === bodyId);
    return body ? displayBodyName(body, meta) : bodyId;
  };
}

/** Resolves once the kernel runs nothing (a background check never delays an edit). */
function kernelIdle(adapter: KernelAdapter): Promise<void> {
  return new Promise((resolve) => {
    let off: (() => void) | null = null;
    let done = false;
    off = adapter.onActivity((activity) => {
      if (activity || done) return;
      done = true;
      queueMicrotask(() => off?.());
      resolve();
    });
    if (done) queueMicrotask(() => off?.());
  });
}

/** Whether the document is being edited right now (results would be for an older state). */
function busy(state: AssemblerState): boolean {
  return state.activeTool !== null || state.evaluationPending;
}

/** Runs `checks` against the current document; results land in `useCheckResults`. */
async function run(): Promise<void> {
  const state = useAssemblerStore.getState();
  const checks = state.checks;
  if (checks.length === 0) {
    useCheckResults.setState({
      results: {},
      evaluatedFor: state.evaluation,
      running: false,
      progress: null,
    });
    return;
  }
  if (busy(state)) return; // the change that ends the edit schedules again
  generation += 1;
  const mine = generation;
  const evaluation = state.evaluation;
  const env: CheckEnv = {
    evaluation,
    features: activeFeaturesOf(state),
    kernel: kernel && kernel.status.status === 'ready' ? kernel : null,
    bodyName: bodyNamer(evaluation),
    cancelled: () => mine !== generation || busy(useAssemblerStore.getState()),
    budgetMs: CHECK_BUDGET_MS,
  };
  const previous = new Map(Object.entries(useCheckResults.getState().results));
  useCheckResults.setState({ running: true, progress: { done: 0, total: checks.length } });
  const results = await runChecks(checks, env, {
    previous,
    onResult: (result, done, total) => {
      if (mine !== generation) return;
      useCheckResults.setState((s) => ({
        results: { ...s.results, [result.id]: result },
        progress: { done, total },
      }));
    },
    beforeBackgroundCheck: async () => {
      if (env.kernel) await kernelIdle(env.kernel);
    },
  });
  if (mine !== generation) return;
  const complete = results.length === checks.length;
  useCheckResults.setState({
    results: keepCurrent(checks, Object.fromEntries(results.map((r) => [r.id, r]))),
    evaluatedFor: complete ? evaluation : useCheckResults.getState().evaluatedFor,
    running: false,
    progress: null,
  });
  // Cancelled by an edit: the change that ends it schedules the next run.
}

/** Results of the checks that still exist. */
function keepCurrent(
  checks: readonly StoredCheck[],
  results: Record<string, CheckResult>,
): Record<string, CheckResult> {
  const out: Record<string, CheckResult> = {};
  for (const check of checks) {
    const result = results[check.id] ?? useCheckResults.getState().results[check.id];
    if (result) out[check.id] = result;
  }
  return out;
}

/** Schedules a run after the quiet time (a pending one is restarted). */
export function scheduleChecks(delay = CHECKS_DEBOUNCE_MS): void {
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => {
    timer = null;
    void run();
  }, delay);
  (timer as { unref?: () => void }).unref?.();
}

/** Runs now (the panel's "Run now", tests). Resolves when the run ended. */
export async function runChecksNow(): Promise<void> {
  if (timer) clearTimeout(timer);
  timer = null;
  await run();
}

/** Stops a running background run before its next check. */
export function cancelChecks(): void {
  generation += 1;
  if (timer) clearTimeout(timer);
  timer = null;
  useCheckResults.setState({ running: false, progress: null });
}

/** Whether the shown results belong to an older document state than the current one. */
export function resultsStale(): boolean {
  const state = useAssemblerStore.getState();
  return (
    state.checks.length > 0 &&
    (busy(state) || useCheckResults.getState().evaluatedFor !== state.evaluation)
  );
}

/**
 * Starts the background evaluation (once per process): the desktop and web
 * renderers through the module's `install`, tests and benches directly.
 */
export function startChecksRunner(adapter: KernelAdapter | null): void {
  kernel = adapter ?? kernel;
  if (started) return;
  started = true;
  useAssemblerStore.subscribe((state, prev) => {
    const changed =
      state.evaluation !== prev.evaluation ||
      state.checks !== prev.checks ||
      (prev.activeTool !== null && state.activeTool === null) ||
      (prev.evaluationPending && !state.evaluationPending) ||
      (prev.kernelStatus !== 'ready' && state.kernelStatus === 'ready');
    if (!changed) return;
    if (state.checks.length === 0) {
      if (prev.checks.length > 0 || Object.keys(useCheckResults.getState().results).length > 0) {
        generation += 1;
        useCheckResults.setState({ results: {}, running: false, progress: null, focusedId: null });
      }
      return;
    }
    // An edit started: a running check stops before the next one.
    if (busy(state)) {
      generation += 1;
      if (useCheckResults.getState().running) {
        useCheckResults.setState({ running: false, progress: null });
      }
      return;
    }
    scheduleChecks();
  });
  if (useAssemblerStore.getState().checks.length > 0) scheduleChecks();
}

/** Test hook: the kernel the runner uses. */
export function setChecksKernel(adapter: KernelAdapter | null): void {
  kernel = adapter;
}
