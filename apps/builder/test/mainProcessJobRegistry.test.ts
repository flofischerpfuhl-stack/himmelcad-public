import assert from 'node:assert/strict';
import test from 'node:test';

import { JobRegistry } from '../../../packages/@himmelcad/app/src/jobs.js';

test('G-UIP-JOBS Builder main registry owns lifecycle and cancellation callbacks', async () => {
  let now = 5_000;
  let cancelCalls = 0;
  const registry = new JobRegistry(() => now);
  registry.register(
    {
      id: 'registration-fixture',
      label: 'Import fixture.las',
      owner: 'builder.import',
      expectedDurationMs: 2_000,
      progressKey: 'registration-fixture',
      cancellable: true,
    },
    { cancel: () => void (cancelCalls += 1) },
  );
  registry.updateByProgressKey('registration-fixture', 0.42, 'Reading LAS points');
  assert.equal(registry.get('registration-fixture').fraction, 0.42);
  now += 400;
  assert.equal((await registry.cancel('registration-fixture')).state, 'cancelling');
  assert.equal(cancelCalls, 1);
  assert.equal(registry.cancelled('registration-fixture').state, 'cancelled');
});
