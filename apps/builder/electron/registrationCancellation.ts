/**
 * A needs-input import has a visible job before it has a sidecar registration
 * session. Cancelling in that interval is complete when the sidecar confirms
 * that there is no session (or no longer has an open project).
 */
export function registrationCancellationIsAlreadyComplete(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /registration session is unknown|no canonical project is open/i.test(message);
}

export function registrationCancellationOutcomeIsComplete(outcome: {
  readonly cancellationRequested?: boolean;
  readonly cancelledImmediately?: boolean;
}): boolean {
  return outcome.cancelledImmediately === true || outcome.cancellationRequested !== true;
}
