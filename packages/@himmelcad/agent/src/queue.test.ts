import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { BoundedDiagnosticLog, BoundedQueue } from './queue.js';

describe('bounded harness queues', () => {
  it('bounds item count and bytes while reporting drops and rejects', () => {
    const queue = new BoundedQueue<string>({ maxItems: 3, maxBytes: 10, maxItemBytes: 6 });
    assert(queue.push('one', 3));
    assert(queue.push('two', 3));
    assert(queue.push('three', 5));
    assert(queue.push('four', 4));
    assert.equal(queue.push('oversized', 20), false);
    const snapshot = queue.snapshot();
    assert.deepEqual(snapshot.items, ['three', 'four']);
    assert.equal(snapshot.bytes, 9);
    assert.equal(snapshot.dropped, 2);
    assert.equal(snapshot.rejected, 1);
  });

  it('keeps raw diagnostics bounded independently of normalized events', () => {
    const log = new BoundedDiagnosticLog({ maxItems: 2, maxBytes: 1_000, maxItemBytes: 800 });
    log.push({ provider: 'codex', receivedAt: 'now', payload: 1 });
    log.push({ provider: 'codex', receivedAt: 'now', payload: 2 });
    log.push({ provider: 'codex', receivedAt: 'now', payload: 3 });
    assert.deepEqual(
      log.snapshot().items.map((item) => item.payload),
      [2, 3],
    );
  });

  it('deeply redacts credentials, bearer strings, cycles and Error messages', () => {
    const log = new BoundedDiagnosticLog();
    const cyclic: Record<string, unknown> = {
      authorization: 'Bearer top-secret',
      nested: { api_key: 'abc', text: 'password=hunter2 Bearer xyz.123' },
      error: new Error('token=never-store-this'),
    };
    cyclic.self = cyclic;
    assert(log.push({ provider: 'codex', receivedAt: 'now', payload: cyclic }));
    const serialized = JSON.stringify(log.snapshot());
    for (const secret of ['top-secret', 'abc', 'hunter2', 'xyz.123', 'never-store-this']) {
      assert.equal(serialized.includes(secret), false, `diagnostics leaked ${secret}`);
    }
    assert.match(serialized, /REDACTED/);
    assert.match(serialized, /Circular/);
  });
});
