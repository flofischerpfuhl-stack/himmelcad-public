/**
 * Runtime of the assistant island (assembler/AGENT-ASSISTANT.md): harness
 * discovery and selection, sessions and turns, the approval gate, entity
 * references and the tool calls a running CLI makes on the open project.
 *
 * Pure TypeScript (no React, no runtime import of `@himmelcad/agent`): the
 * shared package's drivers and redactor come in as a {@link HarnessKit} from
 * the UI part (`module.ui.tsx`), the command layer as an `AgentSession` from
 * the module's `install`, so the controller runs under Node tests with fakes.
 *
 * One assistant turn = one undo step: the undo stack is marked when the turn
 * starts and the steps the agent committed are merged when it ends
 * (`store.markHistory`/`squashHistory`); if the user edited in between, the
 * steps stay separate and the transcript says so.
 */
import { create } from 'zustand';

import type {
  AgentHarnessAdapter,
  HarnessDiscovery,
} from '@himmelcad/agent/src/vendor/t3code/providerShape.js';
import type { HarnessProvider, NormalizedAgentEvent } from '@himmelcad/agent/src/events.js';
import type {
  AgentHarnessHostTransport,
  HarnessExecutableIdentity,
} from '@himmelcad/agent/src/transport.js';

import type { Json } from '../../foundation/commands/api/contract.js';
import { describeEdgeName, describeFaceName } from '../../foundation/commands/api/describe.js';
import type {
  AssemblerState,
  HistoryMark,
  SelectionItem,
} from '../../foundation/commands/store.js';
import type { HostAssistant, HostAssistantToolRequest } from '../../foundation/host/host.js';
import {
  boundEvents,
  boundText,
  useAssistantSessions,
  type AssistantProvider,
  type StoredEvent,
  type StoredSession,
} from './sessions.js';
import { buildAssistantPrompt } from './prompt.js';
import {
  ASSISTANT_TOOLS,
  callAssistantTool,
  type ApprovalRequest,
  type MethodRunner,
  type ToolHost,
} from './tools.js';

/** The shared package's runtime, handed in by the UI part. */
export interface HarnessKit {
  discover(transport: AgentHarnessHostTransport): Promise<readonly HarnessDiscovery[]>;
  create(
    identity: HarnessExecutableIdentity,
    transport: AgentHarnessHostTransport,
  ): AgentHarnessAdapter;
  /** Removes credentials/tokens from text before it is shown or stored. */
  redact(text: string): string;
}

/** The part of the application store the assistant uses. */
export interface AssistantStoreApi {
  getState(): Pick<
    AssemblerState,
    | 'features'
    | 'parameters'
    | 'evaluation'
    | 'selection'
    | 'projectName'
    | 'markHistory'
    | 'squashHistory'
    | 'history'
  >;
}

export interface AssistantReference {
  key: string;
  label: string;
  item: SelectionItem;
}

export interface AssistantImage {
  data: string;
  label: string;
}

/** Ms an approval waits for the user before it expires (denied). */
export const APPROVAL_TIMEOUT_MS = 5 * 60_000;
const MAX_IMAGES = 24;
const MAX_REFERENCES = 24;
const TERMINAL = new Set(['completed', 'failed', 'interrupted', 'stopped']);

interface Turn {
  id: string;
  sessionId: string;
  threadId: string;
  mark: HistoryMark;
  /** Features and parameters the turn found (deleting them needs approval). */
  preexisting: Set<string>;
  preexistingParameters: Set<string>;
  /** Committed writes minus undos of this turn. */
  steps: number;
  /** Feature-list changes not made by the agent while the turn ran. */
  foreignChanges: number;
  unsubscribeStore: () => void;
}

interface Runtime {
  kit: HarnessKit | null;
  bridge: HostAssistant | null;
  session: MethodRunner | null;
  store: AssistantStoreApi | null;
  /** Subscribe to application-store changes (foreign edits during a turn). */
  subscribeStore: ((listener: () => void) => () => void) | null;
  adapter: AgentHarnessAdapter | null;
  adapterSessionId: string | null;
  threadId: string | null;
  unsubscribeEvents: (() => void) | null;
  unsubscribeTools: (() => void) | null;
  turn: Turn | null;
  approvals: Map<string, (approved: boolean) => void>;
  sequence: number;
  /** Methods currently executing for the agent (their store changes are not foreign). */
  running: number;
}

const runtime: Runtime = {
  kit: null,
  bridge: null,
  session: null,
  store: null,
  subscribeStore: null,
  adapter: null,
  adapterSessionId: null,
  threadId: null,
  unsubscribeEvents: null,
  unsubscribeTools: null,
  turn: null,
  approvals: new Map(),
  sequence: 0,
  running: 0,
};

export interface AssistantState {
  /** The host can run local agent CLIs (desktop). */
  available: boolean;
  unavailableReason: string;
  open: boolean;
  tab: 'chat' | 'skills';
  discoveries: readonly HarnessDiscovery[];
  discovering: boolean;
  provider: HarnessProvider | null;
  /** Events of the active session since its transcript was last stored. */
  live: readonly NormalizedAgentEvent[];
  busy: boolean;
  references: readonly AssistantReference[];
  /** Images tools returned, by timeline row id. */
  images: Readonly<Record<string, readonly AssistantImage[]>>;
  setOpen(open: boolean): void;
  setTab(tab: 'chat' | 'skills'): void;
  refresh(): Promise<void>;
  selectProvider(provider: HarnessProvider): void;
  newSession(): void;
  selectSession(id: string): void;
  renameSession(id: string, name: string): void;
  deleteSession(id: string): void;
  send(prompt: string): Promise<void>;
  interrupt(): Promise<void>;
  /** Continues an interrupted turn ("Continue where you stopped."). */
  continueTurn(): Promise<void>;
  respondApproval(requestId: string, decision: 'approved' | 'denied'): boolean;
  addSelection(): void;
  removeReference(key: string): void;
}

export const useAssistant = create<AssistantState>((set, get) => ({
  available: false,
  unavailableReason: 'The assistant is starting.',
  open: false,
  tab: 'chat',
  discoveries: [],
  discovering: false,
  provider: null,
  live: [],
  busy: false,
  references: [],
  images: {},
  setOpen: (open) => {
    set({ open });
    if (open && get().available && get().discoveries.length === 0 && !get().discovering) {
      void get().refresh();
    }
  },
  setTab: (tab) => set({ tab }),
  refresh: async () => {
    const { kit, bridge } = runtime;
    if (!kit || !bridge) return;
    set({ discovering: true });
    try {
      const discoveries = await kit.discover(transportOf(bridge));
      const current = get().provider;
      const available = discoveries.filter((d) => d.state === 'available');
      const preferred =
        (current &&
        available.some((d) => d.state === 'available' && d.identity.provider === current)
          ? current
          : null) ?? (available[0]?.state === 'available' ? available[0].identity.provider : null);
      set({ discoveries, provider: preferred, discovering: false });
    } catch (error) {
      set({ discovering: false });
      pushLocal(localError('discoveryFailed', error));
    }
  },
  selectProvider: (provider) => {
    if (get().busy || provider === get().provider) return;
    void closeThread();
    set({ provider });
  },
  newSession: () => {
    if (get().busy) return;
    flushLive();
    void closeThread();
    useAssistantSessions.getState().setActive(null);
    set({ live: [], images: {} });
  },
  selectSession: (id) => {
    if (get().busy) return;
    flushLive();
    void closeThread();
    const session = useAssistantSessions.getState().sessions.find((s) => s.id === id);
    useAssistantSessions.getState().setActive(id);
    set({
      live: [],
      images: {},
      ...(session?.provider && isAvailable(get().discoveries, session.provider)
        ? { provider: session.provider }
        : {}),
    });
  },
  renameSession: (id, name) => {
    const trimmed = name.trim().slice(0, 80);
    if (!trimmed) return;
    useAssistantSessions.getState().update(id, (s) => ({ ...s, name: trimmed }));
  },
  deleteSession: (id) => {
    if (get().busy && runtime.turn?.sessionId === id) return;
    if (useAssistantSessions.getState().activeId === id) {
      void closeThread();
      set({ live: [], images: {} });
    }
    useAssistantSessions.getState().remove(id);
  },
  send: async (prompt) => {
    const text = prompt.trim();
    if (!text || get().busy) return;
    const { store, kit, bridge } = runtime;
    if (!store || !kit || !bridge || !runtime.session) {
      pushLocal(localError('notReady', new Error(get().unavailableReason)));
      return;
    }
    const provider = get().provider;
    if (!provider) {
      pushLocal(localError('noHarness', new Error('Choose an installed agent CLI first.')));
      return;
    }
    set({ busy: true });
    const sessions = useAssistantSessions.getState();
    let session = sessions.sessions.find((s) => s.id === sessions.activeId);
    if (!session) session = sessions.create(provider, sessionName(text));
    const message = composePrompt(text, get().references, store);
    try {
      const threadId = await ensureThread(session, provider);
      const state = store.getState();
      const turnId = globalThis.crypto.randomUUID();
      const turn: Turn = {
        id: turnId,
        sessionId: session.id,
        threadId,
        mark: state.markHistory(),
        preexisting: new Set(state.features.map((f) => f.id)),
        preexistingParameters: new Set(state.parameters.map((p) => p.id)),
        steps: 0,
        foreignChanges: 0,
        unsubscribeStore: () => undefined,
      };
      if (runtime.subscribeStore) {
        turn.unsubscribeStore = runtime.subscribeStore(() => {
          if (runtime.running === 0) turn.foreignChanges += 1;
        });
      }
      runtime.turn = turn;
      useAssistantSessions.getState().update(session.id, (s) => ({
        ...s,
        provider,
        state: 'interrupted',
        updatedAt: new Date().toISOString(),
      }));
      pushLocal(userMessage(message.display, threadId));
      set({ references: [] });
      await runtime.adapter!.sendTurn({ threadId, turnId, prompt: message.prompt });
    } catch (error) {
      pushLocal(localError('sendFailed', error));
      finishTurn('failed');
    }
  },
  interrupt: async () => {
    for (const resolve of runtime.approvals.values()) resolve(false);
    const adapter = runtime.adapter;
    const turn = runtime.turn;
    if (!adapter || !turn) {
      set({ busy: false });
      return;
    }
    try {
      await adapter.interrupt({ threadId: turn.threadId, turnId: turn.id });
    } catch (error) {
      pushLocal(localError('interruptFailed', error));
    }
    // The host reports `turn.interrupted`; if it cannot, end the turn here.
    if (runtime.turn === turn) finishTurn('interrupted');
  },
  continueTurn: async () => {
    await get().send('Continue where you stopped. Check the current state of the model first.');
  },
  respondApproval: (requestId, decision) => {
    const resolve = runtime.approvals.get(requestId);
    if (!resolve) return false;
    resolve(decision === 'approved');
    return true;
  },
  addSelection: () => {
    const store = runtime.store;
    if (!store) return;
    const state = store.getState();
    const existing = new Set(get().references.map((r) => r.key));
    const added: AssistantReference[] = [];
    for (const item of state.selection) {
      const reference = referenceOf(item, state);
      if (reference && !existing.has(reference.key)) {
        existing.add(reference.key);
        added.push(reference);
      }
    }
    set((s) => ({ references: [...s.references, ...added].slice(0, MAX_REFERENCES) }));
  },
  removeReference: (key) => set((s) => ({ references: s.references.filter((r) => r.key !== key) })),
}));

// ---- wiring --------------------------------------------------------------------------------

/** UI part: the shared package's runtime and the host bridge (`null`: no local CLIs here). */
export function configureAssistant(
  kit: HarnessKit,
  bridge: HostAssistant | null,
  unavailableReason: string,
): void {
  runtime.kit = kit;
  runtime.bridge = bridge;
  runtime.unsubscribeTools?.();
  runtime.unsubscribeTools = bridge
    ? bridge.onToolRequest((id, request) => void answerTool(bridge, id, request))
    : null;
  useAssistant.setState({
    available: bridge !== null && runtime.session !== null,
    unavailableReason: bridge ? 'The assistant is starting.' : unavailableReason,
  });
  if (bridge && runtime.session) useAssistant.setState({ available: true, unavailableReason: '' });
}

/** Module install: the command layer the tools run on and the application store. */
export function attachAssistantRuntime(options: {
  session: MethodRunner;
  store: AssistantStoreApi;
  subscribeStore: (listener: () => void) => () => void;
}): void {
  runtime.session = options.session;
  runtime.store = options.store;
  runtime.subscribeStore = options.subscribeStore;
  if (runtime.bridge) useAssistant.setState({ available: true, unavailableReason: '' });
}

/** Tests: forget the wiring and state. */
export function resetAssistantForTests(): void {
  runtime.unsubscribeEvents?.();
  runtime.unsubscribeTools?.();
  Object.assign(runtime, {
    kit: null,
    bridge: null,
    session: null,
    store: null,
    subscribeStore: null,
    adapter: null,
    adapterSessionId: null,
    threadId: null,
    unsubscribeEvents: null,
    unsubscribeTools: null,
    turn: null,
    approvals: new Map(),
    sequence: 0,
    running: 0,
  } satisfies Runtime);
  useAssistant.setState({
    available: false,
    open: false,
    tab: 'chat',
    discoveries: [],
    discovering: false,
    provider: null,
    live: [],
    busy: false,
    references: [],
    images: {},
  });
  useAssistantSessions.getState().replaceAll([]);
}

function transportOf(bridge: HostAssistant): AgentHarnessHostTransport {
  return bridge.harness as unknown as AgentHarnessHostTransport;
}

function isAvailable(discoveries: readonly HarnessDiscovery[], provider: string): boolean {
  return discoveries.some((d) => d.state === 'available' && d.identity.provider === provider);
}

async function ensureThread(session: StoredSession, provider: HarnessProvider): Promise<string> {
  if (runtime.adapter && runtime.adapterSessionId === session.id && runtime.threadId) {
    if (runtime.adapter.identity.provider === provider) return runtime.threadId;
  }
  await closeThread();
  const { kit, bridge, store } = runtime;
  const discovery = useAssistant
    .getState()
    .discoveries.find((d) => d.state === 'available' && d.identity.provider === provider);
  if (!kit || !bridge || !store || !discovery || discovery.state !== 'available') {
    throw new Error('The selected agent CLI is not available; refresh the list.');
  }
  const adapter = kit.create(discovery.identity, transportOf(bridge));
  const resume = session.provider === provider ? session.threadId : undefined;
  const { threadId } = await adapter.startThread({
    systemPrompt: buildAssistantPrompt(store.getState()),
    ...(resume ? { resumeThreadId: resume } : {}),
  });
  runtime.adapter = adapter;
  runtime.adapterSessionId = session.id;
  runtime.threadId = threadId;
  runtime.unsubscribeEvents = adapter.subscribe(threadId, onEvent);
  if (resume && resume !== threadId) {
    pushLocal(
      note(
        'The agent CLI could not continue its earlier conversation; this turn starts a new one (the transcript above stays).',
        threadId,
      ),
    );
  }
  useAssistantSessions.getState().update(session.id, (s) => ({ ...s, threadId, provider }));
  return threadId;
}

async function closeThread(): Promise<void> {
  const { adapter, threadId } = runtime;
  runtime.unsubscribeEvents?.();
  runtime.unsubscribeEvents = null;
  runtime.adapter = null;
  runtime.adapterSessionId = null;
  runtime.threadId = null;
  if (adapter && threadId) await adapter.stop(threadId).catch(() => undefined);
}

function onEvent(event: NormalizedAgentEvent): void {
  useAssistant.setState((s) => ({ live: [...s.live, event] }));
  if (event.kind === 'turnState' && TERMINAL.has(event.state) && runtime.turn) {
    finishTurn(event.state as 'completed' | 'failed' | 'interrupted' | 'stopped');
  }
}

function finishTurn(state: 'completed' | 'failed' | 'interrupted' | 'stopped'): void {
  const turn = runtime.turn;
  runtime.turn = null;
  for (const resolve of runtime.approvals.values()) resolve(false);
  if (turn) {
    turn.unsubscribeStore();
    const store = runtime.store;
    if (store && turn.steps > 0) {
      const merged =
        turn.foreignChanges === 0 && turn.steps > 1 && store.getState().squashHistory(turn.mark);
      const summary =
        turn.foreignChanges > 0
          ? `${turn.steps} model change${turn.steps === 1 ? '' : 's'}; you edited the model during the turn, so they stay separate undo steps.`
          : turn.steps === 1 || merged
            ? `${turn.steps} model change${turn.steps === 1 ? '' : 's'} · one undo step (Ctrl+Z).`
            : `${turn.steps} model changes; they could not be merged into one undo step.`;
      pushLocal(note(summary, turn.threadId));
    }
    useAssistantSessions.getState().update(turn.sessionId, (s) => ({
      ...s,
      state: state === 'completed' ? 'idle' : 'interrupted',
      updatedAt: new Date().toISOString(),
    }));
  }
  flushLive();
  useAssistant.setState({ busy: false });
}

/** Stores the live events of the active session (sanitized) and clears them. */
function flushLive(): void {
  const live = useAssistant.getState().live;
  const activeId = useAssistantSessions.getState().activeId;
  if (live.length === 0 || !activeId) return;
  const redact = runtime.kit?.redact ?? ((text: string) => text);
  const stored = storedFromEvents(live, redact);
  useAssistantSessions.getState().update(activeId, (s) => ({
    ...s,
    events: boundEvents([...s.events, ...stored]),
    updatedAt: new Date().toISOString(),
  }));
  // Render thumbnails follow their tool row into the stored transcript (`eventsFromStored` ids).
  const session = useAssistantSessions.getState().sessions.find((s) => s.id === activeId);
  const provider = session?.provider ?? 'claude';
  const images: Record<string, readonly AssistantImage[]> = {};
  for (const [key, list] of Object.entries(useAssistant.getState().images)) {
    const match = /^[^:]+:[^:]+:command:(.+)$/u.exec(key);
    images[match ? `${provider}:${activeId}:command:${match[1]}` : key] = list;
  }
  useAssistant.setState({ live: [], images });
}

/** Normalized events → the stored transcript (merged rows; reasoning and usage left out). */
export function storedFromEvents(
  events: readonly NormalizedAgentEvent[],
  redact: (text: string) => string,
): StoredEvent[] {
  const out: StoredEvent[] = [];
  const index = new Map<string, number>();
  const put = (id: string, event: StoredEvent, append?: (prev: StoredEvent) => StoredEvent) => {
    const at = index.get(id);
    if (at === undefined) {
      index.set(id, out.length);
      out.push(event);
    } else out[at] = append ? append(out[at]!) : event;
  };
  for (const event of events) {
    switch (event.kind) {
      case 'message':
        if (event.role === 'system') {
          put(`note:${event.messageId}`, {
            kind: 'state',
            id: event.messageId,
            state: 'note',
            detail: boundText(redact(event.text)),
            at: event.createdAt,
          });
          break;
        }
        put(
          `message:${event.messageId}`,
          {
            kind: 'message',
            id: event.messageId,
            role: event.role,
            text: boundText(redact(event.text)),
            at: event.createdAt,
          },
          (prev) =>
            prev.kind === 'message' && event.streaming
              ? { ...prev, text: boundText(prev.text + redact(event.text)) }
              : {
                  kind: 'message',
                  id: event.messageId,
                  role: event.role === 'system' ? 'assistant' : event.role,
                  text: boundText(redact(event.text)),
                  at: prev.at,
                },
        );
        break;
      case 'command':
        put(`command:${event.operationId}`, {
          kind: 'command',
          id: event.operationId,
          command: boundText(redact(event.command), 512),
          state: event.state,
          ...(event.outputPreview ? { detail: boundText(redact(event.outputPreview), 2048) } : {}),
          at: event.createdAt,
        });
        break;
      case 'approval':
        put(`approval:${event.requestId}`, {
          kind: 'approval',
          id: event.requestId,
          title: boundText(redact(event.title), 512),
          ...(event.detail ? { detail: boundText(redact(event.detail), 2048) } : {}),
          state: event.state,
          at: event.createdAt,
        });
        break;
      case 'error':
        put(`error:${event.id}`, {
          kind: 'error',
          id: event.id,
          code: event.code.slice(0, 64),
          message: boundText(redact(event.message), 4096),
          at: event.createdAt,
        });
        break;
      case 'turnState':
        put(`turn:${event.turnId ?? event.id}`, {
          kind: 'state',
          id: event.id,
          state: event.state,
          ...(event.detail ? { detail: boundText(redact(event.detail), 2048) } : {}),
          at: event.createdAt,
        });
        break;
      default:
        // reasoning (hidden), usage, file changes and thread states are not kept.
        break;
    }
  }
  return out;
}

/** The stored transcript as display events of one session. */
export function eventsFromStored(session: StoredSession): NormalizedAgentEvent[] {
  const provider: HarnessProvider = session.provider ?? 'claude';
  const base = (id: string, sequence: number, at: string) => ({
    schemaVersion: 1 as const,
    id: `stored:${session.id}:${id}:${sequence}`,
    sequence,
    provider,
    threadId: session.id,
    createdAt: at,
  });
  return session.events.map((event, sequence): NormalizedAgentEvent => {
    switch (event.kind) {
      case 'message':
        return {
          ...base(event.id, sequence, event.at),
          kind: 'message',
          messageId: event.id,
          role: event.role,
          text: event.text,
          streaming: false,
        };
      case 'command':
        return {
          ...base(event.id, sequence, event.at),
          kind: 'command',
          operationId: event.id,
          command: event.command,
          state: (['queued', 'running', 'completed', 'failed', 'interrupted'].includes(event.state)
            ? event.state
            : 'completed') as 'completed',
          ...(event.detail ? { outputPreview: event.detail } : {}),
        };
      case 'approval':
        return {
          ...base(event.id, sequence, event.at),
          kind: 'approval',
          requestId: event.id,
          state: event.state === 'pending' ? 'expired' : event.state,
          title: event.title,
          ...(event.detail ? { detail: event.detail } : {}),
          destructive: true,
        };
      case 'error':
        return {
          ...base(event.id, sequence, event.at),
          kind: 'error',
          code: event.code,
          message: event.message,
          recoverable: false,
        };
      default:
        return event.state === 'note' || event.state === 'trimmed'
          ? {
              ...base(event.id, sequence, event.at),
              kind: 'message',
              messageId: event.id,
              role: 'system',
              text: event.detail ?? '',
              streaming: false,
            }
          : {
              ...base(event.id, sequence, event.at),
              kind: 'turnState',
              state: ([
                'starting',
                'ready',
                'running',
                'awaitingApproval',
                'interrupted',
                'failed',
                'completed',
                'stopped',
              ].includes(event.state)
                ? event.state
                : 'completed') as 'completed',
              ...(event.detail ? { detail: event.detail } : {}),
            };
    }
  });
}

// ---- tool calls ----------------------------------------------------------------------------

async function answerTool(bridge: HostAssistant, id: string, request: HostAssistantToolRequest) {
  if (request.name === 'tools/list') {
    await bridge.respondTool(id, { tools: ASSISTANT_TOOLS });
    return;
  }
  const turn = runtime.turn;
  if (!turn || turn.threadId !== request.threadId || !runtime.session) {
    await bridge.respondTool(id, {
      content: [
        {
          type: 'text',
          text: '{"code":"busy","message":"No assistant turn of this session is running in the app."}',
        },
      ],
      isError: true,
    });
    return;
  }
  const host: ToolHost = {
    session: {
      handle: async (method, params) => {
        runtime.running += 1;
        try {
          return await runtime.session!.handle(method, params);
        } finally {
          // The store notifies synchronously inside the call; keep the counter until it settled.
          queueMicrotask(() => {
            runtime.running -= 1;
          });
        }
      },
    },
    classify: (method, params) => classify(turn, method, params),
    approve: (approval) => requestApproval(approval, turn.threadId),
    onMethod: (method, _params, result) => countStep(turn, method, result),
    onImage: (image) => attachImage(image, turn.threadId),
  };
  const result = await callAssistantTool(host, request.name, request.arguments);
  await bridge.respondTool(id, result);
}

function countStep(turn: Turn, method: string, result: unknown): void {
  const value = result as Json | null;
  if (method === 'history.undo') turn.steps -= 1;
  else if (method === 'history.redo') turn.steps += 1;
  else if (value && value.committed === true) turn.steps += 1;
  else if (method === 'transaction.commit' || method.startsWith('parameter.')) {
    if (value && (Array.isArray(value.featureIds) || typeof value.revision === 'number'))
      turn.steps += 1;
  }
}

/** Which calls need the user's approval (destructive to work that existed before the turn). */
export function classifyForTurn(
  turn: Pick<Turn, 'preexisting' | 'preexistingParameters' | 'steps'>,
  method: string,
  params: Json,
  state: Pick<AssemblerState, 'features' | 'parameters'>,
): ApprovalRequest | null {
  switch (method) {
    case 'project.new':
      return {
        method,
        title: 'Start a new, empty project',
        detail: 'The assistant wants to replace the open project with a new one.',
      };
    case 'project.open':
      return {
        method,
        title: 'Open another project',
        detail: 'The assistant wants to replace the open project.',
      };
    case 'feature.delete': {
      const id = String(params.featureId);
      if (!turn.preexisting.has(id)) return null;
      const feature = state.features.find((f) => f.id === id);
      return {
        method,
        title: `Delete the step “${feature?.name ?? id}”`,
        detail:
          'This step existed before the assistant started; later steps that use it may fail. Undo brings it back.',
      };
    }
    case 'parameter.delete': {
      const id = String(params.parameterId ?? '');
      if (!turn.preexistingParameters.has(id)) return null;
      const name = state.parameters.find((p) => p.id === id)?.name ?? id;
      return {
        method,
        title: `Delete the parameter “${name}”`,
        detail: 'The parameter existed before the assistant started.',
      };
    }
    case 'history.undo':
      if (turn.steps > 0) return null;
      return {
        method,
        title: 'Undo a change made before this turn',
        detail:
          'The assistant wants to undo a step it did not make in this turn (your own or an earlier one).',
      };
    default:
      return null;
  }
}

function classify(turn: Turn, method: string, params: Json): ApprovalRequest | null {
  const store = runtime.store;
  return store ? classifyForTurn(turn, method, params, store.getState()) : null;
}

function requestApproval(request: ApprovalRequest, threadId: string): Promise<boolean> {
  const requestId = `approval-${globalThis.crypto.randomUUID()}`;
  const event = (state: 'pending' | 'approved' | 'denied' | 'expired'): NormalizedAgentEvent => ({
    ...localBase(threadId),
    kind: 'approval',
    requestId,
    state,
    title: request.title,
    detail: request.detail,
    destructive: true,
    requestedCapability: 'canonicalCommand',
  });
  pushLocal(event('pending'));
  useAssistant.setState({ open: true, tab: 'chat' });
  return new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => finish(false, 'expired'), APPROVAL_TIMEOUT_MS);
    const finish = (approved: boolean, state: 'approved' | 'denied' | 'expired') => {
      if (!runtime.approvals.has(requestId)) return;
      runtime.approvals.delete(requestId);
      clearTimeout(timer);
      pushLocal(event(state));
      resolve(approved);
    };
    runtime.approvals.set(requestId, (approved) =>
      finish(approved, approved ? 'approved' : 'denied'),
    );
  });
}

function attachImage(
  image: { mediaType: string; data: string; label: string },
  threadId: string,
): void {
  const live = useAssistant.getState().live;
  // The tool row the CLI reported for this call (its running view_* / view.* command).
  let rowId: string | null = null;
  for (let i = live.length - 1; i >= 0; i -= 1) {
    const event = live[i]!;
    if (event.kind === 'command' && /view[._](render|inspect)/u.test(event.command)) {
      rowId = `${event.provider}:${event.threadId}:command:${event.operationId}`;
      break;
    }
  }
  if (!rowId) {
    const local: NormalizedAgentEvent = {
      ...localBase(threadId),
      kind: 'command',
      operationId: `render-${runtime.sequence}`,
      command: image.label,
      state: 'completed',
    };
    pushLocal(local);
    rowId = `${local.provider}:${local.threadId}:command:${local.kind === 'command' ? local.operationId : ''}`;
  }
  useAssistant.setState((s) => {
    const entries = Object.entries({
      ...s.images,
      [rowId!]: [
        ...(s.images[rowId!] ?? []),
        { data: `data:${image.mediaType};base64,${image.data}`, label: image.label },
      ].slice(-8),
    });
    return { images: Object.fromEntries(entries.slice(-MAX_IMAGES)) };
  });
}

// ---- local events ---------------------------------------------------------------------------

function localBase(threadId = runtime.threadId ?? 'local') {
  const provider: HarnessProvider = (runtime.adapter?.identity.provider ??
    useAssistant.getState().provider ??
    'claude') as HarnessProvider;
  runtime.sequence += 1;
  return {
    schemaVersion: 1 as const,
    id: `local:${runtime.sequence}:${Date.now()}`,
    sequence: 1_000_000_000 + runtime.sequence,
    provider,
    threadId,
    createdAt: new Date().toISOString(),
  };
}

function pushLocal(event: NormalizedAgentEvent): void {
  useAssistant.setState((s) => ({ live: [...s.live, event] }));
}

function userMessage(text: string, threadId: string): NormalizedAgentEvent {
  const base = localBase(threadId);
  return {
    ...base,
    kind: 'message',
    messageId: `user-${base.id}`,
    role: 'user',
    text,
    streaming: false,
  };
}

function note(text: string, threadId: string): NormalizedAgentEvent {
  const base = localBase(threadId);
  return {
    ...base,
    kind: 'message',
    messageId: `note-${base.id}`,
    role: 'system',
    text,
    streaming: false,
  };
}

function localError(code: string, error: unknown): NormalizedAgentEvent {
  const redact = runtime.kit?.redact ?? ((text: string) => text);
  return {
    ...localBase(),
    kind: 'error',
    code,
    message: redact(error instanceof Error ? error.message : String(error)),
    recoverable: true,
  };
}

// ---- references ----------------------------------------------------------------------------

type ReferenceState = ReturnType<AssistantStoreApi['getState']>;

/** A chip for a selected item (bodies, faces, edges, steps, sketch profiles). */
export function referenceOf(item: SelectionItem, state: ReferenceState): AssistantReference | null {
  const bodies = state.evaluation.bodies;
  switch (item.kind) {
    case 'body': {
      const body = bodies.find((b) => b.id === item.bodyId);
      return body ? { key: `body:${body.id}`, label: `Body “${body.name}”`, item } : null;
    }
    case 'face': {
      const body = bodies.find((b) => b.id === item.bodyId);
      const face = body?.faces.find((f) => f.key === item.faceKey);
      if (!body || !face) return null;
      const name = describeFaceName(face, state.features);
      return { key: `face:${body.id}:${face.key}`, label: `Face ${name}`, item };
    }
    case 'edge': {
      const body = bodies.find((b) => b.id === item.bodyId);
      const edge = body?.edges.find((e) => e.key === item.edgeKey);
      if (!body || !edge) return null;
      const name = describeEdgeName(edge);
      return { key: `edge:${body.id}:${edge.key}`, label: `Edge ${name}`, item };
    }
    case 'feature':
    case 'sketchProfile':
    case 'datum': {
      const feature = state.features.find((f) => f.id === item.featureId);
      return feature
        ? { key: `${item.kind}:${feature.id}`, label: `Step “${feature.name}”`, item }
        : null;
    }
    default:
      return null;
  }
}

/** The prompt sent to the CLI (references resolved now) and the text shown in the transcript. */
export function composePrompt(
  text: string,
  references: readonly AssistantReference[],
  store: AssistantStoreApi,
): { prompt: string; display: string } {
  if (references.length === 0) return { prompt: text, display: text };
  const state = store.getState();
  const lines = references.map((reference) => {
    const current = referenceOf(reference.item, state);
    const target = refJson(reference.item);
    return current
      ? `- ${current.label}: ${JSON.stringify(target)}`
      : `- ${reference.label} (no longer exists): ${JSON.stringify(target)}`;
  });
  const block = `References the user selected in the app (use these ids):\n${lines.join('\n')}`;
  return {
    prompt: `${text}\n\n${block}`,
    display: `${text}\n\n${references.map((r) => `@ ${r.label}`).join('\n')}`,
  };
}

function refJson(item: SelectionItem): Json {
  switch (item.kind) {
    case 'body':
      return { bodyId: item.bodyId };
    case 'face':
      return { bodyId: item.bodyId, key: item.faceKey };
    case 'edge':
      return { bodyId: item.bodyId, key: item.edgeKey };
    default:
      return { ...item };
  }
}

/** A session name from the first prompt ("Enclosure for a Raspberry Pi 5…"). */
export function sessionName(prompt: string): string {
  const line = prompt.split('\n')[0]!.trim();
  return line.length > 48 ? `${line.slice(0, 47)}…` : line || 'Session';
}

export type { AssistantProvider };
