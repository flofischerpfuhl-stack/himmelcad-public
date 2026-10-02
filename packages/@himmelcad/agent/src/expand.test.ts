import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { createProviderPayloadExpander, toolCallLabel } from './expand.js';
import type { NormalizedAgentEvent } from './events.js';
import { PROVIDER_EVENT_NORMALIZERS } from './normalize.js';
import { deriveAgentTimelineRows } from './timeline.js';

function normalizeAll(
  provider: 'claude' | 'codex' | 'opencode',
  payloads: readonly unknown[],
): NormalizedAgentEvent[] {
  const expand = createProviderPayloadExpander(provider);
  let sequence = 0;
  const events: NormalizedAgentEvent[] = [];
  for (const payload of payloads) {
    for (const part of expand(payload)) {
      const event = PROVIDER_EVENT_NORMALIZERS[provider](part, {
        threadId: 'thread-1',
        nextSequence: () => sequence++,
        now: () => '2026-10-02T00:00:00.000Z',
      });
      if (event) events.push(event);
    }
  }
  return events;
}

describe('provider payload expansion', () => {
  it('splits Claude stream-json messages into text, tool and usage events', () => {
    const events = normalizeAll('claude', [
      { type: 'system', subtype: 'init', session_id: 's1' },
      { type: 'turn.started' },
      {
        type: 'assistant',
        message: {
          id: 'msg_1',
          role: 'assistant',
          content: [
            { type: 'thinking', thinking: 'hidden chain' },
            { type: 'text', text: 'Creating the base plate.' },
            {
              type: 'tool_use',
              id: 'toolu_1',
              name: 'mcp__hcasm__hcasm_call',
              input: { method: 'feature.create', params: { kind: 'sketch' } },
            },
          ],
        },
      },
      {
        type: 'user',
        message: {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'toolu_1',
              content: [{ type: 'text', text: '{"featureId":"sketch-1"}' }],
            },
          ],
        },
      },
      { type: 'result', subtype: 'success', usage: { input_tokens: 12, output_tokens: 5 } },
      { type: 'turn.completed' },
    ]);
    assert.deepEqual(
      events.map((event) => event.kind),
      ['turnState', 'message', 'command', 'command', 'usage', 'turnState'],
    );
    assert.equal(JSON.stringify(events).includes('hidden chain'), false);
    const message = events[1]!;
    assert(message.kind === 'message');
    assert.equal(message.text, 'Creating the base plate.');
    const rows = deriveAgentTimelineRows(events).result;
    const command = rows.find((row) => row.kind === 'command');
    assert(command?.kind === 'command');
    assert.equal(command.command, 'hcasm_call · feature.create');
    assert.equal(command.state, 'completed');
    assert.match(command.detail ?? '', /sketch-1/);
    const last = events.at(-1)!;
    assert(last.kind === 'turnState');
    assert.equal(last.state, 'completed');
  });

  it('reports a failed Claude result as a recoverable error', () => {
    const events = normalizeAll('claude', [
      { type: 'result', subtype: 'error_during_execution', is_error: true, result: 'Rate limited' },
    ]);
    assert.deepEqual(
      events.map((event) => event.kind),
      ['usage', 'error'],
    );
    const error = events[1]!;
    assert(error.kind === 'error');
    assert.equal(error.message, 'Rate limited');
  });

  it('unwraps Codex exec items and keeps app-server payloads unchanged', () => {
    const events = normalizeAll('codex', [
      { type: 'thread.started', thread_id: 'th-1' },
      { type: 'turn.started' },
      { type: 'item.started', item: { id: 'i1', type: 'agent_message', text: '' } },
      { type: 'item.completed', item: { id: 'i1', type: 'agent_message', text: 'Done.' } },
      {
        type: 'item.started',
        item: {
          id: 'i2',
          type: 'mcp_tool_call',
          server: 'hcasm',
          tool: 'view_render',
          arguments: { view: 'iso' },
          status: 'in_progress',
        },
      },
      {
        type: 'item.completed',
        item: {
          id: 'i2',
          type: 'mcp_tool_call',
          server: 'hcasm',
          tool: 'view_render',
          arguments: { view: 'iso' },
          status: 'completed',
          result: { content: [{ type: 'image', data: 'AAAA', mimeType: 'image/png' }] },
        },
      },
      { type: 'turn.completed', usage: { input_tokens: 3, output_tokens: 4 } },
      { method: 'agent_message', params: { id: 'm9', text: 'app-server', streaming: false } },
    ]);
    assert.deepEqual(
      events.map((event) => event.kind),
      ['turnState', 'message', 'command', 'command', 'turnState', 'usage', 'message'],
    );
    const rows = deriveAgentTimelineRows(events).result;
    const command = rows.find((row) => row.kind === 'command');
    assert(command?.kind === 'command');
    assert.equal(command.command, 'hcasm.view_render · iso');
    assert.equal(command.state, 'completed');
    assert.equal(command.detail, '[image]');
  });

  it('labels OpenCode tool parts and ignores step markers', () => {
    const events = normalizeAll('opencode', [
      { type: 'step_start', part: {} },
      {
        type: 'tool_use',
        part: {
          callID: 'c1',
          tool: 'hcasm_skills_read',
          state: { status: 'completed', input: { id: 'printable-part' }, output: 'ok' },
        },
      },
      { type: 'text', part: { id: 'p1', text: 'Read the skill.' } },
      { type: 'turn.failed', detail: 'exit 1' },
    ]);
    assert.deepEqual(
      events.map((event) => event.kind),
      ['command', 'message', 'turnState'],
    );
    const command = events[0]!;
    assert(command.kind === 'command');
    assert.equal(command.command, 'hcasm_skills_read · printable-part');
    const state = events[2]!;
    assert(state.kind === 'turnState');
    assert.equal(state.state, 'failed');
    assert.equal(state.detail, 'exit 1');
  });

  it('strips MCP server prefixes from tool labels', () => {
    assert.equal(toolCallLabel('mcp__hcasm__view_render', { view: 'top' }), 'view_render · top');
    assert.equal(toolCallLabel('mcp__my_server__tool', {}), 'tool');
    assert.equal(toolCallLabel('Bash', null), 'Bash');
  });
});
