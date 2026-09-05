import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { test } from 'node:test';

import {
  startDurabilityPolling,
  type BuilderDurabilityStatus,
} from '../renderer/src/durabilityPolling.js';

const status = (state: 'stored' | 'storing'): BuilderDurabilityStatus => ({
  state,
  visibleGeneration: 1,
  durableGeneration: state === 'stored' ? 1 : 0,
  acknowledgedAtMs: state === 'stored' ? Date.now() : 0,
  pendingCount: state === 'stored' ? 0 : 1,
  reason: null,
  recoveredTailCount: 0,
});

test('G-FP-P5 durability acknowledgement reaches the indicator callback under 50 ms p95', async () => {
  const latencies: number[] = [];
  for (let sample = 0; sample < 20; sample += 1) {
    let durable = false;
    let acknowledgement = 0;
    let resolveObserved: (() => void) | undefined;
    const observed = new Promise<void>((resolve) => {
      resolveObserved = resolve;
    });
    const stop = startDurabilityPolling(
      async () => status(durable ? 'stored' : 'storing'),
      (next) => {
        if (next.state !== 'stored' || acknowledgement === 0) return;
        latencies.push(performance.now() - acknowledgement);
        resolveObserved?.();
      },
      (error) => assert.fail(String(error)),
      25,
    );
    await new Promise((resolve) => setTimeout(resolve, 1));
    acknowledgement = performance.now();
    durable = true;
    await observed;
    stop();
  }
  latencies.sort((left, right) => left - right);
  const p95 = latencies[Math.ceil(latencies.length * 0.95) - 1]!;
  console.log(`G-FP-P5 ack->indicator callback p95=${p95.toFixed(3)}ms`);
  assert.ok(p95 <= 50, `indicator callback p95 ${p95.toFixed(3)} ms exceeds 50 ms`);
});
