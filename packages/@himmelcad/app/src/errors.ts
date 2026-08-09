import type { JsonValue, RemoteErrorData } from './protocol.js';

export class AppFacadeError extends Error {
  override readonly name: string = 'AppFacadeError';
}

export class ProtocolNegotiationError extends AppFacadeError {
  override readonly name = 'ProtocolNegotiationError';

  constructor(
    message: string,
    readonly reason:
      | 'invalid-response'
      | 'unsupported-version'
      | 'missing-capability'
      | 'invalid-requirement',
  ) {
    super(message);
  }
}

export class ContractValidationError extends AppFacadeError {
  override readonly name = 'ContractValidationError';

  constructor(
    message: string,
    readonly path: string,
  ) {
    super(`${path}: ${message}`);
  }
}

export class RemoteRpcError extends AppFacadeError {
  override readonly name: string = 'RemoteRpcError';

  constructor(
    readonly code: string,
    message: string,
    readonly retryable: boolean,
    readonly details?: JsonValue,
  ) {
    super(message);
  }
}

export interface RevisionConflictDetails {
  readonly entityId?: string;
  readonly expectedRevision?: number;
  readonly actualRevision?: number;
  readonly expectedVersionHash?: string;
  readonly actualVersionHash?: string;
}

export class RevisionConflictError extends RemoteRpcError {
  override readonly name = 'RevisionConflictError';

  constructor(
    code: string,
    message: string,
    readonly conflict: RevisionConflictDetails,
    details?: JsonValue,
  ) {
    super(code, message, false, details);
  }
}

export function createRemoteError(error: RemoteErrorData): RemoteRpcError {
  if (!isRevisionConflictCode(error.code)) {
    return new RemoteRpcError(error.code, error.message, error.retryable, error.details);
  }

  const details = isRecord(error.details) ? error.details : {};
  return new RevisionConflictError(
    error.code,
    error.message,
    {
      ...optionalString(details, 'entityId'),
      ...optionalSafeInteger(details, 'expectedRevision'),
      ...optionalSafeInteger(details, 'actualRevision'),
      ...optionalString(details, 'expectedVersionHash'),
      ...optionalString(details, 'actualVersionHash'),
    },
    error.details,
  );
}

function isRevisionConflictCode(code: string): boolean {
  return (
    code === 'revision_conflict' ||
    code === 'hcad.app.document.conflict' ||
    code.endsWith('version_conflict')
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function optionalString(
  value: Record<string, unknown>,
  key: keyof RevisionConflictDetails,
): Partial<RevisionConflictDetails> {
  const candidate = value[key];
  return typeof candidate === 'string' ? { [key]: candidate } : {};
}

function optionalSafeInteger(
  value: Record<string, unknown>,
  key: keyof RevisionConflictDetails,
): Partial<RevisionConflictDetails> {
  const candidate = value[key];
  return Number.isSafeInteger(candidate) && Number(candidate) >= 0 ? { [key]: candidate } : {};
}
