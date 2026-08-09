import { ProtocolNegotiationError } from './errors.js';

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonObject | readonly JsonValue[];
export interface JsonObject {
  readonly [key: string]: JsonValue;
}

export interface RpcRequestOptions {
  readonly signal?: AbortSignal;
}

export interface RpcMethodDefinition {
  readonly request: unknown;
  readonly response: unknown;
}

export interface RpcTransport<
  Methods extends { readonly [Key in keyof Methods]: RpcMethodDefinition },
> {
  request<Key extends keyof Methods & string>(
    method: Key,
    request: Methods[Key]['request'],
    options?: RpcRequestOptions,
  ): Promise<Methods[Key]['response']>;
}

export interface RemoteErrorData {
  readonly code: string;
  readonly message: string;
  readonly retryable: boolean;
  readonly details?: JsonValue;
}

export const APP_PROTOCOL_VERSION = 1 as const;

export type AppCapability =
  | 'document.read'
  | 'document.write'
  | 'journal.read'
  | 'residency.read'
  | 'io.formats.read'
  | 'io.probe'
  | 'io.import.execute'
  | 'io.export'
  | 'io.operation'
  | 'registration.import'
  | 'view.read'
  | 'view.write'
  | 'view.screenshot';

export interface ProtocolNegotiationRequest {
  readonly clientName: string;
  readonly supportedVersions: readonly number[];
  readonly requiredCapabilities: readonly AppCapability[];
  readonly optionalCapabilities: readonly AppCapability[];
}

export interface ProtocolNegotiationResponse {
  readonly selectedVersion: number;
  readonly serverName: string;
  readonly serverVersion: string;
  readonly sessionId: string;
  readonly capabilities: readonly string[];
}

export interface NegotiatedSession {
  readonly protocolVersion: typeof APP_PROTOCOL_VERSION;
  readonly serverName: string;
  readonly serverVersion: string;
  readonly sessionId: string;
  readonly capabilities: readonly string[];
}

export interface AppProtocolMethods {
  readonly 'app.negotiate': {
    readonly request: ProtocolNegotiationRequest;
    readonly response: ProtocolNegotiationResponse;
  };
}

export async function negotiateAppProtocol<
  Methods extends AppProtocolMethods & {
    readonly [Key in keyof Methods]: RpcMethodDefinition;
  },
>(
  transport: RpcTransport<Methods>,
  request: ProtocolNegotiationRequest,
  options?: RpcRequestOptions,
): Promise<NegotiatedSession> {
  validateNegotiationRequest(request);
  const response = await transport.request('app.negotiate', request, options);
  validateNegotiationResponse(response);

  if (!request.supportedVersions.includes(response.selectedVersion)) {
    throw new ProtocolNegotiationError(
      `Server selected unsupported app protocol version ${response.selectedVersion}`,
      'unsupported-version',
    );
  }
  if (response.selectedVersion !== APP_PROTOCOL_VERSION) {
    throw new ProtocolNegotiationError(
      `This client implements app protocol ${APP_PROTOCOL_VERSION}, not ${response.selectedVersion}`,
      'unsupported-version',
    );
  }

  const capabilities = new Set(response.capabilities);
  const missing = request.requiredCapabilities.filter(
    (capability) => !capabilities.has(capability),
  );
  if (missing.length > 0) {
    throw new ProtocolNegotiationError(
      `Server is missing required capabilities: ${missing.join(', ')}`,
      'missing-capability',
    );
  }

  return {
    protocolVersion: APP_PROTOCOL_VERSION,
    serverName: response.serverName,
    serverVersion: response.serverVersion,
    sessionId: response.sessionId,
    capabilities: [...response.capabilities],
  };
}

export function requireCapability(session: NegotiatedSession, capability: AppCapability): void {
  if (!session.capabilities.includes(capability)) {
    throw new ProtocolNegotiationError(
      `Negotiated session does not grant ${capability}`,
      'missing-capability',
    );
  }
}

function validateNegotiationRequest(request: ProtocolNegotiationRequest): void {
  if (request.clientName.trim().length === 0 || request.supportedVersions.length === 0) {
    throw new ProtocolNegotiationError(
      'Client name and at least one supported protocol version are required',
      'invalid-requirement',
    );
  }
  if (
    request.supportedVersions.some((version) => !Number.isSafeInteger(version) || version < 1) ||
    new Set(request.supportedVersions).size !== request.supportedVersions.length
  ) {
    throw new ProtocolNegotiationError(
      'Supported protocol versions must be unique positive integers',
      'invalid-requirement',
    );
  }
}

function validateNegotiationResponse(response: ProtocolNegotiationResponse): void {
  if (
    !Number.isSafeInteger(response.selectedVersion) ||
    response.selectedVersion < 1 ||
    response.serverName.trim().length === 0 ||
    response.serverVersion.trim().length === 0 ||
    response.sessionId.trim().length === 0 ||
    response.capabilities.some((capability) => capability.trim().length === 0) ||
    new Set(response.capabilities).size !== response.capabilities.length
  ) {
    throw new ProtocolNegotiationError(
      'Server returned a malformed negotiation response',
      'invalid-response',
    );
  }
}
