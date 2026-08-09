import {
  AGENT_EVENT_SCHEMA_VERSION,
  type AgentMessageRole,
  type HarnessProvider,
  type NormalizedAgentEvent,
} from './events.js';
import { redactSensitiveText } from './queue.js';

export interface ProviderNormalizeContext {
  threadId: string;
  turnId?: string;
  nextSequence(): number;
  now(): string;
}

export type ProviderEventNormalizer = (
  payload: unknown,
  context: ProviderNormalizeContext,
) => NormalizedAgentEvent | null;

export const PROVIDER_EVENT_NORMALIZERS: Readonly<
  Record<HarnessProvider, ProviderEventNormalizer>
> = {
  codex: normalizeCodexEvent,
  claude: normalizeClaudeEvent,
  opencode: normalizeOpenCodeEvent,
};

export function normalizeCodexEvent(
  payload: unknown,
  context: ProviderNormalizeContext,
): NormalizedAgentEvent | null {
  const value = record(payload);
  if (!value) return null;
  const method = text(value.method) || text(value.type) || text(value.kind);
  const data = record(value.params) ?? record(value.item) ?? value;
  if (/agent_message|assistant_message|message\.delta/i.test(method)) {
    return message('codex', data, context, 'assistant');
  }
  if (/user_message/i.test(method)) return message('codex', data, context, 'user');
  if (/reasoning/i.test(method)) return reasoning('codex', data, context);
  if (/command|exec/i.test(method)) return command('codex', data, context);
  if (/file_change|patch/i.test(method)) return fileChange('codex', data, context);
  if (/approval|request\/permissions/i.test(method)) return approval('codex', data, context);
  if (/turn.*(start|complete|interrupt|fail)/i.test(method))
    return turnState('codex', method, data, context);
  if (/error/i.test(method)) return errorEvent('codex', data, context);
  if (/usage|token/i.test(method)) return usage('codex', data, context);
  return null;
}

export function normalizeClaudeEvent(
  payload: unknown,
  context: ProviderNormalizeContext,
): NormalizedAgentEvent | null {
  const value = record(payload);
  if (!value) return null;
  const type = text(value.type) || text(value.kind);
  const data = record(value.message) ?? record(value.content_block) ?? value;
  if (/assistant|content_block_delta|text_delta/i.test(type)) {
    return message('claude', data, context, 'assistant');
  }
  if (/tool_use|tool_result/i.test(type)) return command('claude', data, context);
  if (/permission|approval/i.test(type)) return approval('claude', data, context);
  if (/error/i.test(type)) return errorEvent('claude', data, context);
  if (/result|usage/i.test(type)) return usage('claude', data, context);
  return null;
}

export function normalizeOpenCodeEvent(
  payload: unknown,
  context: ProviderNormalizeContext,
): NormalizedAgentEvent | null {
  const value = record(payload);
  if (!value) return null;
  const type = text(value.type) || text(value.kind);
  const data = record(value.properties) ?? record(value.part) ?? value;
  if (/message|text/i.test(type)) return message('opencode', data, context, 'assistant');
  if (/tool|command/i.test(type)) return command('opencode', data, context);
  if (/file/i.test(type)) return fileChange('opencode', data, context);
  if (/permission|approval/i.test(type)) return approval('opencode', data, context);
  if (/error/i.test(type)) return errorEvent('opencode', data, context);
  return null;
}

function base(provider: HarnessProvider, context: ProviderNormalizeContext, suffix: string) {
  const sequence = context.nextSequence();
  return {
    schemaVersion: AGENT_EVENT_SCHEMA_VERSION,
    id: `${provider}:${context.threadId}:${sequence}:${suffix}`,
    sequence,
    provider,
    threadId: context.threadId,
    ...(context.turnId ? { turnId: context.turnId } : {}),
    createdAt: context.now(),
  } as const;
}

function message(
  provider: HarnessProvider,
  data: Record<string, unknown>,
  context: ProviderNormalizeContext,
  fallbackRole: AgentMessageRole,
): NormalizedAgentEvent {
  const id = text(data.messageId) || text(data.id) || `message-${context.nextSequence()}`;
  return {
    ...base(provider, context, id),
    kind: 'message',
    messageId: id,
    role: role(data.role) ?? fallbackRole,
    text: text(data.text) || text(data.delta) || text(data.content),
    streaming: boolean(data.streaming) ?? /delta/i.test(text(data.type)),
  };
}

function reasoning(
  provider: HarnessProvider,
  data: Record<string, unknown>,
  context: ProviderNormalizeContext,
): NormalizedAgentEvent {
  const id = text(data.id) || 'reasoning';
  return {
    ...base(provider, context, id),
    kind: 'reasoning',
    reasoningId: id,
    summary: text(data.summary) || text(data.text) || text(data.delta),
    streaming: boolean(data.streaming) ?? true,
  };
}

function command(
  provider: HarnessProvider,
  data: Record<string, unknown>,
  context: ProviderNormalizeContext,
): NormalizedAgentEvent {
  const exitCode = number(data.exitCode);
  return {
    ...base(provider, context, 'command'),
    kind: 'command',
    operationId: text(data.operationId) || text(data.callId) || text(data.id) || 'command',
    command: text(data.command) || text(data.name) || 'Command',
    state: commandState(text(data.state) || text(data.status)),
    ...(exitCode === undefined ? {} : { exitCode }),
    ...(text(data.outputPreview)
      ? { outputPreview: text(data.outputPreview).slice(0, 8_192) }
      : {}),
  };
}

function fileChange(
  provider: HarnessProvider,
  data: Record<string, unknown>,
  context: ProviderNormalizeContext,
): NormalizedAgentEvent {
  const additions = number(data.additions);
  const deletions = number(data.deletions);
  return {
    ...base(provider, context, 'file'),
    kind: 'fileChange',
    operationId: text(data.operationId) || text(data.id) || 'file-change',
    pathLabel: text(data.pathLabel) || text(data.path) || 'file',
    change: fileChangeKind(text(data.change) || text(data.action)),
    ...(additions === undefined ? {} : { additions }),
    ...(deletions === undefined ? {} : { deletions }),
  };
}

function approval(
  provider: HarnessProvider,
  data: Record<string, unknown>,
  context: ProviderNormalizeContext,
): NormalizedAgentEvent {
  return {
    ...base(provider, context, 'approval'),
    kind: 'approval',
    requestId: text(data.requestId) || text(data.id) || 'approval',
    state: approvalState(text(data.state)),
    title: text(data.title) || text(data.command) || 'Approval required',
    ...(text(data.detail) ? { detail: text(data.detail) } : {}),
    destructive: boolean(data.destructive) ?? false,
  };
}

function turnState(
  provider: HarnessProvider,
  method: string,
  data: Record<string, unknown>,
  context: ProviderNormalizeContext,
): NormalizedAgentEvent {
  const state = /fail/i.test(method)
    ? 'failed'
    : /interrupt/i.test(method)
      ? 'interrupted'
      : /complete/i.test(method)
        ? 'completed'
        : 'running';
  return {
    ...base(provider, context, 'turn-state'),
    kind: 'turnState',
    state,
    ...(text(data.detail) ? { detail: text(data.detail) } : {}),
  };
}

function errorEvent(
  provider: HarnessProvider,
  data: Record<string, unknown>,
  context: ProviderNormalizeContext,
): NormalizedAgentEvent {
  return {
    ...base(provider, context, 'error'),
    kind: 'error',
    code: text(data.code) || 'provider_error',
    message: text(data.message) || text(data.error) || 'Provider error',
    recoverable: boolean(data.recoverable) ?? true,
  };
}

function usage(
  provider: HarnessProvider,
  data: Record<string, unknown>,
  context: ProviderNormalizeContext,
): NormalizedAgentEvent {
  const inputTokens = number(data.inputTokens);
  const outputTokens = number(data.outputTokens);
  return {
    ...base(provider, context, 'usage'),
    kind: 'usage',
    ...(inputTokens === undefined ? {} : { inputTokens }),
    ...(outputTokens === undefined ? {} : { outputTokens }),
  };
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function text(value: unknown): string {
  return typeof value === 'string' ? redactSensitiveText(value, 128 * 1024) : '';
}

function number(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function boolean(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

function role(value: unknown): AgentMessageRole | undefined {
  return value === 'user' || value === 'assistant' || value === 'system' ? value : undefined;
}

function commandState(
  value: string,
): 'queued' | 'running' | 'completed' | 'failed' | 'interrupted' {
  if (value === 'queued' || value === 'failed' || value === 'interrupted') return value;
  return /complete|success/i.test(value) ? 'completed' : 'running';
}

function approvalState(value: string): 'pending' | 'approved' | 'denied' | 'expired' {
  return value === 'approved' || value === 'denied' || value === 'expired' ? value : 'pending';
}

function fileChangeKind(value: string): 'create' | 'modify' | 'delete' | 'rename' {
  return value === 'create' || value === 'delete' || value === 'rename' ? value : 'modify';
}
