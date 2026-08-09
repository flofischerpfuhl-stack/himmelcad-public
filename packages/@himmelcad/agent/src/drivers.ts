import type { HarnessProvider, NormalizedAgentEvent } from './events.js';
import { validateNormalizedAgentEvent } from './events.js';
import { PROVIDER_EVENT_NORMALIZERS } from './normalize.js';
import { BoundedDiagnosticLog, BoundedQueue, redactSensitiveText } from './queue.js';
import type {
  AgentHarnessHostTransport,
  HarnessExecutableIdentity,
  HarnessSecurityScope,
  HarnessTransportMode,
  HostHarnessRequest,
  HostHarnessResponse,
  HostProtocolMessage,
} from './transport.js';
import type {
  AgentHarnessAdapter,
  AgentHarnessDriver,
  HarnessDiscovery,
} from './vendor/t3code/providerShape.js';

const ADAPTER_VERSION = 'himmelcad-agent-adapter-v1';
const DISCOVERY_TIMEOUT_MS = 2_000;
const DISCOVERY_OUTPUT_BYTES = 64 * 1024;

const DRIVER_CONFIG: Readonly<
  Record<
    HarnessProvider,
    { displayName: string; executables: readonly string[]; versionArgs: readonly string[] }
  >
> = {
  codex: { displayName: 'Codex', executables: ['codex'], versionArgs: ['--version'] },
  claude: { displayName: 'Claude', executables: ['claude'], versionArgs: ['--version'] },
  opencode: { displayName: 'OpenCode', executables: ['opencode'], versionArgs: ['--version'] },
};

export const AGENT_HARNESS_DRIVERS: readonly AgentHarnessDriver[] = (
  ['codex', 'claude', 'opencode'] as const
).map(makeDriver);

export async function discoverHarnesses(
  transport: AgentHarnessHostTransport,
): Promise<readonly HarnessDiscovery[]> {
  return await Promise.all(AGENT_HARNESS_DRIVERS.map((driver) => driver.discover(transport)));
}

export function findHarnessDriver(provider: HarnessProvider): AgentHarnessDriver {
  return AGENT_HARNESS_DRIVERS.find((driver) => driver.provider === provider)!;
}

function makeDriver(provider: HarnessProvider): AgentHarnessDriver {
  const config = DRIVER_CONFIG[provider];
  return {
    provider,
    displayName: config.displayName,
    adapterVersion: ADAPTER_VERSION,
    discover: async (transport) => {
      const response = await transport.request({
        kind: 'discover',
        provider,
        executableNames: config.executables,
        versionArgs: config.versionArgs,
        timeoutMs: DISCOVERY_TIMEOUT_MS,
        maxOutputBytes: DISCOVERY_OUTPUT_BYTES,
      });
      if (response.kind === 'discovered') {
        const issue = identityCompatibilityIssue(response.identity, provider);
        if (issue) return { state: 'incompatible', provider, detail: issue };
        return { state: 'available', identity: freezeIdentity(response.identity) };
      }
      if (response.kind === 'missing' || response.kind === 'incompatible') {
        return {
          state: response.kind,
          provider,
          detail: redactSensitiveText(response.detail),
          ...('version' in response && response.version ? { version: response.version } : {}),
        };
      }
      return { state: 'incompatible', provider, detail: 'Unexpected discovery response.' };
    },
    create: ({ transport, identity, scope, experimentalApi = false }) =>
      new TransportHarnessAdapter(transport, identity, scope, experimentalApi),
  };
}

class TransportHarnessAdapter implements AgentHarnessAdapter {
  readonly identity: HarnessExecutableIdentity;
  readonly mode: HarnessTransportMode;
  readonly #transport: AgentHarnessHostTransport;
  readonly #scope: HarnessSecurityScope;
  readonly #experimentalApi: boolean;
  readonly #sessions = new Map<string, string>();
  readonly #listeners = new Map<string, Set<(event: NormalizedAgentEvent) => void>>();
  readonly #unsubscribe = new Map<string, () => void>();
  readonly diagnostics = new BoundedDiagnosticLog();
  readonly events = new BoundedQueue<NormalizedAgentEvent>({
    maxItems: 4_096,
    maxBytes: 8 * 1024 * 1024,
    maxItemBytes: 256 * 1024,
  });
  #sequence = 0;

  constructor(
    transport: AgentHarnessHostTransport,
    identity: HarnessExecutableIdentity,
    scope: HarnessSecurityScope,
    experimentalApi: boolean,
  ) {
    this.#transport = transport;
    const issue = identityCompatibilityIssue(identity, identity.provider);
    if (issue) throw new Error(issue);
    this.identity = freezeIdentity(identity);
    this.#scope = Object.freeze({ ...scope });
    if (experimentalApi && !identity.capabilities.includes('codexExperimentalApi')) {
      throw new Error('Experimental Codex API was not capability-probed.');
    }
    this.#experimentalApi = experimentalApi;
    this.mode = selectTransportMode(identity);
  }

  async startThread(input: { systemPrompt: string }): Promise<{ threadId: string }> {
    if (!input.systemPrompt.trim() || input.systemPrompt.length > 64 * 1024) {
      throw new Error('Agent system prompt is empty or exceeds 64 KiB.');
    }
    const response = await this.#transport.request({
      kind: 'openSession',
      identity: this.identity,
      mode: this.mode,
      scope: this.#scope,
      systemPrompt: input.systemPrompt,
      experimentalApi: this.#experimentalApi,
      ...(this.mode === 'codexAppServer'
        ? { initialization: codexInitialization(this.identity) }
        : {}),
    });
    if (response.kind !== 'sessionOpened') throw new Error(responseDetail(response));
    const { hostSessionId, providerThreadId: threadId } = response;
    if (!validHostIdentifier(hostSessionId) || !validHostIdentifier(threadId)) {
      if (validHostIdentifier(hostSessionId)) await this.#closeOpenedSession(hostSessionId);
      throw new Error('Host did not bind a valid provider thread.');
    }
    if (
      this.mode === 'codexAppServer' &&
      !sameSchema(response.boundAppServerSchema, this.identity.appServerSchema)
    ) {
      await this.#closeOpenedSession(hostSessionId);
      throw new Error('Codex app-server schema changed after discovery; refusing session.');
    }
    if (this.#sessions.has(threadId)) {
      await this.#closeOpenedSession(hostSessionId);
      throw new Error('Host returned an already-bound provider thread.');
    }
    this.#sessions.set(threadId, hostSessionId);
    return { threadId };
  }

  async sendTurn(input: { threadId: string; turnId: string; prompt: string }): Promise<void> {
    await this.#accepted({
      kind: 'sendTurn',
      sessionId: this.#session(input.threadId),
      turnId: input.turnId,
      prompt: input.prompt,
    });
  }

  async interrupt(input: { threadId: string; turnId?: string }): Promise<void> {
    await this.#accepted({
      kind: 'interrupt',
      sessionId: this.#session(input.threadId),
      ...(input.turnId ? { turnId: input.turnId } : {}),
    });
  }

  async resume(input: { threadId: string; turnId?: string }): Promise<void> {
    await this.#accepted({
      kind: 'resume',
      sessionId: this.#session(input.threadId),
      ...(input.turnId ? { turnId: input.turnId } : {}),
    });
  }

  async respondToApproval(input: {
    threadId: string;
    requestId: string;
    decision: 'approved' | 'denied';
  }): Promise<void> {
    await this.#accepted({
      kind: 'approval',
      sessionId: this.#session(input.threadId),
      requestId: input.requestId,
      decision: input.decision,
    });
  }

  async stop(threadId: string): Promise<void> {
    const sessionId = this.#session(threadId);
    try {
      await this.#accepted({ kind: 'closeSession', sessionId });
    } finally {
      this.#detachSubscription(threadId);
      this.#sessions.delete(threadId);
    }
  }

  subscribe(threadId: string, listener: (event: NormalizedAgentEvent) => void): () => void {
    const sessionId = this.#session(threadId);
    let listeners = this.#listeners.get(threadId);
    if (!listeners) {
      listeners = new Set([listener]);
      this.#listeners.set(threadId, listeners);
      try {
        let active = true;
        const unsubscribeHost = this.#transport.subscribe(sessionId, (payload) => {
          if (!active) return;
          const receivedAt = new Date().toISOString();
          this.diagnostics.push({ provider: this.identity.provider, receivedAt, payload });
          try {
            const event = PROVIDER_EVENT_NORMALIZERS[this.identity.provider](payload, {
              threadId,
              nextSequence: () => this.#sequence++,
              now: () => new Date().toISOString(),
            });
            if (!event) return;
            validateNormalizedAgentEvent(event);
            if (!this.events.push(event)) return;
            for (const subscriber of this.#listeners.get(threadId) ?? []) {
              try {
                subscriber(event);
              } catch (error) {
                this.diagnostics.push({
                  provider: this.identity.provider,
                  receivedAt: new Date().toISOString(),
                  payload: { kind: 'subscriberError', error },
                });
              }
            }
          } catch (error) {
            this.diagnostics.push({
              provider: this.identity.provider,
              receivedAt: new Date().toISOString(),
              payload: { kind: 'normalizationError', error },
            });
          }
        });
        this.#unsubscribe.set(threadId, () => {
          active = false;
          unsubscribeHost();
        });
      } catch (error) {
        this.#listeners.delete(threadId);
        throw error;
      }
    } else {
      listeners.add(listener);
    }
    let attached = true;
    return () => {
      if (!attached) return;
      attached = false;
      listeners?.delete(listener);
      if (listeners?.size === 0) this.#detachSubscription(threadId);
    };
  }

  async #accepted(request: HostHarnessRequest): Promise<void> {
    const response = await this.#transport.request(request);
    if (response.kind !== 'accepted') throw new Error(responseDetail(response));
  }

  #session(threadId: string): string {
    const session = this.#sessions.get(threadId);
    if (!session) throw new Error(`Unknown harness thread: ${threadId}`);
    return session;
  }

  #detachSubscription(threadId: string): void {
    try {
      this.#unsubscribe.get(threadId)?.();
    } catch (error) {
      this.diagnostics.push({
        provider: this.identity.provider,
        receivedAt: new Date().toISOString(),
        payload: { kind: 'unsubscribeError', error },
      });
    } finally {
      this.#unsubscribe.delete(threadId);
      this.#listeners.delete(threadId);
    }
  }

  async #closeOpenedSession(sessionId: string): Promise<void> {
    try {
      await this.#transport.request({ kind: 'closeSession', sessionId });
    } catch {
      // The host owns process cleanup and must also reap sessions if its reply fails.
    }
  }
}

function selectTransportMode(identity: HarnessExecutableIdentity): HarnessTransportMode {
  if (identity.provider === 'codex') {
    if (
      identity.capabilities.includes('codexAppServer') &&
      identity.appServerSchema?.version &&
      /^[a-f0-9]{64}$/i.test(identity.appServerSchema.hash)
    ) {
      return 'codexAppServer';
    }
    if (identity.capabilities.includes('codexExecJson')) return 'codexExecJson';
    throw new Error('Codex supports neither a bound app-server schema nor codex exec --json.');
  }
  return identity.provider === 'claude' ? 'claudeJson' : 'openCodeJson';
}

function codexInitialization(identity: HarnessExecutableIdentity): readonly HostProtocolMessage[] {
  if (!identity.appServerSchema) throw new Error('Codex app-server schema is not bound.');
  return [
    {
      kind: 'request',
      method: 'initialize',
      params: {
        clientInfo: { name: 'himmelcad', title: 'HimmelCAD', version: ADAPTER_VERSION },
      },
    },
    { kind: 'notification', method: 'initialized' },
  ];
}

function sameSchema(
  left: { version: string; hash: string } | undefined,
  right: { version: string; hash: string } | undefined,
): boolean {
  return Boolean(left && right && left.version === right.version && left.hash === right.hash);
}

function responseDetail(response: HostHarnessResponse): string {
  return 'detail' in response
    ? redactSensitiveText(response.detail)
    : `Unexpected host response: ${response.kind}`;
}

function validHostIdentifier(value: string): boolean {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= 512;
}

function identityCompatibilityIssue(
  identity: HarnessExecutableIdentity,
  provider: HarnessProvider,
): string | null {
  if (
    identity.provider !== provider ||
    identity.adapterVersion !== ADAPTER_VERSION ||
    !identity.executableId ||
    !identity.version ||
    !/^[a-f0-9]{64}$/i.test(identity.canonicalExecutableHash)
  ) {
    return 'Host returned an invalid or mismatched executable identity.';
  }
  if (provider === 'codex') {
    const appServerBound =
      identity.capabilities.includes('codexAppServer') &&
      Boolean(identity.appServerSchema?.version) &&
      /^[a-f0-9]{64}$/i.test(identity.appServerSchema?.hash ?? '');
    return appServerBound || identity.capabilities.includes('codexExecJson')
      ? null
      : 'Codex has no compatible app-server schema or exec-json fallback.';
  }
  const capability = provider === 'claude' ? 'claudeJson' : 'openCodeJson';
  return identity.capabilities.includes(capability)
    ? null
    : `${DRIVER_CONFIG[provider].displayName} does not expose ${capability}.`;
}

function freezeIdentity(identity: HarnessExecutableIdentity): HarnessExecutableIdentity {
  const capabilities = Object.freeze([...identity.capabilities]);
  const appServerSchema = identity.appServerSchema
    ? Object.freeze({ ...identity.appServerSchema })
    : undefined;
  return Object.freeze({
    ...identity,
    capabilities,
    ...(appServerSchema ? { appServerSchema } : {}),
  });
}
