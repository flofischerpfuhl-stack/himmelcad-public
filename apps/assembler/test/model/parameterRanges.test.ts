/**
 * Block 9 parameters: ranges (min/max/step, numbers or formulas), the
 * slider's live preview and commit, and the parameter sweep ("Test range",
 * `parameters.sweep`) — with the real OCCT kernel and the planeGCS solver.
 * A value outside its range is refused with the reason, never clamped; a
 * sweep reports per sample whether the model rebuilds (the failing feature
 * and the kernel's reason) and the stored checks, and never changes the
 * document.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { ApiError } from '../../renderer/src/foundation/commands/api/errors.js';
import { newStoredCheck } from '../../renderer/src/foundation/commands/checks.js';
import {
  clearDocumentCheckRunner,
  registerDocumentCheckRunner,
} from '../../renderer/src/foundation/commands/documentChecks.js';
import type { Feature } from '../../renderer/src/foundation/document/document.js';
import {
  loadProjectFile,
  ProjectFormatError,
  saveProjectFile,
} from '../../renderer/src/foundation/document/format.js';
import type { Parameter } from '../../renderer/src/foundation/document/parameters.js';
import {
  describeParameterRange,
  parameterRangeViolation,
  resolveParameterRanges,
  resolveParameterValues,
} from '../../renderer/src/foundation/document/parameters.js';
import { makeEdgeRef, useAssemblerStore } from '../../renderer/src/foundation/commands/store.js';
import { addRectangle } from '../../renderer/src/foundation/sketch-solver/builders.js';
import { rememberRegions } from '../../renderer/src/foundation/sketch-solver/regionMemory.js';
import { setSketchSolverFactory } from '../../renderer/src/foundation/sketch-solver/solverProvider.js';
import type { SketchFeature } from '../../renderer/src/foundation/sketch-solver/sketchFeature.js';
import { EMPTY_SKETCH } from '../../renderer/src/foundation/sketch-solver/types.js';
import {
  AgentSession,
  HEADLESS_CAPABILITIES,
} from '../../renderer/src/interface/agent-api/session.js';
import { planParameterChange } from '../../renderer/src/modules/parameters/parameterEdits.js';
import { MAX_SWEEP_SAMPLES, planSweep } from '../../renderer/src/modules/parameters/sweep.js';
import { setSketchDimension } from '../../renderer/src/modules/sketching/featureOps.js';
import { CHECKS_DOCUMENT_RUNNER } from '../../renderer/src/modules/checks/documentRunner.js';
import { createNodeKernelAdapter } from '../kernel/nodeKernel.js';
import { loadNodeSolver } from '../sketch/nodeSolver.js';

type Json = Record<string, unknown>;

const store = useAssemblerStore;
const kernel = createNodeKernelAdapter();
store.getState().attachKernel(kernel);
setSketchSolverFactory(() => ({
  solve: async (request) => (await loadNodeSolver()).solve(request),
}));
const session = new AgentSession({
  store,
  kernel,
  host: { server: 'headless', capabilities: HEADLESS_CAPABILITIES },
});
const call = async <T = Json>(method: string, params: Json = {}): Promise<T> =>
  (await session.handle(method, params)) as T;

async function settled() {
  await store.getState().whenSettled();
  return store.getState();
}

const param = (name: string): Parameter =>
  store.getState().parameters.find((p) => p.name === name)!;
const body = () => store.getState().evaluation.bodies.find((b) => b.id === 'body:e1')!;

/**
 * A 40 × 30 plate, 10 tall: its width dimension reads `width` (range 10–60),
 * a top edge has a fillet of radius `r` (range 1–12; above 10 the plate is
 * too thin for it).
 */
async function plate(): Promise<void> {
  const sketch: SketchFeature = {
    id: 's1',
    name: 'Sketch 1',
    suppressed: false,
    kind: 'sketch',
    plane: { kind: 'plane', plane: 'XY', offset: 0 },
    ...rememberRegions(
      addRectangle(EMPTY_SKETCH, [0, 0], [40, 30], { position: true, size: true }).sketch,
    ),
  };
  const extrude: Feature = {
    id: 'e1',
    name: 'Extrude 1',
    suppressed: false,
    kind: 'extrude',
    profile: { kind: 'sketch', featureId: 's1' },
    distance: 10,
    symmetric: false,
    operation: 'new',
  };
  store.getState().loadDocument([sketch, extrude]);
  await settled();
  assert.ok(
    (
      await store
        .getState()
        .upsertParameter({ name: 'width', unit: 'mm', value: 40, min: 10, max: 60 })
    ).ok,
  );
  assert.ok(
    (
      await store
        .getState()
        .upsertParameter({ name: 'r', unit: 'mm', value: 3, min: 1, max: 12, step: 0.5 })
    ).ok,
  );
  const widthDim = store
    .getState()
    .features.find((f): f is SketchFeature => f.kind === 'sketch')!
    .dimensions.find((d) => Math.abs(d.value - 40) < 1e-9)!.id;
  assert.equal(await setSketchDimension('s1', widthDim, 'width'), null);
  await settled();
  const edge = body().edges.find(
    (e) => e.curve === 'line' && Math.abs(e.direction?.[0] ?? 0) > 0.99 && e.midpoint[2] > 9.99,
  )!;
  store.getState().addFeature({
    id: 'f1',
    name: 'Fillet 1',
    suppressed: false,
    kind: 'fillet',
    edges: [makeEdgeRef(store.getState().evaluation, 'body:e1', edge.key)!],
    radius: 3,
    radiusExpression: 'r',
  });
  await settled();
  assert.deepEqual(store.getState().evaluation.errors, {});
}

void test('range helpers: formula bounds, violations and labels', () => {
  const parameters: Parameter[] = [
    { id: 'a', name: 'wall', unit: 'mm', value: 2 },
    { id: 'b', name: 'gap', unit: 'mm', value: 5, min: 0, max: 4, maxExpression: 'wall * 2' },
  ];
  const values = resolveParameterValues(parameters);
  assert.ok(values.ok);
  const ranges = resolveParameterRanges(parameters, values.values);
  assert.ok(ranges.ok);
  assert.deepEqual(ranges.ranges.get('b'), { min: 0, max: 4 });
  assert.equal(
    parameterRangeViolation(parameters[1]!, 5, ranges.ranges.get('b')!),
    'gap = 5 mm is outside its range 0–4 mm',
  );
  assert.equal(parameterRangeViolation(parameters[1]!, 4, ranges.ranges.get('b')!), null);
  assert.equal(describeParameterRange({ min: 1 }, 'deg'), '≥ 1°');
  const swapped = resolveParameterRanges(
    [{ id: 'c', name: 'x', unit: '', value: 1, min: 3, max: 2 }],
    new Map([['x', 1]]),
  );
  assert.ok(!swapped.ok && /min 3 is greater than max 2/.test(swapped.message));
});

void test('the planner refuses a value outside the range (never clamps) and checks dependents', async () => {
  const doc = {
    features: [] as Feature[],
    parameters: [
      { id: 'w', name: 'wall', unit: 'mm', value: 2, min: 1, max: 4 },
      { id: 'd', name: 'double', unit: 'mm', value: 4, expression: 'wall * 2', max: 6 },
    ] as Parameter[],
  };
  const newId = () => 'n';
  const outside = await planParameterChange(doc, { id: 'w', value: 5 }, newId);
  assert.ok(!outside.ok);
  assert.equal(outside.message, 'wall = 5 mm is outside its range 1–4 mm. Nothing was changed.');
  assert.deepEqual(outside.outOfRange, {
    parameterId: 'w',
    name: 'wall',
    value: 5,
    min: 1,
    max: 4,
  });
  // 3.5 lies in wall's range, but double = 7 leaves double's.
  const dependent = await planParameterChange(doc, { id: 'w', value: 3.5 }, newId);
  assert.ok(!dependent.ok && dependent.outOfRange?.name === 'double');
  const inside = await planParameterChange(doc, { id: 'w', value: 3 }, newId);
  assert.ok(inside.ok);
  // A new range that excludes the current value is refused too.
  const narrowed = await planParameterChange(doc, { id: 'w', max: 1.5 }, newId);
  assert.ok(!narrowed.ok && /wall = 2 mm is outside its range 1–1.5 mm/.test(narrowed.message));
  assert.ok(
    !(await planParameterChange(doc, { id: 'w', step: 0 }, newId)).ok,
    'step must be positive',
  );
  assert.ok(!(await planParameterChange(doc, { id: 'w', min: 9, max: 3 }, newId)).ok, 'min > max');
  // Formula bounds and text with a unit; null/'' remove.
  const formula = await planParameterChange(doc, { id: 'd', min: 'wall', max: '10 mm' }, newId);
  assert.ok(formula.ok);
  const d = formula.parameters.find((p) => p.id === 'd')!;
  assert.equal(d.minExpression, 'wall');
  assert.equal(d.min, 2);
  assert.equal(d.max, 10);
  assert.equal(d.maxExpression, undefined);
  const removed = await planParameterChange(doc, { id: 'd', max: null }, newId);
  assert.ok(removed.ok && removed.parameters.find((p) => p.id === 'd')!.max === undefined);
  const negative = await planParameterChange(doc, { id: 'w', min: '-2' }, newId);
  assert.ok(
    negative.ok && negative.parameters[0]!.min === -2 && !negative.parameters[0]!.minExpression,
  );
  // A document that already holds an out-of-range value (an older file) is still editable elsewhere.
  const legacy = {
    features: [],
    parameters: [
      { id: 'x', name: 'x', unit: 'mm', value: 9, max: 4 },
      { id: 'y', name: 'y', unit: 'mm', value: 1 },
    ] as Parameter[],
  };
  assert.ok((await planParameterChange(legacy, { id: 'y', value: 2 }, newId)).ok);
});

void test('renaming rewrites range formulas; a parameter read by a range formula cannot be deleted', async () => {
  const doc = {
    features: [] as Feature[],
    parameters: [
      { id: 'w', name: 'wall', unit: 'mm', value: 2 },
      { id: 'g', name: 'gap', unit: 'mm', value: 1, min: 0, max: 4, maxExpression: 'wall * 2' },
    ] as Parameter[],
  };
  const renamed = await planParameterChange(doc, { id: 'w', name: 'thickness' }, () => 'n');
  assert.ok(renamed.ok);
  assert.equal(renamed.parameters.find((p) => p.id === 'g')!.maxExpression, 'thickness * 2');
  const deleted = await planParameterChange(doc, { delete: 'w' }, () => 'n');
  assert.ok(!deleted.ok && deleted.usages?.[0]?.field === 'maxExpression');
});

void test('sweep plans: modes, combinations, bounds and clear refusals', () => {
  const parameters: Parameter[] = [
    { id: 'a', name: 'a', unit: 'mm', value: 2, min: 1, max: 5 },
    { id: 'b', name: 'b', unit: 'mm', value: 10, min: 0, max: 20 },
    { id: 'c', name: 'c', unit: 'mm', value: 3 },
    { id: 'd', name: 'd', unit: 'mm', value: 6, expression: 'a * 3' },
  ];
  const one = planSweep(parameters, { parameters: [{ parameter: 'a' }] });
  assert.ok(one.ok);
  assert.deepEqual(one.samples, [{ a: 2 }, { a: 1 }, { a: 5 }], 'nominal first, then min and max');
  const each = planSweep(parameters, { parameters: [{ parameter: 'a' }, { parameter: 'b' }] });
  assert.ok(each.ok && each.samples.length === 5, 'one at a time: nominal + 2 + 2');
  const all = planSweep(parameters, {
    parameters: [{ parameter: 'a' }, { parameter: 'b' }],
    mode: 'samples',
    samples: 4,
    combine: 'all',
  });
  assert.ok(all.ok && all.samples.length === 16);
  assert.deepEqual(all.ok && all.axes[1]!.values, [0, 6.666666667, 13.333333333, 20]);
  const tooMany = planSweep(parameters, {
    parameters: [{ parameter: 'a' }, { parameter: 'b' }, { parameter: 'c', min: 0, max: 9 }],
    mode: 'samples',
    samples: 5,
    combine: 'all',
  });
  assert.ok(!tooMany.ok && tooMany.message.includes(`at most ${MAX_SWEEP_SAMPLES}`));
  const noRange = planSweep(parameters, { parameters: [{ parameter: 'c' }] });
  assert.ok(!noRange.ok && /c has no range/.test(noRange.message));
  assert.ok(planSweep(parameters, { parameters: [{ parameter: 'c', min: 1, max: 4 }] }).ok);
  const outside = planSweep(parameters, { parameters: [{ parameter: 'a', max: 9 }] });
  assert.ok(!outside.ok && /a = 9 lies outside its range 1–5 mm/.test(outside.message));
  const computed = planSweep(parameters, { parameters: [{ parameter: 'd' }] });
  assert.ok(!computed.ok && /computed from a formula/.test(computed.message));
  assert.ok(!planSweep(parameters, { parameters: [{ parameter: 'zz' }] }).ok);
});

void test('a typed value outside the range is refused in the store and the API; ranges are listed', async () => {
  await plate();
  const before = store.getState();
  const outcome = await store.getState().editParameter({ id: param('r').id, value: 20 });
  assert.ok(!outcome.ok && outcome.outOfRange?.name === 'r');
  assert.strictEqual(store.getState().parameters, before.parameters, 'nothing changed');
  try {
    await call('parameter.edit', { parameterId: 'r', value: 0.5 });
    assert.fail('expected invalidParams');
  } catch (error) {
    assert.ok(error instanceof ApiError && error.code === 'invalidParams', String(error));
    assert.deepEqual((error.details as Json).outOfRange, {
      parameterId: param('r').id,
      name: 'r',
      value: 0.5,
      min: 1,
      max: 12,
    });
  }
  const listed = (await call<Json[]>('parameters.list')).find((p) => p.name === 'r')!;
  assert.deepEqual([listed.min, listed.max, listed.step], [1, 12, 0.5]);
  // A formula bound through the API: width ≤ r · 20 (= 60).
  const edited = await call<Json>('parameter.edit', { parameterId: 'width', max: 'r * 20' });
  assert.equal((edited.parameter as Json).maxExpression, 'r * 20');
  assert.equal((edited.parameter as Json).max, 60);
  // r = 1.5 would move width's max to 30 < 40: refused, naming width.
  const dependent = await store.getState().editParameter({ id: param('r').id, value: 1.5 });
  assert.ok(
    !dependent.ok && dependent.outOfRange?.name === 'width',
    !dependent.ok ? dependent.message : '',
  );
  // null removes the bound.
  const cleared = await call<Json>('parameter.edit', { parameterId: 'width', max: null });
  assert.equal((cleared.parameter as Json).max, undefined);
  assert.equal((cleared.parameter as Json).maxExpression, undefined);
});

void test('slider: the drag previews live without touching the document; release commits one undo step', async () => {
  await plate();
  const before = store.getState();
  const steps = before.history.canUndo;
  store.getState().previewParameterValue(param('width').id, 50);
  store.getState().previewParameterValue(param('width').id, 55); // newest value wins
  for (let i = 0; i < 200 && (store.getState().parameterSlider?.pending ?? true); i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  const during = store.getState();
  assert.strictEqual(during.features, before.features, 'the document is untouched while dragging');
  assert.strictEqual(during.parameters, before.parameters);
  const preview = during.documentPreview;
  assert.ok(preview, 'a live preview is shown');
  const previewBody = preview.bodies.find((b) => b.id === 'body:e1')!;
  assert.ok(
    Math.abs(previewBody.max[0]! - previewBody.min[0]! - 55) < 1e-6,
    'the preview is 55 wide',
  );
  assert.equal(during.parameterSlider?.value, 55);

  const outcome = await store.getState().endParameterPreview(true);
  assert.ok(outcome?.ok, outcome && !outcome.ok ? outcome.message : 'committed');
  const after = await settled();
  assert.equal(after.documentPreview, null);
  assert.equal(after.parameterSlider, null);
  assert.equal(param('width').value, 55);
  assert.ok(Math.abs(body().max[0]! - body().min[0]! - 55) < 1e-6);
  store.getState().undo();
  const undone = await settled();
  assert.strictEqual(
    undone.features,
    before.features,
    'one undo step restores the state before the drag',
  );
  assert.equal(undone.history.canUndo, steps);

  // Esc during a drag drops the preview; nothing is committed.
  store.getState().previewParameterValue(param('width').id, 20);
  await store.getState().endParameterPreview(false);
  const dropped = await settled();
  assert.equal(dropped.documentPreview, null);
  assert.strictEqual(dropped.features, before.features);
});

void test('sweep: per-sample rebuild results with the failing feature, checks, cancel; the document is unchanged', async () => {
  await plate();
  const before = store.getState();
  const report = await store.getState().runParameterSweep({ parameters: [{ parameter: 'r' }] });
  assert.ok(report);
  assert.deepEqual(
    report.samples.map((s) => [s.values.r, s.ok]),
    [
      [3, true],
      [1, true],
      [12, false],
    ],
  );
  const failing = report.samples[2]!;
  assert.equal(failing.outcome, 'rebuilt');
  assert.equal(failing.errors[0]?.featureName, 'Fillet 1', 'the failing step is named');
  assert.ok(failing.errors[0]!.message.length > 0, 'with the kernel reason');
  // The checks module is installed (test setup) but the document has no stored checks.
  assert.equal(report.checksAvailable, true);
  assert.deepEqual(failing.checks, [], 'checks module, no stored checks: an empty list');
  assert.equal(store.getState().parameterSweep?.report, report);
  const after = await settled();
  assert.strictEqual(after.features, before.features, 'features untouched');
  assert.strictEqual(after.parameters, before.parameters, 'parameters untouched');
  assert.equal(after.history.canUndo, before.history.canUndo);

  // Without a checks module (runner removed): `null`, never an empty pass.
  clearDocumentCheckRunner();
  try {
    const bare = await store.getState().runParameterSweep({ parameters: [{ parameter: 'r' }] });
    assert.equal(bare?.checksAvailable, false);
    assert.equal(bare?.samples[0]?.checks, null);
  } finally {
    registerDocumentCheckRunner(CHECKS_DOCUMENT_RUNNER);
  }

  // Width 10..60 sampled with a stored check "width ≤ 50 mm": its result rides along per sample.
  store
    .getState()
    .commitChecks([
      newStoredCheck(
        'length',
        { target: { kind: 'body', bodyId: 'body:e1' }, quantity: 'width', max: 50 },
        [],
        { name: 'Width ≤ 50 mm' },
      ),
    ]);
  try {
    const sampled = await store.getState().runParameterSweep({
      parameters: [{ parameter: 'width' }],
      mode: 'samples',
      samples: 3,
    });
    assert.ok(sampled?.checksAvailable);
    assert.deepEqual(
      sampled.samples.map((s) => [s.values.width, s.ok, s.checks?.[0]?.status]),
      [
        [40, true, 'pass'],
        [10, true, 'pass'],
        [35, true, 'pass'],
        [60, false, 'fail'],
      ],
    );
    const wide = sampled.samples[3]!.checks![0]!;
    assert.equal(wide.name, 'Width ≤ 50 mm');
    assert.ok(Math.abs(wide.measured! - 60) < 1e-6 && wide.unit === 'mm', 'measured 60 mm');
    assert.match(wide.message ?? '', /needs ≤ 50 mm/);
  } finally {
    store.getState().commitChecks([]);
  }
  // Cancel (here: once two samples are done) stops at the running sample; what finished is kept.
  const unsubscribe = store.subscribe((state) => {
    if ((state.parameterSweep?.done ?? 0) >= 2 && state.parameterSweep?.running) {
      state.cancelParameterSweep();
    }
  });
  const cancelled = await store.getState().runParameterSweep({
    parameters: [{ parameter: 'width' }],
    mode: 'samples',
    samples: 8,
  });
  unsubscribe();
  assert.ok(cancelled?.cancelled);
  assert.equal(cancelled.samples.length, 2);
  assert.equal(cancelled.total, 9);
  assert.equal(store.getState().parameterSweep?.running, false);
  assert.strictEqual(store.getState().features, before.features);
});

void test('parameters.sweep over the API: refused samples, combinations, errors as contract errors', async () => {
  await plate();
  const before = store.getState();
  const report = await call<Json>('parameters.sweep', {
    parameters: [
      { parameterId: 'width', values: [10, 40] },
      { parameterId: 'r', values: [3, 12] },
    ],
    combine: 'all',
  });
  const samples = report.samples as Json[];
  assert.equal(samples.length, 4);
  assert.deepEqual(
    samples.map((s) => [(s.values as Json).width, (s.values as Json).r, s.ok]),
    [
      [10, 3, true],
      [10, 12, false],
      [40, 3, true],
      [40, 12, false],
    ],
  );
  assert.equal(report.passed, 2);
  assert.equal(report.failed, 2);
  assert.strictEqual(
    store.getState().features,
    before.features,
    'a sweep never changes the document',
  );
  // A sketch the values cannot satisfy (a zero-wide rectangle): refused, with the sketch named.
  await call('parameter.edit', { parameterId: 'width', min: 0 });
  const refused = await call<Json>('parameters.sweep', {
    parameters: [{ parameterId: 'width', values: [0] }],
  });
  const zero = (refused.samples as Json[]).find((s) => (s.values as Json).width === 0)!;
  assert.equal(zero.outcome, 'refused');
  assert.equal(zero.featureName, 'Sketch 1');
  assert.equal(zero.ok, false);
  const afterRange = store.getState();
  await assert.rejects(
    call('parameters.sweep', { parameters: [{ parameterId: 'width', max: 99 }] }),
    (error: unknown) => error instanceof ApiError && error.code === 'invalidParams',
  );
  await assert.rejects(
    call('parameters.sweep', { parameters: [{ parameterId: 'nope' }] }),
    (error: unknown) => error instanceof ApiError && error.code === 'notFound',
  );
  assert.strictEqual(store.getState().features, afterRange.features);
  assert.strictEqual(store.getState().parameters, afterRange.parameters);
});

void test('sweep with the checks module: a clearance check passes at min and fails at max (UI and API)', async () => {
  await plate();
  // A block 8 mm to the right of the plate's nominal 40 mm width (x 48..58): the plate's
  // width grows towards it, so the gap is 48 - width.
  const sketch: SketchFeature = {
    id: 's2',
    name: 'Sketch 2',
    suppressed: false,
    kind: 'sketch',
    plane: { kind: 'plane', plane: 'XY', offset: 0 },
    ...rememberRegions(addRectangle(EMPTY_SKETCH, [48, 0], [58, 30]).sketch),
  };
  store.getState().addFeature(sketch);
  store.getState().addFeature({
    id: 'e2',
    name: 'Extrude 2',
    suppressed: false,
    kind: 'extrude',
    profile: { kind: 'sketch', featureId: 's2' },
    distance: 10,
    symmetric: false,
    operation: 'new',
  } as Feature);
  await settled();
  assert.deepEqual(store.getState().evaluation.errors, {});
  assert.ok(store.getState().evaluation.bodies.some((b) => b.id === 'body:e2'));
  await call('checks.add', {
    kind: 'clearance',
    params: { a: 'body:e1', b: 'body:e2', min: 2 },
    name: 'Plate ↔ block ≥ 2 mm',
  });
  const before = store.getState();

  // Test range in the app (store action): min 10 → gap 38, nominal 40 → 8, max 60 → overlap.
  const report = await store.getState().runParameterSweep({ parameters: [{ parameter: 'width' }] });
  assert.ok(report?.checksAvailable);
  const rows = report.samples.map((s) => ({
    width: s.values.width,
    ok: s.ok,
    status: s.checks?.[0]?.status,
    measured: s.checks?.[0]?.measured,
  }));
  assert.deepEqual(
    rows.map((r) => [r.width, r.ok, r.status]),
    [
      [40, true, 'pass'],
      [10, true, 'pass'],
      [60, false, 'fail'],
    ],
  );
  assert.ok(Math.abs(rows[0]!.measured! - 8) < 1e-6, 'nominal gap 8 mm');
  assert.ok(Math.abs(rows[1]!.measured! - 38) < 1e-6, 'gap at min 38 mm');
  assert.equal(rows[2]!.measured, 0, 'overlap at max');
  assert.equal(report.passed, 2);

  // The same over the agent API (headless path, `parameters.sweep`).
  const api = await call<Json>('parameters.sweep', {
    parameters: [{ parameterId: 'width', values: [10, 47, 60] }],
  });
  assert.equal(api.checksAvailable, true);
  assert.deepEqual(
    (api.samples as Json[]).map((s) => [
      (s.values as Json).width,
      ((s.checks as Json[])[0] as Json).status,
    ]),
    [
      [40, 'pass'],
      [10, 'pass'],
      [47, 'fail'],
      [60, 'fail'],
    ],
  );

  // The document, its checks and the Checks panel's background results are untouched.
  const after = store.getState();
  assert.strictEqual(after.features, before.features);
  assert.strictEqual(after.parameters, before.parameters);
  assert.strictEqual(after.checks, before.checks);
  store.getState().commitChecks([]);
});

void test('.hcasm: parameter ranges round-trip; malformed ranges are refused', () => {
  const parameters: Parameter[] = [
    { id: 'p1', name: 'wall', unit: 'mm', value: 2, min: 1, max: 4, step: 0.2 },
    { id: 'p2', name: 'gap', unit: 'mm', value: 1, max: 4, maxExpression: 'wall * 2' },
  ];
  const text = saveProjectFile({
    projectName: 'Ranges',
    features: [],
    parameters,
    appVersion: 'test',
    createdAt: '2026-10-02T00:00:00.000Z',
    modifiedAt: '2026-10-02T00:00:00.000Z',
  });
  assert.deepEqual(loadProjectFile(text).parameters, parameters);
  const broken = (patch: Json) => {
    const raw = JSON.parse(text) as Json;
    (raw.parameters as Json[])[0] = { ...(raw.parameters as Json[])[0], ...patch };
    return JSON.stringify(raw);
  };
  assert.throws(() => loadProjectFile(broken({ step: 0 })), ProjectFormatError);
  assert.throws(() => loadProjectFile(broken({ min: 'x' })), ProjectFormatError);
  assert.throws(() => loadProjectFile(broken({ min: 9, max: 1 })), ProjectFormatError);
  assert.throws(
    () => loadProjectFile(broken({ minExpression: 'a', min: undefined })),
    ProjectFormatError,
  );
  // An out-of-range value is not a format error (an older build may have written it).
  assert.equal(loadProjectFile(broken({ value: 99 })).parameters[0]!.value, 99);
});
