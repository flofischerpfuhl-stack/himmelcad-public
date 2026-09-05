"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.RevisionConflictError = exports.RemoteRpcError = exports.ContractValidationError = exports.ProtocolNegotiationError = exports.AppFacadeError = void 0;
exports.createRemoteError = createRemoteError;
class AppFacadeError extends Error {
    name = 'AppFacadeError';
}
exports.AppFacadeError = AppFacadeError;
class ProtocolNegotiationError extends AppFacadeError {
    reason;
    name = 'ProtocolNegotiationError';
    constructor(message, reason) {
        super(message);
        this.reason = reason;
    }
}
exports.ProtocolNegotiationError = ProtocolNegotiationError;
class ContractValidationError extends AppFacadeError {
    path;
    name = 'ContractValidationError';
    constructor(message, path) {
        super(`${path}: ${message}`);
        this.path = path;
    }
}
exports.ContractValidationError = ContractValidationError;
class RemoteRpcError extends AppFacadeError {
    code;
    retryable;
    details;
    name = 'RemoteRpcError';
    constructor(code, message, retryable, details) {
        super(message);
        this.code = code;
        this.retryable = retryable;
        this.details = details;
    }
}
exports.RemoteRpcError = RemoteRpcError;
class RevisionConflictError extends RemoteRpcError {
    conflict;
    name = 'RevisionConflictError';
    constructor(code, message, conflict, details) {
        super(code, message, false, details);
        this.conflict = conflict;
    }
}
exports.RevisionConflictError = RevisionConflictError;
function createRemoteError(error) {
    if (!isRevisionConflictCode(error.code)) {
        return new RemoteRpcError(error.code, error.message, error.retryable, error.details);
    }
    const details = isRecord(error.details) ? error.details : {};
    return new RevisionConflictError(error.code, error.message, {
        ...optionalString(details, 'entityId'),
        ...optionalSafeInteger(details, 'expectedRevision'),
        ...optionalSafeInteger(details, 'actualRevision'),
        ...optionalString(details, 'expectedVersionHash'),
        ...optionalString(details, 'actualVersionHash'),
    }, error.details);
}
function isRevisionConflictCode(code) {
    return (code === 'revision_conflict' ||
        code === 'hcad.app.document.conflict' ||
        code.endsWith('version_conflict'));
}
function isRecord(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function optionalString(value, key) {
    const candidate = value[key];
    return typeof candidate === 'string' ? { [key]: candidate } : {};
}
function optionalSafeInteger(value, key) {
    const candidate = value[key];
    return Number.isSafeInteger(candidate) && Number(candidate) >= 0 ? { [key]: candidate } : {};
}
//# sourceMappingURL=errors.js.map