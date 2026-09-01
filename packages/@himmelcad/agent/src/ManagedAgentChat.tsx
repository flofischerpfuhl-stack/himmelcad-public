import { useEffect, useRef, useState, type JSX } from 'react';

import { AgentChatPanel } from './AgentChatPanel.js';
import { ProviderCredentialControl } from './ProviderCredentialControl.js';
import { discoverHarnesses, findHarnessDriver } from './drivers.js';
import { agentEvent, type HarnessProvider, type NormalizedAgentEvent } from './events.js';
import { buildAgentSystemPrompt } from './systemPrompt.js';
import type { AgentHarnessHostTransport } from './transport.js';
import type {
  ProviderCredentialRendererTransport,
  ProviderCredentialStatus,
} from './providerCredentials.js';
import { providerNetworkMode } from './providerCredentials.js';
import type { AgentHarnessAdapter, HarnessDiscovery } from './vendor/t3code/providerShape.js';

export interface ManagedAgentChatProps {
  readonly transport: AgentHarnessHostTransport;
  readonly workspaceScopeLabel?: string;
  readonly providerCredentials?: ProviderCredentialRendererTransport;
  readonly notConfiguredMessage?: string;
}

export function ManagedAgentChat({
  transport,
  workspaceScopeLabel = 'Current HimmelCAD project via SDK',
  providerCredentials,
  notConfiguredMessage,
}: ManagedAgentChatProps): JSX.Element {
  const [discoveries, setDiscoveries] = useState<readonly HarnessDiscovery[]>([]);
  const [activeProvider, setActiveProvider] = useState<HarnessProvider | null>(null);
  const [events, setEvents] = useState<readonly NormalizedAgentEvent[]>([]);
  const [busy, setBusy] = useState(false);
  const [credentialUsable, setCredentialUsable] = useState(false);
  const adapterRef = useRef<AgentHarnessAdapter | null>(null);
  const threadIdRef = useRef<string | null>(null);
  const turnIdRef = useRef<string | null>(null);
  const unsubscribeRef = useRef<(() => void) | null>(null);
  const sequenceRef = useRef(0);
  const discoveryGenerationRef = useRef(0);
  const threadGenerationRef = useRef(0);

  const stopLocalThread = (): void => {
    threadGenerationRef.current += 1;
    unsubscribeRef.current?.();
    unsubscribeRef.current = null;
    const adapter = adapterRef.current;
    const threadId = threadIdRef.current;
    if (adapter && threadId) void adapter.stop(threadId).catch(() => undefined);
    adapterRef.current = null;
    threadIdRef.current = null;
    turnIdRef.current = null;
    setBusy(false);
  };

  const refreshDiscoveries = (): void => {
    const generation = ++discoveryGenerationRef.current;
    void discoverHarnesses(transport).then(
      (result) => {
        if (generation !== discoveryGenerationRef.current) return;
        setDiscoveries(result);
        setActiveProvider(
          result.find((entry) => entry.state === 'available')?.identity.provider ?? null,
        );
      },
      (error: unknown) => {
        if (generation !== discoveryGenerationRef.current) return;
        setEvents((current) => [
          ...current,
          localError('discoveryFailed', error, sequenceRef.current++),
        ]);
      },
    );
  };

  useEffect(() => {
    let active = true;
    void discoverHarnesses(transport).then(
      (result) => {
        if (!active) return;
        setDiscoveries(result);
        setActiveProvider(
          result.find((entry) => entry.state === 'available')?.identity.provider ?? null,
        );
      },
      (error: unknown) => {
        if (!active) return;
        setEvents((current) => [
          ...current,
          localError('discoveryFailed', error, sequenceRef.current++),
        ]);
      },
    );
    return () => {
      active = false;
      discoveryGenerationRef.current += 1;
      threadGenerationRef.current += 1;
      unsubscribeRef.current?.();
      const adapter = adapterRef.current;
      const threadId = threadIdRef.current;
      if (adapter && threadId) void adapter.stop(threadId).catch(() => undefined);
    };
  }, [transport]);

  const selectProvider = (provider: HarnessProvider): void => {
    if (busy || provider === activeProvider) return;
    stopLocalThread();
    setEvents([]);
    setActiveProvider(provider);
  };

  const ensureThread = async (): Promise<{
    adapter: AgentHarnessAdapter;
    threadId: string;
  }> => {
    if (adapterRef.current && threadIdRef.current) {
      return { adapter: adapterRef.current, threadId: threadIdRef.current };
    }
    if (!activeProvider) throw new Error('Choose an available local harness.');
    const discovery = discoveries.find(
      (entry) => entry.state === 'available' && entry.identity.provider === activeProvider,
    );
    if (!discovery || discovery.state !== 'available') {
      throw new Error('The selected harness is no longer available.');
    }
    const generation = threadGenerationRef.current;
    const adapter = findHarnessDriver(activeProvider).create({
      transport,
      identity: discovery.identity,
      scope: {
        workspaceCapabilityId: 'himmelcad-project',
        filesystem: 'readOnly',
        network: providerNetworkMode(
          credentialUsable,
          discovery.identity.capabilities.includes('providerOnly'),
        ),
        destructiveCommands: 'productApprovalRequired',
      },
    });
    const { threadId } = await adapter.startThread({
      systemPrompt: buildAgentSystemPrompt({
        sdkDocs: '/workspace/SDK.md',
        skillsIndex: '/workspace/SKILLS.md',
      }),
    });
    if (generation !== threadGenerationRef.current) {
      await adapter.stop(threadId).catch(() => undefined);
      throw new Error('Thread start was superseded.');
    }
    let unsubscribe: () => void;
    try {
      unsubscribe = adapter.subscribe(threadId, (event) => {
        setEvents((current) => [...current, event]);
        if (
          event.kind === 'turnState' &&
          ['completed', 'failed', 'interrupted', 'stopped'].includes(event.state)
        ) {
          setBusy(false);
        }
      });
    } catch (error) {
      await adapter.stop(threadId).catch(() => undefined);
      throw error;
    }
    if (generation !== threadGenerationRef.current) {
      unsubscribe();
      await adapter.stop(threadId).catch(() => undefined);
      throw new Error('Thread start was superseded.');
    }
    adapterRef.current = adapter;
    threadIdRef.current = threadId;
    unsubscribeRef.current = unsubscribe;
    return { adapter, threadId };
  };

  const send = (prompt: string): void => {
    if (busy) return;
    setBusy(true);
    void ensureThread()
      .then(async ({ adapter, threadId }) => {
        const turnId = crypto.randomUUID();
        turnIdRef.current = turnId;
        setEvents((current) => [
          ...current,
          agentEvent({
            id: crypto.randomUUID(),
            sequence: sequenceRef.current++,
            provider: activeProvider ?? 'codex',
            threadId,
            turnId,
            createdAt: new Date().toISOString(),
            kind: 'message',
            messageId: crypto.randomUUID(),
            role: 'user',
            text: prompt,
            streaming: false,
          }),
        ]);
        await adapter.sendTurn({ threadId, turnId, prompt });
      })
      .catch((error: unknown) => {
        setBusy(false);
        setEvents((current) => [
          ...current,
          localError('sendFailed', error, sequenceRef.current++, activeProvider ?? 'codex'),
        ]);
      });
  };

  const activeDiscovery = discoveries.find(
    (entry) => entry.state === 'available' && entry.identity.provider === activeProvider,
  );
  const activeNetwork = providerNetworkMode(
    credentialUsable,
    activeDiscovery?.state === 'available' &&
      activeDiscovery.identity.capabilities.includes('providerOnly'),
  );

  return (
    <AgentChatPanel
      discoveries={discoveries}
      activeProvider={activeProvider}
      events={events}
      permissions={{
        filesystem: 'readOnly',
        network: activeNetwork,
        workspaceScopeLabel,
      }}
      busy={busy}
      {...(notConfiguredMessage ? { notConfiguredMessage } : {})}
      providerCredentialControl={
        providerCredentials ? (
          <ProviderCredentialControl
            transport={providerCredentials}
            onUsabilityChange={setCredentialUsable}
            onCredentialMutation={() => {
              stopLocalThread();
              setEvents([]);
            }}
            onCredentialChange={(_status: ProviderCredentialStatus) => {
              refreshDiscoveries();
            }}
          />
        ) : undefined
      }
      onSelectProvider={selectProvider}
      onSend={send}
      onInterrupt={() => {
        const adapter = adapterRef.current;
        const threadId = threadIdRef.current;
        if (adapter && threadId) {
          void adapter
            .interrupt({ threadId, ...(turnIdRef.current ? { turnId: turnIdRef.current } : {}) })
            .finally(() => setBusy(false));
        }
      }}
      onResume={() => {
        const adapter = adapterRef.current;
        const threadId = threadIdRef.current;
        if (adapter && threadId) {
          setBusy(true);
          void adapter
            .resume({ threadId, ...(turnIdRef.current ? { turnId: turnIdRef.current } : {}) })
            .catch((error: unknown) =>
              setEvents((current) => [
                ...current,
                localError(
                  'resumeUnavailable',
                  error,
                  sequenceRef.current++,
                  activeProvider ?? 'codex',
                ),
              ]),
            )
            .finally(() => setBusy(false));
        }
      }}
      onApproval={(requestId, decision) => {
        const adapter = adapterRef.current;
        const threadId = threadIdRef.current;
        if (adapter && threadId) {
          void adapter
            .respondToApproval({ threadId, requestId, decision })
            .catch((error: unknown) =>
              setEvents((current) => [
                ...current,
                localError(
                  'approvalUnavailable',
                  error,
                  sequenceRef.current++,
                  activeProvider ?? 'codex',
                ),
              ]),
            );
        }
      }}
    />
  );
}

function localError(
  code: string,
  error: unknown,
  sequence: number,
  provider: HarnessProvider = 'codex',
): NormalizedAgentEvent {
  return agentEvent({
    id: crypto.randomUUID(),
    sequence,
    provider,
    threadId: 'local-host',
    createdAt: new Date().toISOString(),
    kind: 'error',
    code,
    message: error instanceof Error ? error.message : String(error),
    recoverable: true,
  });
}
