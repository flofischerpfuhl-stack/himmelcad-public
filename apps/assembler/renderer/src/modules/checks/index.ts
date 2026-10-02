/** Public surface of the checks module for tests and products. */
export { checksModule } from './module.js';
export { CHECKS_API, resultJson } from './api.js';
export { useCheckResults, type CheckResultsState, type ChecksSlice } from './checksStore.js';
export { BODY_COUNT_CHECK } from './kinds.js';
export {
  activeFeaturesOf,
  bodyNamer,
  cancelChecks,
  CHECK_BUDGET_MS,
  CHECKS_DEBOUNCE_MS,
  resultsStale,
  runChecksNow,
  scheduleChecks,
  setChecksKernel,
  startChecksRunner,
} from './runner.js';
