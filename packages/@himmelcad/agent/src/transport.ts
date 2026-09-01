import type { HarnessProvider } from './events.js';

export type HarnessTransportMode =
  | 'codexAppServer'
  | 'codexExecJson'
  | 'claudeJson'
  | 'openCodeJson';

export interface HarnessExecutableIdentity {
  provider: HarnessProvider;
  executableId: string;
  canonicalExecutableHash: string;
  version: string;
  adapterVersion: string;
  capabilities: readonly string[];
  appServerSchema?: { version: string; hash: string };
}

export interface HarnessSecurityScope {
  workspaceCapabilityId: string;
  filesystem: 'readOnly' | 'readWrite';
  network: 'disabled' | 'providerOnly';
  destructiveCommands: 'productApprovalRequired';
}

export type HostHarnessRequest =
  | {
      kind: 'discover';
      provider: HarnessProvider;
      executableNames: readonly string[];
      versionArgs: readonly string[];
      timeoutMs: number;
      maxOutputBytes: number;
    }
  | {
      kind: 'openSession';
      identity: HarnessExecutableIdentity;
      mode: HarnessTransportMode;
      scope: HarnessSecurityScope;
      systemPrompt: string;
      experimentalApi: boolean;
      initialization?: readonly HostProtocolMessage[];
    }
  | { kind: 'sendTurn'; sessionId: string; turnId: string; prompt: string }
  | { kind: 'interrupt'; sessionId: string; turnId?: string }
  | { kind: 'resume'; sessionId: string; turnId?: string }
  | {
      kind: 'approval';
      sessionId: string;
      requestId: string;
      decision: 'approved' | 'denied';
    }
  | { kind: 'closeSession'; sessionId: string };

export interface HostProtocolMessage {
  kind: 'request' | 'notification';
  method: string;
  params?: Readonly<Record<string, unknown>>;
}

export type HostHarnessResponse =
  | { kind: 'notConfigured'; detail: string }
  | { kind: 'missing'; detail: string }
  | { kind: 'incompatible'; detail: string; version?: string }
  | { kind: 'discovered'; identity: HarnessExecutableIdentity }
  | {
      kind: 'sessionOpened';
      hostSessionId: string;
      providerThreadId: string;
      boundAppServerSchema?: { version: string; hash: string };
    }
  | { kind: 'accepted' };

/** Implemented by the desktop host. This package never spawns a process or opens a socket. */
export interface AgentHarnessHostTransport {
  request(request: HostHarnessRequest): Promise<HostHarnessResponse>;
  subscribe(sessionId: string, onPayload: (payload: unknown) => void): () => void;
  subscribeProductApprovals?(
    onRequest: (request: ProductAutomationApprovalRequest) => void,
  ): () => void;
  respondProductApproval?(requestId: string, decision: 'approved' | 'denied'): Promise<void>;
}

export interface ProductAutomationApprovalRequest {
  readonly requestId: string;
  readonly commandId: string;
  readonly losses: readonly unknown[];
  readonly conflicts: readonly unknown[];
}
