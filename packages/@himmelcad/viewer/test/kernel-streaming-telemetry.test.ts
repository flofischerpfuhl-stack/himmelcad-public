import test from 'node:test';

import {
  assertStreamingTelemetryFixture,
  runStreamingTelemetryFixture,
} from './scale/streaming-telemetry-fixture.js';

void test('mixed prepared hierarchies expose cold, resident and back-pan telemetry', async () => {
  assertStreamingTelemetryFixture(await runStreamingTelemetryFixture(4));
});
