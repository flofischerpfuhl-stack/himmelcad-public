import type { NormalizedAgentEvent, HarnessProvider } from '../../events.js';
import type { BoundedDiagnosticLog, BoundedQueue } from '../../queue.js';
import type {
  AgentHarnessHostTransport,
  HarnessExecutableIdentity,
  HarnessSecurityScope,
} from '../../transport.js';

/**
 * Adapted from T3 Code ProviderDriver/ProviderAdapter at v0.0.24.
 * Effect/database/project authority was intentionally removed.
 */
export interface AgentHarnessDriver {
  provider: HarnessProvider;
  displayName: string;
  adapterVersion: string;
  discover(transport: AgentHarnessHostTransport): Promise<HarnessDiscovery>;
  create(input: {
    transport: AgentHarnessHostTransport;
    identity: HarnessExecutableIdentity;
    scope: HarnessSecurityScope;
    experimentalApi?: boolean;
  }): AgentHarnessAdapter;
}

export type HarnessDiscovery =
  | { state: 'available'; identity: HarnessExecutableIdentity }
  | {
      state: 'notConfigured' | 'missing' | 'incompatible';
      provider: HarnessProvider;
      detail: string;
      version?: string;
    };

export interface AgentHarnessAdapter {
  readonly identity: HarnessExecutableIdentity;
  readonly mode: string;
  readonly diagnostics: BoundedDiagnosticLog;
  readonly events: BoundedQueue<NormalizedAgentEvent>;
  startThread(input: { systemPrompt: string }): Promise<{ threadId: string }>;
  sendTurn(input: { threadId: string; turnId: string; prompt: string }): Promise<void>;
  interrupt(input: { threadId: string; turnId?: string }): Promise<void>;
  resume(input: { threadId: string; turnId?: string }): Promise<void>;
  respondToApproval(input: {
    threadId: string;
    requestId: string;
    decision: 'approved' | 'denied';
  }): Promise<void>;
  stop(threadId: string): Promise<void>;
  subscribe(threadId: string, listener: (event: NormalizedAgentEvent) => void): () => void;
}
