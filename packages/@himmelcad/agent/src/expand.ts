import type { HarnessProvider } from './events.js';

/**
 * Splits one raw harness payload into the payload shapes the provider
 * normalizers (`normalize.ts`) understand, one normalized event each.
 *
 * The CLIs' non-interactive JSON streams bundle several things into one
 * line: Claude's `stream-json` `assistant` message carries text and tool-use
 * blocks together, its `user` message carries tool results, and Codex's
 * `exec --json` wraps every message, command and MCP call in `item.*`
 * envelopes. Payloads that are already in a normalizer's shape (app-server
 * notifications, host lifecycle payloads, earlier fixtures) pass through
 * unchanged, so existing behaviour stays as it was.
 *
 * The expander is stateful per thread: it remembers tool names by call id,
 * so a tool result keeps the command label of its call.
 */
export type ProviderPayloadExpander = (payload: unknown) => readonly unknown[];

const MAX_TRACKED_CALLS = 512;
const MAX_PREVIEW_CHARS = 4_000;

export function createProviderPayloadExpander(provider: HarnessProvider): ProviderPayloadExpander {
  const calls = new Map<string, string>();
  const remember = (id: string, label: string): void => {
    calls.set(id, label);
    if (calls.size > MAX_TRACKED_CALLS) calls.delete(calls.keys().next().value!);
  };
  if (provider === 'claude') return (payload) => expandClaude(payload, calls, remember);
  if (provider === 'codex') return (payload) => expandCodex(payload);
  return (payload) => expandOpenCode(payload, calls, remember);
}

/** A readable label for a tool call: the tool name without an MCP prefix, plus its `method`/`id` argument. */
export function toolCallLabel(name: string, input: unknown): string {
  const bare = name.replace(/^mcp__[^_]+(?:_[^_]+)*?__/u, '');
  const args = record(input);
  const detail = args
    ? (str(args.method) ?? str(args.id) ?? str(args.view) ?? str(args.query) ?? null)
    : null;
  return detail ? `${bare} · ${detail}` : bare;
}

function expandClaude(
  payload: unknown,
  calls: Map<string, string>,
  remember: (id: string, label: string) => void,
): readonly unknown[] {
  const value = record(payload);
  if (!value) return [payload];
  const type = str(value.type);
  const message = record(value.message);
  const content = message && Array.isArray(message.content) ? message.content : null;
  if (type === 'system') return [];
  if (type === 'assistant' && message && content) {
    const id = str(message.id) ?? 'assistant';
    const out: unknown[] = [];
    content.forEach((raw, index) => {
      const block = record(raw);
      if (!block) return;
      if (block.type === 'text' && typeof block.text === 'string' && block.text.trim()) {
        out.push({
          type: 'assistant',
          message: { id: `${id}:${index}`, role: 'assistant', text: block.text, streaming: false },
        });
      } else if (block.type === 'tool_use') {
        const callId = str(block.id) ?? `${id}:${index}`;
        const label = toolCallLabel(str(block.name) ?? 'tool', block.input);
        remember(callId, label);
        out.push({ type: 'tool_use', id: callId, command: label, state: 'running' });
      }
      // `thinking` blocks are hidden reasoning: never shown or stored.
    });
    return out;
  }
  if (type === 'user' && content) {
    const out: unknown[] = [];
    for (const raw of content) {
      const block = record(raw);
      if (!block || block.type !== 'tool_result') continue;
      const callId = str(block.tool_use_id) ?? 'tool';
      out.push({
        type: 'tool_result',
        id: callId,
        command: calls.get(callId) ?? 'tool',
        state: block.is_error === true ? 'failed' : 'completed',
        outputPreview: preview(toolResultText(block.content)),
      });
    }
    return out;
  }
  if (type === 'result') {
    const usage = record(value.usage);
    const out: unknown[] = [
      {
        type: 'usage',
        ...(usage && num(usage.input_tokens) !== undefined
          ? { inputTokens: num(usage.input_tokens) }
          : {}),
        ...(usage && num(usage.output_tokens) !== undefined
          ? { outputTokens: num(usage.output_tokens) }
          : {}),
      },
    ];
    if (value.is_error === true) {
      out.push({
        type: 'error',
        code: 'provider_error',
        message: str(value.result) ?? str(value.subtype) ?? 'The harness reported an error.',
        recoverable: true,
      });
    }
    return out;
  }
  return [payload];
}

function expandCodex(payload: unknown): readonly unknown[] {
  const value = record(payload);
  if (!value) return [payload];
  const type = str(value.type);
  if (type === 'thread.started') return [];
  if (type === 'turn.completed') {
    const usage = record(value.usage);
    if (!usage) return [payload];
    return [
      payload,
      {
        type: 'usage',
        params: {
          ...(num(usage.input_tokens) !== undefined
            ? { inputTokens: num(usage.input_tokens) }
            : {}),
          ...(num(usage.output_tokens) !== undefined
            ? { outputTokens: num(usage.output_tokens) }
            : {}),
        },
      },
    ];
  }
  if (type === 'turn.failed') {
    const error = record(value.error);
    return [
      payload,
      {
        type: 'error',
        params: { code: 'turn_failed', message: str(error?.message) ?? 'The turn failed.' },
      },
    ];
  }
  if (!type || !/^item\.(started|updated|completed)$/u.test(type)) return [payload];
  const item = record(value.item);
  if (!item) return [];
  const id = str(item.id) ?? 'item';
  const done = type === 'item.completed';
  switch (item.type) {
    // Messages and reasoning summaries arrive whole when their item completes.
    case 'agent_message':
      return done && str(item.text)
        ? [{ type: 'agent_message', item: { id, text: item.text, streaming: false } }]
        : [];
    case 'reasoning':
      return done && str(item.text)
        ? [{ type: 'reasoning', item: { id, summary: item.text, streaming: false } }]
        : [];
    case 'command_execution':
      return [
        {
          type: 'command_execution',
          item: {
            id,
            command: str(item.command) ?? 'command',
            state: codexState(item.status, done),
            ...(num(item.exit_code) !== undefined ? { exitCode: num(item.exit_code) } : {}),
            ...(str(item.aggregated_output)
              ? { outputPreview: preview(str(item.aggregated_output)!) }
              : {}),
          },
        },
      ];
    case 'mcp_tool_call': {
      const name = [str(item.server), str(item.tool)].filter(Boolean).join('.') || 'tool';
      const error = record(item.error);
      return [
        {
          type: 'command',
          item: {
            id,
            command: toolCallLabel(name, item.arguments),
            state: error ? 'failed' : codexState(item.status, done),
            ...(error && str(error.message)
              ? { outputPreview: preview(str(error.message)!) }
              : item.result !== undefined
                ? { outputPreview: preview(toolResultText(record(item.result)?.content)) }
                : {}),
          },
        },
      ];
    }
    case 'file_change': {
      const changes = Array.isArray(item.changes) ? item.changes.map(record) : [];
      return changes
        .filter((change): change is Record<string, unknown> => change !== null)
        .map((change, index) => ({
          type: 'file_change',
          item: {
            id: `${id}:${index}`,
            path: str(change.path) ?? 'file',
            change: str(change.kind) === 'add' ? 'create' : (str(change.kind) ?? 'modify'),
          },
        }));
    }
    case 'error':
      return [
        { type: 'error', item: { code: 'item_error', message: str(item.message) ?? 'Error' } },
      ];
    default:
      return [];
  }
}

function expandOpenCode(
  payload: unknown,
  calls: Map<string, string>,
  remember: (id: string, label: string) => void,
): readonly unknown[] {
  const value = record(payload);
  if (!value) return [payload];
  const part = record(value.part);
  if (str(value.type) === 'tool_use' && part) {
    const state = record(part.state);
    const callId = str(part.callID) ?? str(part.id) ?? 'tool';
    const label = calls.get(callId) ?? toolCallLabel(str(part.tool) ?? 'tool', state?.input);
    remember(callId, label);
    const status = str(state?.status) ?? 'running';
    const output = str(state?.output) ?? str(state?.error);
    return [
      {
        type: 'tool',
        part: {
          id: callId,
          command: label,
          state: status === 'error' ? 'failed' : status,
          ...(output ? { outputPreview: preview(output) } : {}),
        },
      },
    ];
  }
  if (str(value.type) === 'step_start' || str(value.type) === 'step_finish') return [];
  return [payload];
}

function codexState(status: unknown, done: boolean): string {
  if (status === 'failed' || status === 'declined') return 'failed';
  if (status === 'completed' || done) return 'completed';
  return 'running';
}

/** The text of an MCP/Claude tool result (`string` or `[{type: 'text', text}]` blocks; images are named, not copied). */
function toolResultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((raw) => {
      const block = record(raw);
      if (!block) return '';
      if (block.type === 'text' && typeof block.text === 'string') return block.text;
      if (block.type === 'image') return '[image]';
      return '';
    })
    .filter(Boolean)
    .join('\n');
}

function preview(text: string): string {
  return text.length > MAX_PREVIEW_CHARS ? `${text.slice(0, MAX_PREVIEW_CHARS)} …` : text;
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function num(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}
