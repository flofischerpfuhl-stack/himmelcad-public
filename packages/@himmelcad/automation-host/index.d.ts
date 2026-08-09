import type {
  AgentHarnessHostTransport,
  HostHarnessRequest,
  HostHarnessResponse,
} from '@himmelcad/agent/src/transport.js';
import type { ChildProcess } from 'node:child_process';

export interface AutomationErrorPayload {
  readonly code: string;
  readonly message: string;
  readonly retryable: boolean;
  readonly details: Readonly<Record<string, unknown>>;
}

export interface AutomationRpcRouterOptions {
  readonly sidecarCall: (method: string, params: unknown) => Promise<unknown>;
  readonly viewCall?: (method: string, params: unknown) => Promise<unknown>;
  readonly confirmationCall?: (request: {
    readonly hostSessionId: string;
    readonly commandId: string;
    readonly planHash: string;
    readonly losses: readonly unknown[];
    readonly conflicts: readonly unknown[];
  }) => Promise<string>;
}

export class AutomationRpcRouter {
  constructor(options: AutomationRpcRouterOptions);
  registerConfirmationGrant(input: {
    grant: string;
    hostSessionId: string;
    commandId: string;
    planHash: string;
    expiresAt: number;
  }): void;
  revokeAll(): void;
  openConnection(): string;
  closeConnection(connectionId: string): void;
  handle(message: unknown, connectionId?: string): Promise<Readonly<Record<string, unknown>>>;
}

export interface ManagedPythonHostOptions {
  readonly runtimeRoot: string;
  readonly router: AutomationRpcRouter;
  readonly bwrapPath?: string;
  readonly maxOutputBytes?: number;
  readonly maxRpcMessageBytes?: number;
  readonly timeoutMs?: number;
}

export interface PythonRunOptions {
  readonly workspaceCapabilityId: string;
  readonly scriptRelativePath: string;
  readonly arguments?: readonly string[];
  readonly filesystem?: 'readOnly' | 'readWrite';
}

export interface ManagedProcessResult {
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: string;
  readonly stderr: string;
}

export class ManagedPythonHost {
  constructor(options: ManagedPythonHostOptions);
  registerWorkspaceCapability(capabilityId: string, directory: string): void;
  revokeWorkspaceCapability(capabilityId: string): void;
  run(options: PythonRunOptions): Promise<ManagedProcessResult>;
  cancel(): Promise<void>;
  readonly child: ChildProcess | null;
}

export interface DesktopHarnessTransportOptions {
  readonly approvedPath?: string;
  readonly adapterVersion?: string;
  readonly runtimeRoot?: string;
  readonly router?: AutomationRpcRouter;
  readonly bwrapPath?: string;
  readonly providerEgressManifest?: ProviderEgressManifest;
  readonly getAuthorization?: (
    request: ProviderAuthorizationRequest,
  ) => Promise<string | Buffer | null>;
  readonly authorizationAvailable?: (request: ProviderAuthorizationRequest) => Promise<boolean>;
}

export interface ProviderEgressManifest {
  readonly provider: 'codex';
  readonly origin: string;
  readonly requests: readonly [{ readonly method: 'POST'; readonly path: '/v1/responses' }];
  readonly redirects: 'deny';
  readonly websockets: 'deny';
}

export interface ProviderAuthorizationRequest {
  readonly provider: 'codex';
  readonly origin: string;
  readonly sessionId: string;
  readonly signal: AbortSignal;
}

export class DesktopAgentHarnessHostTransport implements AgentHarnessHostTransport {
  constructor(options?: DesktopHarnessTransportOptions);
  registerWorkspaceCapability(capabilityId: string, directory: string): void;
  revokeWorkspaceCapability(capabilityId: string): void;
  request(request: HostHarnessRequest): Promise<HostHarnessResponse>;
  subscribe(sessionId: string, onPayload: (payload: unknown) => void): () => void;
  invalidateSessions(): Promise<void>;
  close(): Promise<void>;
}

export function normalizeAutomationError(error: unknown): AutomationErrorPayload;
