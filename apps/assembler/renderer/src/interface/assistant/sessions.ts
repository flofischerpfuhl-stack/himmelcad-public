/**
 * Assistant sessions saved with the project (`assistantSessions` in the
 * `.hcasm` file): the sanitized, finished transcript of each conversation —
 * user and assistant messages, tool calls, approvals, errors and turn
 * outcomes — so a project reopens with its conversations (Builder's agent
 * plan AG-D6, narrowed: no journal chunks, one bounded array per session).
 *
 * What is never stored: credentials or tokens (the shared redactor runs
 * first), hidden reasoning, render images, provider resume ids. A session
 * keeps only the host's opaque thread id; the mapping to the CLI's own
 * session lives in the app's local data, not in the file.
 */
import { create } from 'zustand';

import {
  registerProjectFileField,
  type FileFieldHelpers,
} from '../../foundation/document/format.js';
import type { ProjectSection } from '../../foundation/document/projectSections.js';

export type AssistantProvider = 'codex' | 'claude' | 'opencode';

export type StoredEvent =
  | { kind: 'message'; id: string; role: 'user' | 'assistant'; text: string; at: string }
  | { kind: 'command'; id: string; command: string; state: string; detail?: string; at: string }
  | {
      kind: 'approval';
      id: string;
      title: string;
      detail?: string;
      state: 'approved' | 'denied' | 'expired' | 'pending';
      at: string;
    }
  | { kind: 'error'; id: string; code: string; message: string; at: string }
  | { kind: 'state'; id: string; state: string; detail?: string; at: string };

export interface StoredSession {
  id: string;
  name: string;
  provider: AssistantProvider | null;
  /** The desktop host's opaque thread id (resume key); never a provider token. */
  threadId?: string;
  createdAt: string;
  updatedAt: string;
  /** `interrupted`: the last turn did not finish (stopped, failed, or the app closed). */
  state: 'idle' | 'interrupted';
  events: StoredEvent[];
}

export const MAX_SESSIONS = 30;
export const MAX_SESSION_EVENTS = 400;
export const MAX_EVENT_TEXT = 16 * 1024;
const PROVIDERS: readonly string[] = ['codex', 'claude', 'opencode'];

export function boundText(text: string, max = MAX_EVENT_TEXT): string {
  return text.length > max ? `${text.slice(0, max)}\n… (shortened)` : text;
}

/** Keeps the newest events within {@link MAX_SESSION_EVENTS}, with a visible marker when older ones go. */
export function boundEvents(events: readonly StoredEvent[]): StoredEvent[] {
  if (events.length <= MAX_SESSION_EVENTS) return [...events];
  const kept = events.slice(events.length - (MAX_SESSION_EVENTS - 1));
  return [
    {
      kind: 'state',
      id: `trimmed-${kept[0]!.id}`,
      state: 'trimmed',
      detail: 'Earlier messages of this session were removed to keep the project file small.',
      at: kept[0]!.at,
    },
    ...kept,
  ];
}

export function newSessionId(): string {
  return globalThis.crypto.randomUUID();
}

interface SessionsState {
  sessions: readonly StoredSession[];
  activeId: string | null;
  create(provider: AssistantProvider | null, name?: string): StoredSession;
  update(id: string, patch: (session: StoredSession) => StoredSession): void;
  remove(id: string): void;
  setActive(id: string | null): void;
  replaceAll(sessions: readonly StoredSession[]): void;
}

export const useAssistantSessions = create<SessionsState>((set, get) => ({
  sessions: [],
  activeId: null,
  create: (provider, name) => {
    const now = new Date().toISOString();
    const session: StoredSession = {
      id: newSessionId(),
      name: name ?? `Session ${get().sessions.length + 1}`,
      provider,
      createdAt: now,
      updatedAt: now,
      state: 'idle',
      events: [],
    };
    // The oldest sessions go first when the project holds too many.
    const sessions = [...get().sessions, session].slice(-MAX_SESSIONS);
    set({ sessions, activeId: session.id });
    return session;
  },
  update: (id, patch) =>
    set((s) => ({
      sessions: s.sessions.map((session) => (session.id === id ? patch(session) : session)),
    })),
  remove: (id) =>
    set((s) => ({
      sessions: s.sessions.filter((session) => session.id !== id),
      activeId: s.activeId === id ? null : s.activeId,
    })),
  setActive: (id) => set({ activeId: id }),
  replaceAll: (sessions) => set({ sessions: [...sessions], activeId: sessions.at(-1)?.id ?? null }),
}));

// ---- project file -----------------------------------------------------------------------

declare module '../../foundation/document/format.js' {
  interface ProjectFileFields {
    /** Assistant conversations (Block 9; additive, written only when present). */
    assistantSessions?: StoredSession[];
  }
}

const EVENT_KINDS = new Set(['message', 'command', 'approval', 'error', 'state']);

function validateSessions(raw: unknown, h: FileFieldHelpers): StoredSession[] {
  if (!Array.isArray(raw)) h.fail('assistantSessions', 'expected an array');
  if (raw.length > MAX_SESSIONS) h.fail('assistantSessions', `at most ${MAX_SESSIONS} sessions`);
  return raw.map((r: unknown, i) => {
    const path = `assistantSessions[${i}]`;
    if (!h.isRecord(r)) h.fail(path, 'expected an object');
    for (const key of ['id', 'name', 'createdAt', 'updatedAt'] as const) {
      if (
        !h.isString(r[key]) ||
        (r[key] as string).length === 0 ||
        (r[key] as string).length > 200
      ) {
        h.fail(`${path}.${key}`, 'expected a short string');
      }
    }
    if (r.provider !== null && !PROVIDERS.includes(r.provider as string)) {
      h.fail(`${path}.provider`, 'expected codex, claude, opencode or null');
    }
    if (r.threadId !== undefined && (!h.isString(r.threadId) || r.threadId.length > 512)) {
      h.fail(`${path}.threadId`, 'expected a string');
    }
    if (r.state !== 'idle' && r.state !== 'interrupted')
      h.fail(`${path}.state`, 'expected idle or interrupted');
    if (!Array.isArray(r.events) || r.events.length > MAX_SESSION_EVENTS) {
      h.fail(`${path}.events`, `expected at most ${MAX_SESSION_EVENTS} events`);
    }
    const events = (r.events as unknown[]).map((e, j) => {
      const at = `${path}.events[${j}]`;
      if (!h.isRecord(e) || !EVENT_KINDS.has(e.kind as string)) h.fail(at, 'expected an event');
      if (!h.isString(e.id) || !h.isString(e.at)) h.fail(at, 'expected id and at');
      for (const key of [
        'text',
        'command',
        'title',
        'detail',
        'message',
        'state',
        'code',
        'role',
      ]) {
        if (
          e[key] !== undefined &&
          (!h.isString(e[key]) || (e[key] as string).length > MAX_EVENT_TEXT + 32)
        ) {
          h.fail(`${at}.${key}`, 'expected a bounded string');
        }
      }
      return e as unknown as StoredEvent;
    });
    return {
      id: r.id as string,
      name: r.name as string,
      provider: (r.provider as AssistantProvider | null) ?? null,
      ...(typeof r.threadId === 'string' ? { threadId: r.threadId } : {}),
      createdAt: r.createdAt as string,
      updatedAt: r.updatedAt as string,
      state: r.state as StoredSession['state'],
      events,
    };
  });
}

registerProjectFileField({
  key: 'assistantSessions',
  module: 'assistant',
  order: 410,
  validate: validateSessions,
  include: (sessions) => sessions.length > 0,
});

export const SESSIONS_PROJECT_SECTION: ProjectSection = {
  id: 'assistant.sessions',
  order: 410,
  save: () => {
    const sessions = useAssistantSessions.getState().sessions.filter((s) => s.events.length > 0);
    return sessions.length > 0
      ? { fields: { assistantSessions: sessions.map((s) => ({ ...s })) } }
      : {};
  },
  load: (project) => useAssistantSessions.getState().replaceAll(project?.assistantSessions ?? []),
  subscribe: (onChange) =>
    useAssistantSessions.subscribe((state, previous) => {
      if (state.sessions !== previous.sessions) onChange();
    }),
};
