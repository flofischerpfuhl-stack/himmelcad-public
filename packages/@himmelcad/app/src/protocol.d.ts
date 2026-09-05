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
export interface RpcTransport<Methods extends {
    readonly [Key in keyof Methods]: RpcMethodDefinition;
}> {
    request<Key extends keyof Methods & string>(method: Key, request: Methods[Key]['request'], options?: RpcRequestOptions): Promise<Methods[Key]['response']>;
}
export interface RemoteErrorData {
    readonly code: string;
    readonly message: string;
    readonly retryable: boolean;
    readonly details?: JsonValue;
}
export declare const APP_PROTOCOL_VERSION: 1;
export type AppCapability = 'document.read' | 'document.write' | 'journal.read' | 'residency.read' | 'io.formats.read' | 'io.probe' | 'io.import.execute' | 'io.export' | 'io.operation' | 'registration.import' | 'view.read' | 'view.write' | 'view.screenshot';
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
export declare function negotiateAppProtocol<Methods extends AppProtocolMethods & {
    readonly [Key in keyof Methods]: RpcMethodDefinition;
}>(transport: RpcTransport<Methods>, request: ProtocolNegotiationRequest, options?: RpcRequestOptions): Promise<NegotiatedSession>;
export declare function requireCapability(session: NegotiatedSession, capability: AppCapability): void;
//# sourceMappingURL=protocol.d.ts.map