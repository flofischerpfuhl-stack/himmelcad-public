import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { AGENT_EVENT_SCHEMA_VERSION, type NormalizedAgentEvent } from './events.js';
import { deriveAgentTimelineRows, MAX_TIMELINE_MESSAGE_CHARS } from './timeline.js';

describe('normalized timeline rows', () => {
  it('merges streaming messages and reuses every unchanged row reference', () => {
    const events: NormalizedAgentEvent[] = [
      message(0, 'u', 'user', 'hello', false),
      message(1, 'a', 'assistant', 'hel', true),
      command(2, 'cmd', 'running'),
    ];
    const first = deriveAgentTimelineRows(events);
    const second = deriveAgentTimelineRows(
      [...events, message(3, 'a', 'assistant', 'lo', true)],
      first,
    );
    assert.strictEqual(second.result[0], first.result[0]);
    assert.notStrictEqual(second.result[1], first.result[1]);
    assert.strictEqual(second.result[2], first.result[2]);
    assert.equal(second.result[1]?.kind === 'message' ? second.result[1].text : '', 'hello');
  });

  it('renders approvals, file changes, errors and lifecycle separately', () => {
    const base = common(0);
    const rows = deriveAgentTimelineRows([
      {
        ...base,
        kind: 'approval',
        requestId: 'r',
        state: 'pending',
        title: 'Delete',
        destructive: true,
      },
      {
        ...common(1),
        kind: 'fileChange',
        operationId: 'f',
        pathLabel: 'a.ts',
        change: 'modify',
        additions: 2,
        deletions: 1,
      },
      { ...common(2), kind: 'error', code: 'boom', message: 'Failed', recoverable: true },
      { ...common(3), kind: 'turnState', state: 'interrupted' },
    ]);
    assert.deepEqual(
      rows.result.map((row) => row.kind),
      ['approval', 'fileChange', 'error', 'state'],
    );
  });

  it('does not merge provider-local IDs across threads', () => {
    const first = message(0, 'same-id', 'assistant', 'first', false);
    const second = {
      ...message(1, 'same-id', 'assistant', 'second', false),
      threadId: 'other-thread',
    };
    const rows = deriveAgentTimelineRows([first, second]).result;
    assert.equal(rows.length, 2);
    assert.notEqual(rows[0]?.id, rows[1]?.id);
  });

  it('bounds accumulated streaming text while retaining its beginning and latest tail', () => {
    const chunk = 'x'.repeat(100 * 1024);
    const events = [
      message(0, 'stream', 'assistant', `begin-${chunk}`, true),
      message(1, 'stream', 'assistant', chunk, true),
      message(2, 'stream', 'assistant', chunk, true),
      message(3, 'stream', 'assistant', `${chunk}-latest`, true),
    ];
    const row = deriveAgentTimelineRows(events).result[0];
    assert(row?.kind === 'message');
    assert.equal(row.text.length, MAX_TIMELINE_MESSAGE_CHARS);
    assert.equal(row.text.startsWith('begin-'), true);
    assert.equal(row.text.endsWith('-latest'), true);
    assert.match(row.text, /earlier streamed content truncated/);
  });
});

function common(sequence: number) {
  return {
    schemaVersion: AGENT_EVENT_SCHEMA_VERSION,
    id: `e-${sequence}`,
    sequence,
    provider: 'codex' as const,
    threadId: 't',
    turnId: 'turn',
    createdAt: `2026-01-01T00:00:${String(sequence).padStart(2, '0')}Z`,
  };
}

function message(
  sequence: number,
  messageId: string,
  role: 'user' | 'assistant',
  text: string,
  streaming: boolean,
): NormalizedAgentEvent {
  return { ...common(sequence), kind: 'message', messageId, role, text, streaming };
}

function command(sequence: number, operationId: string, state: 'running'): NormalizedAgentEvent {
  return { ...common(sequence), kind: 'command', operationId, command: 'echo safe', state };
}
