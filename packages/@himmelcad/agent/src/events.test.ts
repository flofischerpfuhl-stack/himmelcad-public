import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  AGENT_EVENT_SCHEMA_VERSION,
  validateNormalizedAgentEvent,
  type NormalizedAgentEvent,
} from './events.js';

describe('normalized event validation', () => {
  it('accepts a bounded versioned message', () => {
    assert.doesNotThrow(() => validateNormalizedAgentEvent(message()));
  });

  it('fails closed for provider, kind, date, sequence and kind-specific identity', () => {
    assert.throws(
      () => validateNormalizedAgentEvent({ ...message(), provider: 'other' } as never),
      /provider/i,
    );
    assert.throws(
      () => validateNormalizedAgentEvent({ ...message(), kind: 'mystery' } as never),
      /kind/i,
    );
    assert.throws(
      () => validateNormalizedAgentEvent({ ...message(), createdAt: 'yesterday' }),
      /identity/i,
    );
    assert.throws(() => validateNormalizedAgentEvent({ ...message(), sequence: -1 }), /identity/i);
    assert.throws(
      () => validateNormalizedAgentEvent({ ...message(), messageId: '' }),
      /message id/i,
    );
    assert.throws(
      () => validateNormalizedAgentEvent({ ...message(), text: 'x'.repeat(128 * 1024 + 1) }),
      /bound/i,
    );
  });
});

function message(): Extract<NormalizedAgentEvent, { kind: 'message' }> {
  return {
    schemaVersion: AGENT_EVENT_SCHEMA_VERSION,
    id: 'event-1',
    sequence: 1,
    provider: 'codex',
    threadId: 'thread-1',
    turnId: 'turn-1',
    createdAt: '2026-01-01T00:00:00.000Z',
    kind: 'message',
    messageId: 'message-1',
    role: 'assistant',
    text: 'safe',
    streaming: false,
  };
}
