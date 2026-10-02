/**
 * The checks module's runner for the document-checks hook
 * (`foundation/commands/documentChecks.ts`, MODULES.md §3 "Document
 * checks"): other modules — the parameter sweep (`parameters.sweep`, Test
 * range) — run the document's stored checks on a state that is not the
 * committed document, without importing this module.
 *
 * It evaluates the **enabled** stored checks of the current document with
 * `runChecks` against the given sample (its evaluation, its active
 * features, the given kernel for exact queries), fresh (no reuse of the
 * background results, which belong to the committed document), each kernel
 * or worker check within {@link CHECK_BUDGET_MS}, and stops before the next
 * check once `signal.aborted`. It never changes the document, the selection
 * or the results the Checks panel shows. A check kind this build does not
 * know is an `error` (as in `checks.run`, where it counts against `passed`).
 */
import { runChecks, type CheckResult } from '../../foundation/commands/checks.js';
import type {
  DocumentCheckInput,
  DocumentCheckResult,
  DocumentCheckRunner,
} from '../../foundation/commands/documentChecks.js';
import { useAssemblerStore } from '../../foundation/commands/store.js';
import { bodyNamer, CHECK_BUDGET_MS } from './runner.js';

function documentResult(result: CheckResult): DocumentCheckResult {
  const outcome = result.outcome;
  const status = result.state === 'pass' || result.state === 'fail' ? result.state : 'error';
  return {
    checkId: result.id,
    name: result.name,
    status,
    ...(status !== 'pass' && outcome?.message ? { message: outcome.message } : {}),
    ...(typeof outcome?.value === 'number' ? { measured: outcome.value } : {}),
    ...(outcome?.unit !== undefined ? { unit: outcome.unit } : {}),
  };
}

export const CHECKS_DOCUMENT_RUNNER: DocumentCheckRunner = {
  module: 'checks',
  async run(input: DocumentCheckInput): Promise<DocumentCheckResult[]> {
    const enabled = useAssemblerStore.getState().checks.filter((c) => c.enabled !== false);
    if (enabled.length === 0) return [];
    const results = await runChecks(enabled, {
      evaluation: input.evaluation,
      features: input.features,
      kernel: input.kernel && input.kernel.status.status === 'ready' ? input.kernel : null,
      bodyName: bodyNamer(input.evaluation),
      cancelled: () => input.signal.aborted,
      budgetMs: CHECK_BUDGET_MS,
    });
    return results.map(documentResult);
  },
};
