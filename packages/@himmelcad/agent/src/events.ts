export const AGENT_EVENT_SCHEMA_VERSION = 1 as const;

export type HarnessProvider = 'codex' | 'claude' | 'opencode';
export type AgentMessageRole = 'user' | 'assistant' | 'system';
export type AgentLifecycleState =
  | 'starting'
  | 'ready'
  | 'running'
  | 'awaitingApproval'
  | 'interrupted'
  | 'failed'
  | 'completed'
  | 'stopped';

export interface AgentEventBase {
  schemaVersion: typeof AGENT_EVENT_SCHEMA_VERSION;
  id: string;
  sequence: number;
  provider: HarnessProvider;
  threadId: string;
  turnId?: string;
  createdAt: string;
}

export interface AgentMessageEvent extends AgentEventBase {
  kind: 'message';
  messageId: string;
  role: AgentMessageRole;
  text: string;
  streaming: boolean;
}

export interface AgentReasoningEvent extends AgentEventBase {
  kind: 'reasoning';
  reasoningId: string;
  summary: string;
  streaming: boolean;
}

export interface AgentLifecycleEvent extends AgentEventBase {
  kind: 'threadState' | 'turnState';
  state: AgentLifecycleState;
  detail?: string;
}

export interface AgentCommandEvent extends AgentEventBase {
  kind: 'command';
  operationId: string;
  command: string;
  state: 'queued' | 'running' | 'completed' | 'failed' | 'interrupted';
  exitCode?: number;
  outputPreview?: string;
}

export interface AgentFileChangeEvent extends AgentEventBase {
  kind: 'fileChange';
  operationId: string;
  pathLabel: string;
  change: 'create' | 'modify' | 'delete' | 'rename';
  additions?: number;
  deletions?: number;
}

export interface AgentApprovalEvent extends AgentEventBase {
  kind: 'approval';
  requestId: string;
  state: 'pending' | 'approved' | 'denied' | 'expired';
  title: string;
  detail?: string;
  destructive: boolean;
  requestedCapability?: 'canonicalCommand' | 'filesystemWrite' | 'network' | 'process';
}

export interface AgentErrorEvent extends AgentEventBase {
  kind: 'error';
  code: string;
  message: string;
  recoverable: boolean;
}

export interface AgentUsageEvent extends AgentEventBase {
  kind: 'usage';
  inputTokens?: number;
  outputTokens?: number;
  cachedInputTokens?: number;
}

export type NormalizedAgentEvent =
  | AgentMessageEvent
  | AgentReasoningEvent
  | AgentLifecycleEvent
  | AgentCommandEvent
  | AgentFileChangeEvent
  | AgentApprovalEvent
  | AgentErrorEvent
  | AgentUsageEvent;

export type AgentEventInput = NormalizedAgentEvent extends infer Event
  ? Event extends NormalizedAgentEvent
    ? Omit<Event, 'schemaVersion'>
    : never
  : never;

export function agentEvent(input: AgentEventInput): NormalizedAgentEvent {
  return { ...input, schemaVersion: AGENT_EVENT_SCHEMA_VERSION } as NormalizedAgentEvent;
}

export function validateNormalizedAgentEvent(value: NormalizedAgentEvent): void {
  if (value.schemaVersion !== AGENT_EVENT_SCHEMA_VERSION)
    throw new Error('Unsupported agent event.');
  if (!['codex', 'claude', 'opencode'].includes(value.provider))
    throw new Error('Unknown provider.');
  if (
    !validIdentifier(value.id) ||
    !validIdentifier(value.threadId) ||
    !Number.isSafeInteger(value.sequence) ||
    value.sequence < 0 ||
    !Number.isFinite(Date.parse(value.createdAt)) ||
    value.createdAt.length > 64
  ) {
    throw new Error('Agent event identity is invalid.');
  }
  if (value.turnId !== undefined && !validIdentifier(value.turnId))
    throw new Error('Turn ID is invalid.');
  switch (value.kind) {
    case 'message':
      requireIdentifier(value.messageId, 'Message ID');
      requireString(value.text, 128 * 1024, 'Message');
      if (!['user', 'assistant', 'system'].includes(value.role))
        throw new Error('Message role is invalid.');
      if (typeof value.streaming !== 'boolean')
        throw new Error('Message streaming flag is invalid.');
      break;
    case 'reasoning':
      requireIdentifier(value.reasoningId, 'Reasoning ID');
      requireString(value.summary, 64 * 1024, 'Reasoning summary');
      if (typeof value.streaming !== 'boolean')
        throw new Error('Reasoning streaming flag is invalid.');
      break;
    case 'command':
      requireIdentifier(value.operationId, 'Operation ID');
      requireString(value.command, 32 * 1024, 'Command');
      if (value.outputPreview !== undefined)
        requireString(value.outputPreview, 8_192, 'Output preview');
      if (!['queued', 'running', 'completed', 'failed', 'interrupted'].includes(value.state))
        throw new Error('Command state is invalid.');
      if (value.exitCode !== undefined && !Number.isSafeInteger(value.exitCode))
        throw new Error('Command exit code is invalid.');
      break;
    case 'fileChange':
      requireIdentifier(value.operationId, 'Operation ID');
      requireString(value.pathLabel, 4_096, 'Path label');
      if (!['create', 'modify', 'delete', 'rename'].includes(value.change))
        throw new Error('File change kind is invalid.');
      for (const count of [value.additions, value.deletions]) {
        if (count !== undefined && (!Number.isSafeInteger(count) || count < 0))
          throw new Error('File change count is invalid.');
      }
      break;
    case 'approval':
      requireIdentifier(value.requestId, 'Approval ID');
      requireString(value.title, 8_192, 'Approval title');
      if (value.detail !== undefined) requireString(value.detail, 32 * 1024, 'Approval detail');
      if (!['pending', 'approved', 'denied', 'expired'].includes(value.state))
        throw new Error('Approval state is invalid.');
      if (typeof value.destructive !== 'boolean') throw new Error('Approval risk is invalid.');
      break;
    case 'error':
      requireIdentifier(value.code, 'Error code');
      requireString(value.message, 32 * 1024, 'Error message');
      if (typeof value.recoverable !== 'boolean')
        throw new Error('Error recovery flag is invalid.');
      break;
    case 'threadState':
    case 'turnState':
      if (value.detail !== undefined) requireString(value.detail, 32 * 1024, 'State detail');
      if (
        ![
          'starting',
          'ready',
          'running',
          'awaitingApproval',
          'interrupted',
          'failed',
          'completed',
          'stopped',
        ].includes(value.state)
      )
        throw new Error('Lifecycle state is invalid.');
      break;
    case 'usage':
      for (const count of [value.inputTokens, value.outputTokens, value.cachedInputTokens]) {
        if (count !== undefined && (!Number.isSafeInteger(count) || count < 0))
          throw new Error('Usage count is invalid.');
      }
      break;
    default:
      throw new Error('Unknown agent event kind.');
  }
  let serialized: string;
  try {
    serialized = JSON.stringify(value);
  } catch {
    throw new Error('Agent event is not serializable.');
  }
  if (serialized.length > 256 * 1024) throw new Error('Agent event exceeds 256 KiB.');
}

function validIdentifier(value: string): boolean {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= 512;
}

function requireIdentifier(value: string, label: string): void {
  if (!validIdentifier(value)) throw new Error(`${label} is invalid.`);
}

function requireString(value: string, maximumLength: number, label: string): void {
  if (typeof value !== 'string' || value.length > maximumLength)
    throw new Error(`${label} exceeds its bound.`);
}
