"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.APP_PROTOCOL_VERSION = void 0;
exports.negotiateAppProtocol = negotiateAppProtocol;
exports.requireCapability = requireCapability;
const errors_js_1 = require("./errors.js");
exports.APP_PROTOCOL_VERSION = 1;
async function negotiateAppProtocol(transport, request, options) {
    validateNegotiationRequest(request);
    const response = await transport.request('app.negotiate', request, options);
    validateNegotiationResponse(response);
    if (!request.supportedVersions.includes(response.selectedVersion)) {
        throw new errors_js_1.ProtocolNegotiationError(`Server selected unsupported app protocol version ${response.selectedVersion}`, 'unsupported-version');
    }
    if (response.selectedVersion !== exports.APP_PROTOCOL_VERSION) {
        throw new errors_js_1.ProtocolNegotiationError(`This client implements app protocol ${exports.APP_PROTOCOL_VERSION}, not ${response.selectedVersion}`, 'unsupported-version');
    }
    const capabilities = new Set(response.capabilities);
    const missing = request.requiredCapabilities.filter((capability) => !capabilities.has(capability));
    if (missing.length > 0) {
        throw new errors_js_1.ProtocolNegotiationError(`Server is missing required capabilities: ${missing.join(', ')}`, 'missing-capability');
    }
    return {
        protocolVersion: exports.APP_PROTOCOL_VERSION,
        serverName: response.serverName,
        serverVersion: response.serverVersion,
        sessionId: response.sessionId,
        capabilities: [...response.capabilities],
    };
}
function requireCapability(session, capability) {
    if (!session.capabilities.includes(capability)) {
        throw new errors_js_1.ProtocolNegotiationError(`Negotiated session does not grant ${capability}`, 'missing-capability');
    }
}
function validateNegotiationRequest(request) {
    if (request.clientName.trim().length === 0 || request.supportedVersions.length === 0) {
        throw new errors_js_1.ProtocolNegotiationError('Client name and at least one supported protocol version are required', 'invalid-requirement');
    }
    if (request.supportedVersions.some((version) => !Number.isSafeInteger(version) || version < 1) ||
        new Set(request.supportedVersions).size !== request.supportedVersions.length) {
        throw new errors_js_1.ProtocolNegotiationError('Supported protocol versions must be unique positive integers', 'invalid-requirement');
    }
}
function validateNegotiationResponse(response) {
    if (!Number.isSafeInteger(response.selectedVersion) ||
        response.selectedVersion < 1 ||
        response.serverName.trim().length === 0 ||
        response.serverVersion.trim().length === 0 ||
        response.sessionId.trim().length === 0 ||
        response.capabilities.some((capability) => capability.trim().length === 0) ||
        new Set(response.capabilities).size !== response.capabilities.length) {
        throw new errors_js_1.ProtocolNegotiationError('Server returned a malformed negotiation response', 'invalid-response');
    }
}
//# sourceMappingURL=protocol.js.map