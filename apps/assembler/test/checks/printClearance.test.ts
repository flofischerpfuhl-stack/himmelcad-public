/**
 * Clearance in the Print analysis and in Measure: overlap/clearance
 * findings from the kernel pass (budget, cancel), "Ignore here" (document)
 * and "Don't show this type" (preference) — both reversible, neither ever
 * removing a finding from the report itself — and Measure's two-body
 * clearance plus "Add as check".
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { setNoticeSink } from '../../renderer/src/foundation/commands/notices.js';
import { measure, type MeasureContext } from '../../renderer/src/modules/measure/measure.js';
import { checkForValue } from '../../renderer/src/modules/measure/addCheck.js';
import { runClearancePass } from '../../renderer/src/modules/print/clearance.js';
import { setPrintKernel } from '../../renderer/src/modules/print/exporting.js';
import { usePrintStore, visibleFindings } from '../../renderer/src/modules/print/printStore.js';
import { usePreferences, parsePreferences } from '../../renderer/src/platform/input/preferences.js';
import { activeFeaturesOf } from '../../renderer/src/modules/checks/index.js';
import { enclosureWithLid, kernel, liftLid, reset, store } from './fixtures.js';

const notices: string[] = [];
setNoticeSink((text) => notices.push(text));
setPrintKernel(kernel);

async function until(check: () => boolean, what: string, timeoutMs = 30000): Promise<void> {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > timeoutMs) throw new Error(`timed out: ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

void test('Print analysis: overlap finding from the kernel; ignore and hide are reversible and passive', async () => {
  await reset();
  const { base, lid } = await enclosureWithLid(19);
  await store.getState().whenSettled();
  notices.length = 0;
  const print = usePrintStore.getState();
  print.setEnabled(true);
  await until(
    () =>
      usePrintStore.getState().status === 'done' &&
      usePrintStore.getState().reportEvaluation === store.getState().evaluation,
    'analysis with the clearance pass',
  );
  const report = usePrintStore.getState().report!;
  const overlap = report.findings.find((f) => f.kind === 'overlap')!;
  assert.ok(overlap, 'bodies overlap');
  assert.equal(overlap.id, `overlap:${[base, lid].sort().join('|')}`);
  assert.equal(report.findings[0]!.severity, 'error', 'errors first');

  print.ignoreFinding(overlap.id);
  const state = usePrintStore.getState();
  assert.deepEqual(state.ignored, [overlap.id]);
  assert.equal(
    visibleFindings(state.report!.findings, state.ignored, []).some((f) => f.id === overlap.id),
    false,
  );
  assert.ok(
    state.report!.findings.some((f) => f.id === overlap.id),
    'the report keeps it',
  );
  print.restoreFinding(overlap.id);
  assert.deepEqual(usePrintStore.getState().ignored, []);

  print.hideFindingKind('overlap');
  assert.deepEqual(usePreferences.getState().hiddenPrintFindings, ['overlap']);
  assert.equal(
    visibleFindings(report.findings, [], usePreferences.getState().hiddenPrintFindings).some(
      (f) => f.kind === 'overlap',
    ),
    false,
  );
  // The preference survives a reload and resets with Settings › Reset.
  const stored = parsePreferences(JSON.stringify({ hiddenPrintFindings: ['overlap', 7] }));
  assert.deepEqual(stored.hiddenPrintFindings, ['overlap']);
  print.showFindingKind('overlap');
  assert.deepEqual(usePreferences.getState().hiddenPrintFindings, []);
  assert.deepEqual(notices, [], 'findings never notify');
  print.setEnabled(false);
});

void test('clearance pass: budget and cancel report the pairs left unmeasured', async () => {
  await reset();
  const { lid } = await enclosureWithLid(20);
  await liftLid(lid, 0.1);
  await store.getState().whenSettled();
  const state = store.getState();
  const bodies = state.evaluation.bodies.map((b) => ({
    id: b.id,
    name: b.name,
    min: b.min,
    max: b.max,
  }));
  const pass = await runClearancePass(kernel, activeFeaturesOf(state), bodies, {
    minClearanceMm: 0.3,
  });
  assert.equal(pass.candidates, 1);
  assert.equal(pass.findings[0]!.kind, 'clearance');
  assert.ok(Math.abs(pass.findings[0]!.value! - 0.1) < 1e-6);
  assert.ok(pass.findings[0]!.segment, 'closest points to draw');
  const cancelled = await runClearancePass(
    kernel,
    activeFeaturesOf(state),
    bodies,
    {
      minClearanceMm: 0.3,
    },
    { cancelled: () => true },
  );
  assert.equal(cancelled.findings[0]!.kind, 'clearanceSkipped');
  assert.match(cancelled.findings[0]!.message, /cancelled/);
  // Far apart bodies are never sent to the kernel.
  const none = await runClearancePass(kernel, activeFeaturesOf(state), bodies, {
    minClearanceMm: 0.05,
  });
  assert.equal(none.candidates, 0);
});

void test('Measure: two bodies show their clearance; values become checks', () => {
  const ctx: MeasureContext = {
    bodies: [
      {
        id: 'body:a',
        name: 'Base',
        min: [0, 0, 0],
        max: [10, 10, 10],
        faces: [],
        edges: [],
      },
      {
        id: 'body:b',
        name: 'Lid',
        min: [0, 0, 9],
        max: [10, 10, 12],
        faces: [],
        edges: [],
      },
    ] as never,
    distance: () => ({
      distance: 0,
      pointA: [1, 1, 10],
      pointB: [1, 1, 10],
      approx: false,
      relation: 'overlap',
      overlapVolume: 100,
      overlapCenter: [5, 5, 9.5],
    }),
  };
  const refs = [
    { kind: 'body' as const, bodyId: 'body:a' },
    { kind: 'body' as const, bodyId: 'body:b' },
  ];
  const m = measure(refs, ctx)!;
  assert.equal(m.title, 'Bodies overlap');
  const overlapValue = m.values.find((v) => v.label === 'Overlap volume')!;
  assert.equal(overlapValue.value, 100);
  assert.deepEqual(checkForValue(refs, overlapValue), {
    kind: 'clearance',
    params: { a: 'body:a', b: 'body:b', min: 0 },
  });
  const gap = checkForValue(refs, { label: 'Minimum distance', kind: 'length', value: 0.437 });
  assert.deepEqual(gap, { kind: 'clearance', params: { a: 'body:a', b: 'body:b', min: 0.43 } });
  const edge = [{ kind: 'edge' as const, bodyId: 'body:a', edgeKey: 'e1' }];
  assert.deepEqual(checkForValue(edge, { label: 'Diameter', kind: 'length', value: 3.4 }), {
    kind: 'length',
    params: {
      target: { kind: 'edge', edge: { bodyId: 'body:a', key: 'e1' } },
      quantity: 'diameter',
      min: 3.35,
      max: 3.45,
    },
  });
  assert.equal(
    checkForValue(refs, { label: 'ΔX', kind: 'length', value: 1, secondary: true }),
    null,
    'components are not requirements',
  );
});
