/**
 * Fuzzer regressions (`assembler/ROBUSTNESS.md`): every minimal reproducer
 * the model-based fuzzer found replays clean through the full invariant
 * harness (real store, agent session, OCCT kernel, planeGCS), the fixed
 * behaviours are asserted directly, and a short deterministic fuzz smoke
 * runs so `pnpm test` exercises the harness itself.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { ApiError } from '../../renderer/src/api/errors.js';
import { FuzzHarness } from './harness.js';
import { generateSequence, sequenceSeed } from './ops.js';
import { REPRODUCERS } from './reproducers.js';

type Json = Record<string, unknown>;

const harnessReady = FuzzHarness.create();

async function refusal(promise: Promise<unknown>): Promise<ApiError> {
  try {
    await promise;
  } catch (error) {
    assert.ok(error instanceof ApiError, String(error));
    return error;
  }
  assert.fail('expected a refusal');
}

for (const repro of REPRODUCERS) {
  void test(`fuzz regression ${repro.name} (${repro.finding}, was ${repro.invariant})`, async () => {
    const harness = await harnessReady;
    const result = await harness.run(repro.ops);
    assert.equal(
      result.failure,
      null,
      result.failure ? `${result.failure.invariant}: ${result.failure.message}` : '',
    );
  });
}

void test('F1: a chamfer larger than the faces next to the edge is refused (no invalid solid)', async () => {
  const harness = await harnessReady;
  await harness.reset();
  const sketch = await harness.call<Json>('feature.create', {
    kind: 'sketch',
    params: { plane: 'XY', profiles: [{ kind: 'circle', cx: 0, cy: 0, radius: 3 }] },
  });
  const extrude = await harness.call<Json>('feature.create', {
    kind: 'extrude',
    params: { profile: { kind: 'sketch', featureId: sketch.featureId }, distance: 16 },
  });
  const bodyId = `body:${String(extrude.featureId)}`;
  const before = harness.store.getState().features;
  const error = await refusal(
    harness.call('feature.create', {
      kind: 'chamfer',
      params: { edges: [{ bodyId, select: '%CIRCLE' }], distance: 4.8 },
    }),
  );
  assert.equal(error.code, 'featureFailed');
  assert.match(error.message, /does not fit the faces next to the edge/);
  assert.strictEqual(harness.store.getState().features, before, 'nothing committed');
  // A chamfer that fits is still fine and valid.
  await harness.call('feature.create', {
    kind: 'chamfer',
    params: { edges: [{ bodyId, select: '%CIRCLE' }], distance: 1 },
  });
  const [body] = await harness.call<{ valid: boolean }[]>('bodies.list');
  assert.equal(body?.valid, true);
});

void test('F2: a revolve whose axis passes over the profile (axis not in the sketch plane) is refused', async () => {
  const harness = await harnessReady;
  await harness.reset();
  const sketch = await harness.call<Json>('feature.create', {
    kind: 'sketch',
    params: {
      plane: { kind: 'plane', plane: 'YZ', offset: 9.5 },
      profiles: [{ kind: 'rectangle', x: -4.5, y: -7.5, width: 5.5, height: 14 }],
    },
  });
  const profile = { kind: 'sketch', featureId: sketch.featureId };
  const error = await refusal(
    harness.call('feature.create', {
      kind: 'revolve',
      params: { profile, axis: { kind: 'world', axis: 'Y', origin: [23, 0, 0] }, angle: 340 },
    }),
  );
  assert.equal(error.code, 'featureFailed');
  assert.match(error.message, /revolve through itself/);
  // A parallel axis beside the profile (z = 10, the profile spans z -7.5..6.5) is fine.
  await harness.call('feature.create', {
    kind: 'revolve',
    params: { profile, axis: { kind: 'world', axis: 'Y', origin: [23, 0, 10] }, angle: 340 },
  });
  const [body] = await harness.call<{ valid: boolean }[]>('bodies.list');
  assert.equal(body?.valid, true);
});

void test('fuzz smoke: seed 20260930, two short sequences keep every invariant', async () => {
  const harness = await harnessReady;
  for (let i = 0; i < 2; i += 1) {
    const result = await harness.run(generateSequence(sequenceSeed(20260930, i), 25));
    assert.equal(
      result.failure,
      null,
      result.failure ? `${result.failure.invariant}: ${result.failure.message}` : '',
    );
  }
});
