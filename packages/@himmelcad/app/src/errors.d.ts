import type { JsonValue, RemoteErrorData } from './protocol.js';
export declare class AppFacadeError extends Error {
    readonly name: string;
}
export declare class ProtocolNegotiationError extends AppFacadeError {
    readonly reason: 'invalid-response' | 'unsupported-version' | 'missing-capability' | 'invalid-requirement';
    readonly name = "ProtocolNegotiationError";
    constructor(message: string, reason: 'invalid-response' | 'unsupported-version' | 'missing-capability' | 'invalid-requirement');
}
export declare class ContractValidationError extends AppFacadeError {
    readonly path: string;
    readonly name = "ContractValidationError";
    constructor(message: string, path: string);
}
export declare class RemoteRpcError extends AppFacadeError {
    readonly code: string;
    readonly retryable: boolean;
    readonly details?: JsonValue | undefined;
    readonly name: string;
    constructor(code: string, message: string, retryable: boolean, details?: JsonValue | undefined);
}
export interface RevisionConflictDetails {
    readonly entityId?: string;
    readonly expectedRevision?: number;
    readonly actualRevision?: number;
    readonly expectedVersionHash?: string;
    readonly actualVersionHash?: string;
}
export declare class RevisionConflictError extends RemoteRpcError {
    readonly conflict: RevisionConflictDetails;
    readonly name = "RevisionConflictError";
    constructor(code: string, message: string, conflict: RevisionConflictDetails, details?: JsonValue);
}
export declare function createRemoteError(error: RemoteErrorData): RemoteRpcError;
//# sourceMappingURL=errors.d.ts.map