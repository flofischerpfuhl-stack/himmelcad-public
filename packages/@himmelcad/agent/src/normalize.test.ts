import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { normalizeCodexEvent } from './normalize.js';

describe('provider event normalization', () => {
  it('normalizes provider commands and removes credentials before product state', () => {
    let sequence = 0;
    const event = normalizeCodexEvent(
      {
        method: 'item/commandExecution/updated',
        params: {
          id: 'command-1',
          command: 'curl -H authorization=Bearer-secret',
          outputPreview: 'token=do-not-store Bearer abc.xyz',
          state: 'completed',
        },
      },
      {
        threadId: 'thread-1',
        nextSequence: () => sequence++,
        now: () => '2026-01-01T00:00:00.000Z',
      },
    );
    assert(event?.kind === 'command');
    const serialized = JSON.stringify(event);
    assert.equal(serialized.includes('Bearer-secret'), false);
    assert.equal(serialized.includes('do-not-store'), false);
    assert.equal(serialized.includes('abc.xyz'), false);
  });
});
