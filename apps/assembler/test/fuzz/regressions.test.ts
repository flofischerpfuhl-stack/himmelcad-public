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
import { MARGINAL_REPRODUCERS, REPRODUCERS } from './reproducers.js';

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

for (const repro of MARGINAL_REPRODUCERS) {
  void test(`fuzz known-marginal ${repro.name} (${repro.finding}): every other invariant holds`, async () => {
    const harness = await harnessReady;
    const result = await harness.run(repro.ops);
    // A determinism difference the harness could not prove heap-layout dependent still fails.
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

void test('F6: an invalid boolean result is never committed (refused at commit, or valid)', async () => {
  const harness = await harnessReady;
  const repro = MARGINAL_REPRODUCERS.find((r) => r.finding === 'F6')!;
  const result = await harness.run(repro.ops);
  assert.equal(
    result.failure,
    null,
    result.failure ? `${result.failure.invariant}: ${result.failure.message}` : '',
  );
  // The cut through the ring used to commit an inside-out solid with a warning only. Depending
  // on OCCT's heap layout (F3 class) the cut now either gives a valid solid or is refused.
  for (const body of harness.store.getState().evaluation.bodies) {
    assert.equal(body.valid, true, `${body.name} is a valid solid`);
  }
  const last = result.log.at(-1)!;
  if (last.outcome === 'refused') {
    assert.match(last.detail ?? '', /^featureFailed: .*not a valid solid/);
  }
});

/** A 10 × 10 × 10 box on XY at (x, y) through the agent API (sketch + extrude). */
async function box(
  harness: FuzzHarness,
  x: number,
  y: number,
  extra: Json = {},
): Promise<{ featureId: string; sketchId: string }> {
  const sketch = await harness.call<Json>('feature.create', {
    kind: 'sketch',
    params: {
      plane: { kind: 'plane', plane: 'XY', offset: 0 },
      profiles: [{ kind: 'rectangle', x, y, width: 10, height: 10 }],
    },
  });
  const extrude = await harness.call<Json>('feature.create', {
    kind: 'extrude',
    params: { profile: { kind: 'sketch', featureId: sketch.featureId }, distance: 10, ...extra },
  });
  return { featureId: String(extrude.featureId), sketchId: String(sketch.featureId) };
}

const INVALID_RESULT = /not a valid solid \(self-intersecting, non-manifold, open or inside out\)/;

void test('commit check: a Join or Union whose result is not a valid solid is refused (hand case)', async () => {
  const harness = await harnessReady;
  await harness.reset();
  // Two cubes touching along one edge only: the fused result has an edge shared by four faces
  // (non-manifold). Before the commit check it was committed with a warning only.
  const a = await box(harness, 0, 0);
  const before = harness.store.getState().features;
  const join = await refusal(
    harness
      .call('feature.create', {
        kind: 'sketch',
        params: {
          plane: { kind: 'plane', plane: 'XY', offset: 0 },
          profiles: [{ kind: 'rectangle', x: 10, y: 10, width: 10, height: 10 }],
        },
      })
      .then((sketch) =>
        harness.call('feature.create', {
          kind: 'extrude',
          params: {
            profile: { kind: 'sketch', featureId: (sketch as Json).featureId },
            distance: 10,
            operation: 'join',
            targetBodyId: `body:${a.featureId}`,
          },
        }),
      ),
  );
  assert.equal(join.code, 'featureFailed');
  assert.match(join.message, /^The kernel rejected the feature: Extrude failed: /);
  assert.match(join.message, INVALID_RESULT);
  assert.equal((join.details as { committed?: boolean } | undefined)?.committed, false);
  // Only the helper sketch was added; the refused extrude left nothing.
  assert.equal(harness.store.getState().features.length, before.length + 1);
  assert.ok(
    harness.store.getState().features.every((f) => f.kind !== 'extrude' || f.id === a.featureId),
  );

  // The Boolean feature: same geometry as two bodies, Union refused, both bodies unchanged.
  await harness.reset();
  const b = await box(harness, 0, 0);
  const c = await box(harness, 10, 10);
  const features = harness.store.getState().features;
  const union = await refusal(
    harness.call('feature.create', {
      kind: 'boolean',
      params: {
        operation: 'union',
        targetBodyId: `body:${b.featureId}`,
        toolBodyIds: [`body:${c.featureId}`],
      },
    }),
  );
  assert.equal(union.code, 'featureFailed');
  assert.match(union.message, /Union failed: /);
  assert.match(union.message, INVALID_RESULT);
  assert.strictEqual(harness.store.getState().features, features, 'nothing committed');
  const bodies = await harness.call<{ valid: boolean; volume: number }[]>('bodies.list');
  assert.deepEqual(
    bodies.map((x) => [x.valid, Math.round(x.volume)]),
    [
      [true, 1000],
      [true, 1000],
    ],
  );
  // A union that is a valid solid (overlapping cubes) still commits.
  await harness.reset();
  const d = await box(harness, 0, 0);
  const e = await box(harness, 5, 5);
  await harness.call('feature.create', {
    kind: 'boolean',
    params: {
      operation: 'union',
      targetBodyId: `body:${d.featureId}`,
      toolBodyIds: [`body:${e.featureId}`],
    },
  });
  const [fused] = await harness.call<{ valid: boolean; volume: number }[]>('bodies.list');
  assert.equal(fused?.valid, true);
  assert.equal(Math.round(fused?.volume ?? 0), 1750);
});

void test('commit check: Done on a Boolean tool with an invalid result keeps the tool open, commits nothing', async () => {
  const harness = await harnessReady;
  await harness.reset();
  const b = await box(harness, 0, 0);
  const c = await box(harness, 10, 10);
  const store = harness.store;
  const features = store.getState().features;
  store.getState().select({ kind: 'body', bodyId: `body:${b.featureId}` });
  store.getState().select({ kind: 'body', bodyId: `body:${c.featureId}` }, { additive: true });
  store.getState().beginBoolean('union');
  await store.getState().whenSettled();
  // The preview keeps the cheap check: no error yet, Done is allowed.
  const tool = store.getState().activeTool;
  assert.equal(tool?.kind, 'boolean');
  store.getState().commit();
  await store.getState().whenSettled();
  const after = store.getState();
  assert.strictEqual(after.features, features, 'nothing committed');
  assert.equal(after.activeTool?.kind, 'boolean', 'the tool stays open');
  assert.match(
    (after.activeTool as { previewError?: string | null }).previewError ?? '',
    INVALID_RESULT,
  );
  store.getState().cancel();
  await store.getState().whenSettled();
});

void test('F7: exact export of a document with a failing step is a featureFailed refusal naming the step', async () => {
  const harness = await harnessReady;
  await harness.reset();
  const a = await box(harness, 0, 0);
  // Deleting the extrude's sketch leaves the extrude failing ("Missing reference").
  await harness.call('feature.delete', { featureId: a.sketchId });
  for (const method of ['export.step', 'export.stl']) {
    const params = method === 'export.stl' ? { resolution: 'fine' } : {};
    const error = await refusal(harness.call(method, params));
    // (No bodies remain here, so the STL refusal is "nothing to export"; STEP names the step.)
    if (method === 'export.step') {
      assert.equal(error.code, 'invalidParams', error.message);
    }
  }
  // With a body next to the failing step: STEP/IGES/fine STL need every step to evaluate.
  await box(harness, 20, 0);
  for (const method of ['export.step', 'export.stl']) {
    const params = method === 'export.stl' ? { resolution: 'fine' } : {};
    const error = await refusal(harness.call(method, params));
    assert.equal(error.code, 'featureFailed', `${method}: ${error.code} ${error.message}`);
    assert.match(
      error.message,
      /needs every step to evaluate: "Extrude \d+" fails: Missing reference: sketch of a deleted step/,
    );
  }
});

void test('F8: a cut that removes the whole body is refused (no empty "valid" body)', async () => {
  const harness = await harnessReady;
  await harness.reset();
  const a = await box(harness, 0, 0);
  const features = harness.store.getState().features;
  const error = await refusal(
    harness.call('feature.create', {
      kind: 'extrude',
      params: {
        profile: { kind: 'sketch', featureId: a.sketchId },
        distance: 17.5,
        operation: 'cut',
        targetBodyId: `body:${a.featureId}`,
      },
    }),
  );
  assert.equal(error.code, 'featureFailed');
  assert.match(error.message, /Cut: nothing of "Body 1" would remain/);
  assert.strictEqual(harness.store.getState().features, features, 'nothing committed');
  // A partial cut is still fine.
  const partial = await harness.call<Json>('feature.create', {
    kind: 'sketch',
    params: {
      plane: { kind: 'plane', plane: 'XY', offset: 0 },
      profiles: [{ kind: 'rectangle', x: 0, y: 0, width: 5, height: 10 }],
    },
  });
  await harness.call('feature.create', {
    kind: 'extrude',
    params: {
      profile: { kind: 'sketch', featureId: partial.featureId },
      distance: 20,
      operation: 'cut',
      targetBodyId: `body:${a.featureId}`,
    },
  });
  const [body] = await harness.call<{ valid: boolean; volume: number }[]>('bodies.list');
  assert.equal(Math.round(body?.volume ?? 0), 500);
});

void test('F9: an R12 DXF of sketch text stays small and imports as a light sketch', async () => {
  const harness = await harnessReady;
  await harness.reset();
  const sketch = await harness.call<Json>('feature.create', {
    kind: 'sketch',
    params: {
      plane: { kind: 'plane', plane: 'XZ', offset: 8.5 },
      profiles: [{ kind: 'rectangle', x: -18, y: 7, width: 26.5, height: 22.5 }],
    },
  });
  await harness.call('sketch.addText', {
    featureId: sketch.featureId,
    text: 'HC',
    position: [-1.5, -3],
    height: 6.5,
  });
  const dxf = await harness.call<{ data: string; byteLength: number }>('export.dxf', {
    sketchId: sketch.featureId,
    version: 'R12',
  });
  const vertices = Buffer.from(dxf.data, 'base64').toString('utf8').split('\nVERTEX').length - 1;
  // Was 7 810 vertices (64 pieces per knot span); the chord tolerance keeps it to a few hundred.
  assert.ok(vertices > 50 && vertices < 1000, `${vertices} vertices`);
  const imported = await harness.call<{ curves: number; regions: unknown[] }>('import.dxf', {
    data: dxf.data,
    fileName: 'text.dxf',
    plane: 'XZ',
    offset: 3,
  });
  assert.ok(imported.curves < 1000, `${imported.curves} curves`);
  const heap = harness.store.getState().evaluation.stats.heapBytes ?? 0;
  assert.ok(heap < 512 * 2 ** 20, `kernel heap ${Math.round(heap / 2 ** 20)} MB`);
});

void test('F10: an inside-out solid (negative volume) is not valid; the IGES import says why', async (t) => {
  const harness = await harnessReady;
  await harness.reset();
  const sketch = await harness.call<Json>('feature.create', {
    kind: 'sketch',
    params: {
      plane: { kind: 'plane', plane: 'XZ', offset: 0 },
      profiles: [{ kind: 'rectangle', x: 14.5, y: 0.5, width: 6.5, height: 14 }],
    },
  });
  const profile = { kind: 'sketch', featureId: sketch.featureId };
  const a = await harness.call<Json>('feature.create', {
    kind: 'extrude',
    params: { profile, distance: -14.5 },
  });
  const b = await harness.call<Json>('feature.create', {
    kind: 'extrude',
    params: { profile, distance: 17 },
  });
  await harness.call('feature.create', {
    kind: 'fillet',
    params: { edges: [{ bodyId: `body:${String(a.featureId)}`, select: '>Z' }], radius: 2.2 },
  });
  let exported: { data: string };
  try {
    exported = await harness.call('export.iges', {
      bodyIds: [`body:${String(a.featureId)}`, `body:${String(b.featureId)}`],
      mode: 'faces',
    });
  } catch (error) {
    assert.ok(error instanceof ApiError && error.code === 'unsupported', String(error));
    t.skip('IGES needs the HimmelCAD OCCT module');
    return;
  }
  const imported = await harness.call<{ createdBodyIds: string[]; warnings?: string[] }>(
    'import.iges',
    { data: exported.data, fileName: 'touching.igs' },
  );
  const bodies =
    await harness.call<{ id: string; valid: boolean; volume: number }[]>('bodies.list');
  const created = bodies.filter((x) => imported.createdBodyIds.includes(x.id));
  // The surfaces of the two touching bodies sew into one shell; if OCCT closes it inside out
  // (negative volume) the body is flagged, never shown as a valid solid.
  for (const body of created) {
    if (body.volume <= 0) assert.equal(body.valid, false, `${body.id}: ${body.volume} mm³`);
  }
  if (created.some((x) => x.volume <= 0)) {
    assert.match((imported.warnings ?? []).join(' '), /inside out/);
  }
});

void test('F12: while the History is rolled back, STEP export holds what the viewport shows', async () => {
  const harness = await harnessReady;
  await harness.reset();
  const a = await box(harness, 0, 0);
  // A cut after the box, then the History rolled back before the cut.
  const cutSketch = await harness.call<Json>('feature.create', {
    kind: 'sketch',
    params: {
      plane: { kind: 'plane', plane: 'XY', offset: 0 },
      profiles: [{ kind: 'rectangle', x: 0, y: 0, width: 5, height: 10 }],
    },
  });
  const cut = await harness.call<Json>('feature.create', {
    kind: 'extrude',
    params: {
      profile: { kind: 'sketch', featureId: cutSketch.featureId },
      distance: 20,
      operation: 'cut',
      targetBodyId: `body:${a.featureId}`,
    },
  });
  harness.store.getState().setRollback(String(cut.featureId));
  await harness.store.getState().whenSettled();
  const [shown] = await harness.call<{ id: string; volume: number }[]>('bodies.list');
  assert.equal(Math.round(shown?.volume ?? 0), 1000, 'the viewport shows the box before the cut');
  const exported = await harness.call<{ data: string }>('export.step', { bodyIds: [shown!.id] });
  harness.store.getState().setRollback(null);
  await harness.store.getState().whenSettled();
  const imported = await harness.call<{ createdBodyIds: string[] }>('import.step', {
    data: exported.data,
    fileName: 'rolled-back.step',
  });
  const back = (await harness.call<{ id: string; volume: number }[]>('bodies.list')).filter((x) =>
    imported.createdBodyIds.includes(x.id),
  );
  assert.equal(Math.round(back.reduce((s, x) => s + x.volume, 0)), 1000);
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
