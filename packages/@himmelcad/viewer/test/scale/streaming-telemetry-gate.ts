import {
  assertStreamingTelemetryFixture,
  runStreamingTelemetryFixture,
} from './streaming-telemetry-fixture.js';

const tilePairs = Number(process.env.HCAD_STREAMING_TELEMETRY_TILE_PAIRS ?? 64);
const result = await runStreamingTelemetryFixture(tilePairs);
assertStreamingTelemetryFixture(result);
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
