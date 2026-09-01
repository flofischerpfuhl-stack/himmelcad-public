import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { discoverHarnesses, findHarnessDriver } from './drivers.js';
import { buildAgentSystemPrompt } from './systemPrompt.js';
import type {
  AgentHarnessHostTransport,
  HostHarnessRequest,
  HostHarnessResponse,
} from './transport.js';

describe('harness drivers', () => {
  it('preserves an unconfigured runtime as a typed discovery state', async () => {
    const discoveries = await discoverHarnesses(
      new FixtureTransport(() => ({
        kind: 'notConfigured',
        detail: 'No agent runtime is configured.',
      })),
    );
    assert.deepEqual(
      discoveries.map((item) => item.state),
      ['notConfigured', 'notConfigured', 'notConfigured'],
    );
    assert.equal(
      discoveries.every(
        (item) =>
          item.state === 'notConfigured' && item.detail === 'No agent runtime is configured.',
      ),
      true,
    );
  });

  it('treats absent Claude/OpenCode as normal and freezes available identity', async () => {
    const transport = new FixtureTransport((request) => {
      if (request.kind !== 'discover') return { kind: 'accepted' };
      if (request.provider !== 'codex') return { kind: 'missing', detail: 'not installed' };
      return { kind: 'discovered', identity: codexIdentity(['codexExecJson']) };
    });
    const discoveries = await discoverHarnesses(transport);
    assert.deepEqual(
      discoveries.map((item) => item.state),
      ['available', 'missing', 'missing'],
    );
    const available = discoveries[0];
    assert(available?.state === 'available');
    assert(Object.isFrozen(available.identity));
    assert(Object.isFrozen(available.identity.capabilities));
  });

  it('binds Codex app-server initialize/initialized to the probed schema', async () => {
    const transport = new FixtureTransport((request) =>
      request.kind === 'openSession'
        ? {
            kind: 'sessionOpened',
            hostSessionId: 'host-session-1',
            providerThreadId: 'codex-thread-7',
            boundAppServerSchema: { version: '2026-07', hash: 'a'.repeat(64) },
          }
        : { kind: 'accepted' },
    );
    const identity = codexIdentity(['codexAppServer', 'codexExecJson'], {
      version: '2026-07',
      hash: 'a'.repeat(64),
    });
    const adapter = findHarnessDriver('codex').create({ transport, identity, scope: scope() });
    assert.equal(adapter.mode, 'codexAppServer');
    assert(Object.isFrozen(adapter.identity));
    assert(Object.isFrozen(adapter.identity.capabilities));
    assert(Object.isFrozen(adapter.identity.appServerSchema));
    const started = await adapter.startThread({ systemPrompt: 'SDK docs only' });
    assert.equal(started.threadId, 'codex-thread-7');
    const open = transport.requests.find((request) => request.kind === 'openSession');
    assert(open?.kind === 'openSession');
    assert.deepEqual(
      open.initialization?.map((message) => `${message.kind}:${message.method}`),
      ['request:initialize', 'notification:initialized'],
    );
    assert.deepEqual(open.initialization?.[0]?.params, {
      clientInfo: {
        name: 'himmelcad',
        title: 'HimmelCAD',
        version: 'himmelcad-agent-adapter-v1',
      },
    });
    assert.equal(open.experimentalApi, false);
  });

  it('fails closed when the host decoder binding no longer matches discovery', async () => {
    const transport = new FixtureTransport(() => ({
      kind: 'sessionOpened',
      hostSessionId: 'host-session',
      providerThreadId: 'provider-thread',
      boundAppServerSchema: { version: 'changed', hash: 'b'.repeat(64) },
    }));
    const identity = codexIdentity(['codexAppServer'], {
      version: '2026-07',
      hash: 'a'.repeat(64),
    });
    const adapter = findHarnessDriver('codex').create({ transport, identity, scope: scope() });
    await assert.rejects(
      () => adapter.startThread({ systemPrompt: 'SDK docs only' }),
      /schema changed/i,
    );
    assert.equal(
      transport.requests.some(
        (request) => request.kind === 'closeSession' && request.sessionId === 'host-session',
      ),
      true,
    );
  });

  it('falls back to codex exec --json when app-server is not schema-bound', () => {
    const adapter = findHarnessDriver('codex').create({
      transport: new FixtureTransport(() => ({ kind: 'accepted' })),
      identity: codexIdentity(['codexExecJson']),
      scope: scope(),
    });
    assert.equal(adapter.mode, 'codexExecJson');
  });

  it('fails closed for unprobed experimental Codex APIs and forwards an explicit probe', async () => {
    const transport = new FixtureTransport((request) =>
      request.kind === 'openSession'
        ? {
            kind: 'sessionOpened',
            hostSessionId: 'host-session-experimental',
            providerThreadId: 'codex-thread-experimental',
          }
        : { kind: 'accepted' },
    );

    assert.throws(
      () =>
        findHarnessDriver('codex').create({
          transport,
          identity: codexIdentity(['codexExecJson']),
          scope: scope(),
          experimentalApi: true,
        }),
      /not capability-probed/i,
    );

    const adapter = findHarnessDriver('codex').create({
      transport,
      identity: codexIdentity(['codexExecJson', 'codexExperimentalApi']),
      scope: scope(),
      experimentalApi: true,
    });
    await adapter.startThread({ systemPrompt: 'SDK docs only' });
    const open = transport.requests.find((request) => request.kind === 'openSession');
    assert(open?.kind === 'openSession');
    assert.equal(open.experimentalApi, true);
  });

  it('reports installed but capability-incompatible harnesses without blocking others', async () => {
    const transport = new FixtureTransport((request) => {
      if (request.kind !== 'discover') return { kind: 'accepted' };
      return {
        kind: 'discovered',
        identity: {
          provider: request.provider,
          executableId: `exe:${request.provider}`,
          canonicalExecutableHash: 'c'.repeat(64),
          version: '1.0.0',
          adapterVersion: 'himmelcad-agent-adapter-v1',
          capabilities: request.provider === 'codex' ? ['codexExecJson'] : [],
        },
      };
    });
    const discoveries = await discoverHarnesses(transport);
    assert.deepEqual(
      discoveries.map((item) => item.state),
      ['available', 'incompatible', 'incompatible'],
    );
  });

  it('never exposes a credential contained in host discovery error text', async () => {
    const discoveries = await discoverHarnesses(
      new FixtureTransport(() => ({
        kind: 'incompatible',
        detail: 'authorization=Bearer-super-secret token=also-secret',
      })),
    );
    const serialized = JSON.stringify(discoveries);
    assert.equal(serialized.includes('super-secret'), false);
    assert.equal(serialized.includes('also-secret'), false);
  });

  it('shares subscriptions, detaches the last listener and cleans up after a failed stop', async () => {
    const transport = new FixtureTransport((request) => {
      if (request.kind === 'openSession') {
        return {
          kind: 'sessionOpened',
          hostSessionId: 'host-lifecycle',
          providerThreadId: 'thread-lifecycle',
        };
      }
      if (request.kind === 'closeSession') {
        return { kind: 'incompatible', detail: 'close failed token=host-secret' };
      }
      return { kind: 'accepted' };
    });
    const adapter = findHarnessDriver('codex').create({
      transport,
      identity: codexIdentity(['codexExecJson']),
      scope: scope(),
    });
    const { threadId } = await adapter.startThread({ systemPrompt: 'SDK docs only' });
    let deliveries = 0;
    const first = adapter.subscribe(threadId, () => {
      throw new Error('subscriber failed password=listener-secret');
    });
    const second = adapter.subscribe(threadId, () => {
      deliveries += 1;
    });
    assert.equal(transport.subscribeCalls, 1);

    assert.doesNotThrow(() =>
      transport.emit('host-lifecycle', {
        method: 'agent_message',
        params: { id: 'm1', text: 'hello', streaming: false },
      }),
    );
    assert.equal(deliveries, 1);
    first();
    assert.equal(transport.unsubscribeCalls, 0);
    second();
    assert.equal(transport.unsubscribeCalls, 1);
    second();
    assert.equal(transport.unsubscribeCalls, 1);
    transport.emitDetached({
      method: 'agent_message',
      params: { id: 'stale', text: 'must not arrive', streaming: false },
    });
    assert.equal(deliveries, 1);
    assert.equal(adapter.events.snapshot().items.length, 1);

    adapter.subscribe(threadId, () => {
      deliveries += 1;
    });
    assert.equal(transport.subscribeCalls, 2);
    await assert.rejects(() => adapter.stop(threadId), /close failed token=\[REDACTED\]/i);
    assert.equal(transport.unsubscribeCalls, 2);
    assert.throws(() => adapter.subscribe(threadId, () => undefined), /unknown harness thread/i);

    const diagnostics = JSON.stringify(adapter.diagnostics.snapshot());
    assert.equal(diagnostics.includes('listener-secret'), false);
    assert.equal(diagnostics.includes('host-secret'), false);
  });

  it('contains malformed provider output instead of throwing through the host callback', async () => {
    const transport = new FixtureTransport((request) =>
      request.kind === 'openSession'
        ? {
            kind: 'sessionOpened',
            hostSessionId: 'host-malformed',
            providerThreadId: 'thread-malformed',
          }
        : { kind: 'accepted' },
    );
    const adapter = findHarnessDriver('codex').create({
      transport,
      identity: codexIdentity(['codexExecJson']),
      scope: scope(),
    });
    const { threadId } = await adapter.startThread({ systemPrompt: 'SDK docs only' });
    adapter.subscribe(threadId, () => assert.fail('invalid event must not be delivered'));
    assert.doesNotThrow(() =>
      transport.emit('host-malformed', {
        method: 'command',
        params: { id: 'huge-command', command: 'x'.repeat(40 * 1024) },
      }),
    );
    assert.equal(adapter.events.snapshot().items.length, 0);
    assert.equal(adapter.diagnostics.snapshot().items.length, 2);
  });

  it('builds a prompt containing docs and skills references but no project copy', () => {
    const prompt = buildAgentSystemPrompt({
      sdkDocs: 'himmelcad://sdk/docs',
      skillsIndex: 'himmelcad://skills/index',
    });
    assert.match(prompt, /himmelcad:\/\/sdk\/docs/);
    assert.match(prompt, /himmelcad:\/\/skills\/index/);
    assert.doesNotMatch(prompt, /entities\s*:/i);
  });
});

class FixtureTransport implements AgentHarnessHostTransport {
  readonly requests: HostHarnessRequest[] = [];
  readonly #subscribers = new Map<string, Set<(payload: unknown) => void>>();
  readonly #allSubscribers: ((payload: unknown) => void)[] = [];
  subscribeCalls = 0;
  unsubscribeCalls = 0;
  constructor(readonly handler: (request: HostHarnessRequest) => HostHarnessResponse) {}
  async request(request: HostHarnessRequest): Promise<HostHarnessResponse> {
    this.requests.push(request);
    return this.handler(request);
  }
  subscribe(sessionId: string, onPayload: (payload: unknown) => void): () => void {
    this.subscribeCalls += 1;
    this.#allSubscribers.push(onPayload);
    const subscribers = this.#subscribers.get(sessionId) ?? new Set();
    subscribers.add(onPayload);
    this.#subscribers.set(sessionId, subscribers);
    let attached = true;
    return () => {
      if (!attached) return;
      attached = false;
      this.unsubscribeCalls += 1;
      subscribers.delete(onPayload);
      if (subscribers.size === 0) this.#subscribers.delete(sessionId);
    };
  }
  emit(sessionId: string, payload: unknown): void {
    for (const subscriber of this.#subscribers.get(sessionId) ?? []) subscriber(payload);
  }
  emitDetached(payload: unknown): void {
    for (const subscriber of this.#allSubscribers) subscriber(payload);
  }
}

function codexIdentity(
  capabilities: readonly string[],
  appServerSchema?: { version: string; hash: string },
) {
  return {
    provider: 'codex' as const,
    executableId: 'exe:codex',
    canonicalExecutableHash: 'b'.repeat(64),
    version: 'codex-cli 1.2.3',
    adapterVersion: 'himmelcad-agent-adapter-v1',
    capabilities,
    ...(appServerSchema ? { appServerSchema } : {}),
  };
}

function scope() {
  return {
    workspaceCapabilityId: 'workspace-capability',
    filesystem: 'readOnly' as const,
    network: 'providerOnly' as const,
    destructiveCommands: 'productApprovalRequired' as const,
  };
}
