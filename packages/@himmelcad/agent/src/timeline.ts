import type { NormalizedAgentEvent } from './events.js';
import { structurallyShareRows, type StableRowsState } from './vendor/t3code/stableRows.js';

export const MAX_TIMELINE_MESSAGE_CHARS = 256 * 1024;
export const MAX_TIMELINE_REASONING_CHARS = 128 * 1024;
const STREAM_TRUNCATION_MARKER = '\n… earlier streamed content truncated …\n';

export type AgentTimelineRow =
  | {
      id: string;
      kind: 'message';
      sequence: number;
      role: 'user' | 'assistant' | 'system';
      text: string;
      streaming: boolean;
      createdAt: string;
    }
  | {
      id: string;
      kind: 'reasoning';
      sequence: number;
      summary: string;
      streaming: boolean;
      createdAt: string;
    }
  | {
      id: string;
      kind: 'command';
      sequence: number;
      operationId: string;
      command: string;
      state: string;
      detail?: string;
      createdAt: string;
    }
  | {
      id: string;
      kind: 'fileChange';
      sequence: number;
      operationId: string;
      title: string;
      detail: string;
      createdAt: string;
    }
  | {
      id: string;
      kind: 'approval';
      sequence: number;
      requestId: string;
      state: string;
      title: string;
      detail?: string;
      destructive: boolean;
      createdAt: string;
    }
  | {
      id: string;
      kind: 'error';
      sequence: number;
      code: string;
      message: string;
      recoverable: boolean;
      createdAt: string;
    }
  | {
      id: string;
      kind: 'state';
      sequence: number;
      state: string;
      detail?: string;
      createdAt: string;
    }
  | {
      id: string;
      kind: 'usage';
      sequence: number;
      detail: string;
      createdAt: string;
    };

export type AgentTimelineState = StableRowsState<AgentTimelineRow>;

export function emptyAgentTimelineState(): AgentTimelineState {
  return { byId: new Map(), result: [] };
}

export function deriveAgentTimelineRows(
  events: readonly NormalizedAgentEvent[],
  previous: AgentTimelineState = emptyAgentTimelineState(),
): AgentTimelineState {
  const rows: AgentTimelineRow[] = [];
  const position = new Map<string, number>();
  for (const event of events) {
    const next = rowFromEvent(event, rows, position);
    const existing = position.get(next.id);
    if (existing === undefined) {
      position.set(next.id, rows.length);
      rows.push(next);
    } else {
      rows[existing] = mergeRow(rows[existing]!, next, event);
    }
  }
  return structurallyShareRows(rows, previous, rowUnchanged);
}

function rowFromEvent(
  event: NormalizedAgentEvent,
  rows: readonly AgentTimelineRow[],
  position: ReadonlyMap<string, number>,
): AgentTimelineRow {
  const scope = `${event.provider}:${event.threadId}`;
  if (event.kind === 'message') {
    return {
      id: `${scope}:message:${event.messageId}`,
      kind: 'message',
      sequence: event.sequence,
      role: event.role,
      text: event.text,
      streaming: event.streaming,
      createdAt: event.createdAt,
    };
  }
  if (event.kind === 'reasoning') {
    return {
      id: `${scope}:reasoning:${event.reasoningId}`,
      kind: 'reasoning',
      sequence: event.sequence,
      summary: event.summary,
      streaming: event.streaming,
      createdAt: event.createdAt,
    };
  }
  if (event.kind === 'command') {
    return {
      id: `${scope}:command:${event.operationId}`,
      kind: 'command',
      sequence: event.sequence,
      operationId: event.operationId,
      command: event.command,
      state: event.state,
      ...(event.outputPreview ? { detail: event.outputPreview } : {}),
      createdAt: event.createdAt,
    };
  }
  if (event.kind === 'fileChange') {
    return {
      id: `${scope}:file:${event.operationId}:${event.pathLabel}`,
      kind: 'fileChange',
      sequence: event.sequence,
      operationId: event.operationId,
      title: `${event.change} · ${event.pathLabel}`,
      detail: `${event.additions ?? 0} additions · ${event.deletions ?? 0} deletions`,
      createdAt: event.createdAt,
    };
  }
  if (event.kind === 'approval') {
    return {
      id: `${scope}:approval:${event.requestId}`,
      kind: 'approval',
      sequence: event.sequence,
      requestId: event.requestId,
      state: event.state,
      title: event.title,
      ...(event.detail ? { detail: event.detail } : {}),
      destructive: event.destructive,
      createdAt: event.createdAt,
    };
  }
  if (event.kind === 'error') {
    return {
      id: `${scope}:error:${event.id}`,
      kind: 'error',
      sequence: event.sequence,
      code: event.code,
      message: event.message,
      recoverable: event.recoverable,
      createdAt: event.createdAt,
    };
  }
  if (event.kind === 'usage') {
    return {
      id: `${scope}:usage:${event.turnId ?? event.threadId}`,
      kind: 'usage',
      sequence: event.sequence,
      detail: `${event.inputTokens ?? 0} input · ${event.outputTokens ?? 0} output · ${event.cachedInputTokens ?? 0} cached`,
      createdAt: event.createdAt,
    };
  }
  const stateId = `${scope}:${event.kind}:${event.turnId ?? event.threadId}`;
  const prior = position.get(stateId);
  return {
    id: stateId,
    kind: 'state',
    sequence: event.sequence,
    state: event.state,
    ...(event.detail ? { detail: event.detail } : {}),
    createdAt: prior === undefined ? event.createdAt : rows[prior]!.createdAt,
  };
}

function mergeRow(
  previous: AgentTimelineRow,
  next: AgentTimelineRow,
  event: NormalizedAgentEvent,
): AgentTimelineRow {
  if (previous.kind === 'message' && next.kind === 'message') {
    return {
      ...next,
      text:
        event.kind === 'message' && event.streaming
          ? appendBoundedTimelineText(previous.text, event.text, MAX_TIMELINE_MESSAGE_CHARS)
          : next.text,
      createdAt: previous.createdAt,
    };
  }
  if (previous.kind === 'reasoning' && next.kind === 'reasoning') {
    return {
      ...next,
      summary:
        event.kind === 'reasoning' && event.streaming
          ? appendBoundedTimelineText(previous.summary, event.summary, MAX_TIMELINE_REASONING_CHARS)
          : next.summary,
      createdAt: previous.createdAt,
    };
  }
  return { ...next, createdAt: previous.createdAt };
}

function appendBoundedTimelineText(previous: string, chunk: string, limit: number): string {
  const joined = previous + chunk;
  if (joined.length <= limit) return joined;
  const contentBudget = limit - STREAM_TRUNCATION_MARKER.length;
  const headLength = Math.floor(contentBudget / 3);
  const tailLength = contentBudget - headLength;
  return `${joined.slice(0, headLength)}${STREAM_TRUNCATION_MARKER}${joined.slice(-tailLength)}`;
}

function rowUnchanged(left: AgentTimelineRow, right: AgentTimelineRow): boolean {
  if (left.kind !== right.kind || left.id !== right.id) return false;
  return shallowEqual(left, right);
}

function shallowEqual(left: object, right: object): boolean {
  const leftEntries = Object.entries(left);
  const rightEntries = Object.entries(right);
  return (
    leftEntries.length === rightEntries.length &&
    leftEntries.every(([key, value]) => (right as Record<string, unknown>)[key] === value)
  );
}
