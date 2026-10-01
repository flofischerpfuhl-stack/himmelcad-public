/**
 * Structured errors of the canonical Assembler command/query contract
 * (`hcasm.agent-api@1`). Every failure an agent, the Python SDK or the UI
 * bridge can see has a stable `code`, a human-readable `message`, and —
 * wherever the fix is predictable — a `hint` and machine-usable `details`
 * (for example the candidate reference keys when a key is unknown).
 *
 * The codes deliberately reuse the vocabulary of the existing HimmelCAD
 * automation contract (ADR 0024: `invalidRequest`, `conflict`,
 * `permissionDenied`, `confirmationRequired`, `cancelled`, `internal`) and
 * add the CAD-specific ones below.
 */

export const API_ERROR_CODES = [
  /** Malformed JSON-RPC, unknown method, or params that violate the method's schema. */
  'invalidRequest',
  /** Unknown method name. */
  'methodNotFound',
  /** The params are well-formed but a value is out of range / inconsistent. */
  'invalidParams',
  /** A feature, body, face, edge or sketch profile does not exist. */
  'notFound',
  /** A face/edge reference key or selector does not resolve. `details.candidates` lists valid keys. */
  'referenceNotFound',
  /** The kernel rejected the resulting feature; nothing was committed. `details.featureError`. */
  'featureFailed',
  /**
   * The sketch solver rejected a sketch edit (conflicting/redundant constraints or dimensions,
   * collapsing geometry, invalid expression); nothing was committed. `details.conflicting` /
   * `details.redundant` list the constraint/dimension ids involved.
   */
  'sketchConflict',
  /** `expectedRevision` does not match, or the document changed under an open transaction. */
  'conflict',
  /** A UI tool session is active or the kernel is still loading; retry later. */
  'busy',
  /** A transaction is required / already open / not open. */
  'transactionState',
  /** The capability is not granted to this session (e.g. file paths over the in-app endpoint). */
  'permissionDenied',
  /** The command would discard unsaved user work; it needs the user's approval in the app. */
  'confirmationRequired',
  /** Recognised but not supported by the current model. */
  'unsupported',
  /**
   * The CAD kernel did not finish within its time budget (an OCCT operation that does not
   * return); it was stopped and restarted, nothing was committed. `details.budgetMs`.
   */
  'kernelTimeout',
  /** The operation was cancelled. */
  'cancelled',
  /** The CAD kernel failed or an unexpected error occurred. */
  'internal',
] as const;

export type ApiErrorCode = (typeof API_ERROR_CODES)[number];

export interface ApiErrorPayload {
  code: ApiErrorCode;
  message: string;
  hint?: string;
  details?: Record<string, unknown>;
}

export class ApiError extends Error {
  readonly code: ApiErrorCode;
  readonly hint: string | undefined;
  readonly details: Record<string, unknown> | undefined;

  constructor(
    code: ApiErrorCode,
    message: string,
    extra: { hint?: string; details?: Record<string, unknown> } = {},
  ) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.hint = extra.hint;
    this.details = extra.details;
  }

  toPayload(): ApiErrorPayload {
    return {
      code: this.code,
      message: this.message,
      ...(this.hint !== undefined ? { hint: this.hint } : {}),
      ...(this.details !== undefined ? { details: this.details } : {}),
    };
  }
}

/** Normalises anything thrown by a handler into a contract error payload. */
export function toErrorPayload(error: unknown): ApiErrorPayload {
  if (error instanceof ApiError) return error.toPayload();
  const message = error instanceof Error ? error.message : String(error);
  return { code: 'internal', message };
}

/** JSON-RPC 2.0 numeric error codes carrying a contract error in `data`. */
export const JSON_RPC_ERROR: Record<ApiErrorCode, number> = {
  invalidRequest: -32600,
  methodNotFound: -32601,
  invalidParams: -32602,
  internal: -32603,
  notFound: -32004,
  referenceNotFound: -32005,
  featureFailed: -32010,
  sketchConflict: -32015,
  conflict: -32009,
  busy: -32011,
  transactionState: -32012,
  permissionDenied: -32003,
  confirmationRequired: -32013,
  unsupported: -32014,
  kernelTimeout: -32016,
  cancelled: -32800,
};
