/**
 * Stored checks (assembler/CHECKS.md): the kind registry, parameter
 * validation, undo/redo of the check list, evaluation on the real kernel
 * (clearance fail → fix → pass, ranges, locations), incremental reuse, the
 * background runner (passive: no notice, never while editing), and the
 * `.hcasm` fields `checks` / `printIgnored` (additive, forward-compatible).
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  checkKind,
  checkKinds,
  checkParamsProblems,
  newStoredCheck,
  runChecks,
  type CheckEnv,
  type CheckResult,
} from '../../renderer/src/foundation/commands/checks.js';
import { setNoticeSink } from '../../renderer/src/foundation/commands/notices.js';
import type { StoredCheck } from '../../renderer/src/foundation/document/checks.js';
import {
  loadProjectFile,
  ProjectFormatError,
  saveProjectFile,
} from '../../renderer/src/foundation/document/format.js';
import {
  collectProjectSections,
  loadProjectSections,
} from '../../renderer/src/foundation/document/projectSections.js';
import {
  activeFeaturesOf,
  bodyNamer,
  resultsStale,
  runChecksNow,
  setChecksKernel,
  startChecksRunner,
  useCheckResults,
} from '../../renderer/src/modules/checks/index.js';
import { usePrintStore } from '../../renderer/src/modules/print/printStore.js';
import { enclosureWithLid, kernel, liftLid, reset, store } from './fixtures.js';

const notices: string[] = [];
setNoticeSink((text) => notices.push(text));

function env(): CheckEnv {
  const state = store.getState();
  return {
    evaluation: state.evaluation,
    features: activeFeaturesOf(state),
    kernel,
    bodyName: bodyNamer(state.evaluation),
    cancelled: () => false,
    budgetMs: 5000,
  };
}

function check(kind: string, params: Record<string, unknown>, id = `c-${kind}`): StoredCheck {
  return { id, kind, params };
}

async function settle(): Promise<void> {
  await store.getState().whenSettled();
}

void test('every module registers its check kinds', () => {
  const kinds = checkKinds().map((k) => k.kind);
  for (const kind of [
    'distance',
    'angle',
    'length',
    'clearance',
    'volume',
    'mass',
    'bodyCount',
    'printable',
    'wallThickness',
    'buildVolume',
  ]) {
    assert.ok(kinds.includes(kind), `${kind} registered`);
  }
  assert.equal(checkKind('clearance')!.module, 'measure');
  assert.equal(checkKind('printable')!.module, 'print');
  assert.equal(checkKind('bodyCount')!.module, 'checks');
});

void test('opt-in: new documents and templates have no checks, so nothing runs', async () => {
  await reset();
  assert.deepEqual(store.getState().checks, []);
  await enclosureWithLid(19); // overlapping bodies: still no check, no warning
  await settle();
  assert.deepEqual(store.getState().checks, []);
  startChecksRunner(kernel);
  await runChecksNow();
  assert.deepEqual(useCheckResults.getState().results, {});
  assert.deepEqual(notices, []);
});

void test('parameters: strict for new checks, lenient (extra keys kept) for stored ones', () => {
  const clearance = checkKind('clearance')!;
  assert.deepEqual(checkParamsProblems(clearance, { min: 0.3 }), []);
  assert.match(checkParamsProblems(clearance, {})[0]!, /min/);
  assert.match(checkParamsProblems(clearance, { a: 'body:x', min: 1 })[0]!, /both a and b/);
  assert.match(checkParamsProblems(clearance, { min: 1, future: true })[0]!, /future/);
  assert.deepEqual(checkParamsProblems(clearance, { min: 1, future: true }, { lenient: true }), []);
  const volume = checkKind('volume')!;
  assert.match(checkParamsProblems(volume, {})[0]!, /min, max or both/);
  assert.match(checkParamsProblems(volume, { min: 5, max: 1 })[0]!, /greater than max/);
  assert.throws(() => newStoredCheck('nope', {}, []), /Unknown check kind "nope"/);
});

void test('the check list is one undo step per edit and never re-evaluates the model', async () => {
  await reset();
  await enclosureWithLid(20);
  await settle();
  const evaluation = store.getState().evaluation;
  const a = newStoredCheck('bodyCount', { min: 2, max: 2 }, []);
  assert.equal(store.getState().commitChecks([a]), true);
  assert.equal(store.getState().evaluation, evaluation, 'no re-evaluation');
  const b = newStoredCheck('volume', { min: 1 }, [a]);
  store.getState().commitChecks([a, b]);
  store.getState().undo();
  await settle();
  assert.deepEqual(store.getState().checks, [a]);
  store.getState().undo();
  await settle();
  assert.deepEqual(store.getState().checks, []);
  store.getState().redo();
  store.getState().redo();
  await settle();
  assert.deepEqual(store.getState().checks, [a, b]);
  // A feature edit after them keeps the checks; undoing it keeps them too.
  const features = store.getState().features;
  store.getState().commitDocumentChange(features.slice(0, -1));
  await settle();
  store.getState().undo();
  await settle();
  assert.deepEqual(store.getState().checks, [a, b]);
});

void test('a tool owning the history refuses check edits', async () => {
  await reset();
  store.setState({ activeTool: { kind: 'pick', phase: 'collectingReferences' } as never });
  try {
    assert.equal(store.getState().commitChecks([check('bodyCount', { min: 1 })]), false);
    assert.deepEqual(store.getState().checks, []);
  } finally {
    store.setState({ activeTool: null });
  }
});

void test('clearance: touching lid fails at 0.2 mm, an overlap fails, the fixed lid passes', async () => {
  await reset();
  const { base, lid } = await enclosureWithLid(20);
  await settle();
  const touching = await runChecks([check('clearance', { a: base, b: lid, min: 0.2 })], env());
  assert.equal(touching[0]!.state, 'fail');
  assert.equal(touching[0]!.outcome!.value, 0);
  assert.match(touching[0]!.outcome!.message, /needs ≥ 0.2 mm/);
  assert.deepEqual(touching[0]!.outcome!.locations![0]!.bodyIds, [base, lid]);
  // Touching passes a pure "no overlap" requirement.
  const contact = await runChecks([check('clearance', { a: base, b: lid, min: 0 })], env());
  assert.equal(contact[0]!.state, 'pass');

  await reset();
  const sunk = await enclosureWithLid(19);
  await settle();
  const overlap = await runChecks([check('clearance', { min: 0 })], env());
  assert.equal(overlap[0]!.state, 'fail');
  assert.match(overlap[0]!.outcome!.message, /overlap/);
  const pairs = overlap[0]!.outcome!.details!.pairs as {
    relation: string;
    overlapVolume: number;
  }[];
  // The lid's lowest millimetre inside the 2 mm rim: (40·30 − 36·26)·1 mm³.
  assert.ok(
    Math.abs(pairs[0]!.overlapVolume - (40 * 30 - 36 * 26)) < 1e-3,
    `${pairs[0]!.overlapVolume}`,
  );
  assert.ok(overlap[0]!.outcome!.locations![0]!.point, 'overlap centre to locate');

  await liftLid(sunk.lid, 1.5);
  await settle();
  const fixed = await runChecks(
    [check('clearance', { a: sunk.base, b: sunk.lid, min: 0.2 })],
    env(),
  );
  assert.equal(fixed[0]!.state, 'pass');
  assert.ok(Math.abs(fixed[0]!.outcome!.value! - 0.5) < 1e-9);
  assert.ok(fixed[0]!.outcome!.locations![0]!.segment, 'closest points');
});

void test('ranges, sizes, counts and print checks; unknown kinds and missing bodies are reported', async () => {
  await reset();
  const { base, lid } = await enclosureWithLid(20.5);
  await settle();
  const shellVolume = 40 * 30 * 20 - 36 * 26 * 18;
  const results = await runChecks(
    [
      check('bodyCount', { min: 2, max: 2 }),
      check('volume', { bodies: [base], min: shellVolume - 1, max: shellVolume + 1 }),
      check('mass', { bodies: [lid], max: 1 }),
      check('length', {
        target: { kind: 'body', bodyId: lid },
        quantity: 'height',
        min: 3,
        max: 3,
      }),
      check('distance', {
        a: { kind: 'face', face: { bodyId: base, select: '<Z' } },
        b: { kind: 'face', face: { bodyId: lid, select: '<Z' } },
        min: 20.4,
        max: 20.6,
      }),
      check('buildVolume', { printer: 'ender3' }),
      check('printable', {}),
      check('wallThickness', { bodies: [base], min: 2.5 }),
      check('fromTheFuture', { x: 1 }),
      check('volume', { bodies: ['body:gone'], min: 1 }, 'c-missing'),
    ],
    env(),
  );
  const byId = Object.fromEntries(results.map((r) => [r.id, r])) as Record<string, CheckResult>;
  assert.equal(byId['c-bodyCount']!.state, 'pass');
  assert.equal(byId['c-volume']!.state, 'pass');
  assert.equal(byId['c-mass']!.state, 'fail', 'a 40 × 30 × 3 PLA lid weighs ~4.5 g');
  assert.equal(byId['c-mass']!.outcome!.unit, 'g');
  assert.equal(byId['c-length']!.state, 'pass');
  assert.equal(byId['c-distance']!.state, 'pass', byId['c-distance']!.outcome?.message);
  assert.equal(byId['c-buildVolume']!.state, 'pass');
  assert.equal(byId['c-printable']!.state, 'pass', byId['c-printable']!.outcome?.message);
  assert.equal(byId['c-wallThickness']!.state, 'fail', '2 mm walls < 2.5 mm');
  assert.ok(byId['c-wallThickness']!.outcome!.locations![0]!.faces!.length > 0);
  assert.equal(byId['c-fromTheFuture']!.state, 'unsupported');
  assert.equal(byId['c-missing']!.state, 'error');
  assert.match(byId['c-missing']!.outcome!.message, /no longer exists/);
});

void test('incremental: unchanged bodies keep their results, a changed body is evaluated again', async () => {
  await reset();
  const { base, lid } = await enclosureWithLid(20.5);
  await settle();
  const checks = [
    check('clearance', { a: base, b: lid, min: 0.2 }),
    check('volume', { bodies: [base], min: 1 }),
  ];
  const first = await runChecks(checks, env());
  const previous = new Map(first.map((r) => [r.id, r]));
  const again = await runChecks(checks, env(), { previous });
  assert.ok(
    again.every((r) => r.reused),
    'nothing changed',
  );
  await liftLid(lid, 1);
  await settle();
  const after = await runChecks(checks, env(), { previous });
  const byId = Object.fromEntries(after.map((r) => [r.id, r]));
  assert.equal(byId['c-volume']!.reused, true, 'the base did not change');
  assert.equal(byId['c-clearance']!.reused, undefined, 'the lid moved');
  assert.ok(Math.abs(byId['c-clearance']!.outcome!.value! - 1.5) < 1e-9);
});

void test('background runner: results arrive after a rebuild, stay passive and wait while editing', async () => {
  await reset();
  setChecksKernel(kernel);
  startChecksRunner(kernel);
  const { base, lid } = await enclosureWithLid(20);
  await settle();
  notices.length = 0;
  const c = newStoredCheck('clearance', { a: base, b: lid, min: 0.2 }, []);
  store.getState().commitChecks([c]);
  await runChecksNow();
  const result = useCheckResults.getState().results[c.id];
  assert.equal(result?.state, 'fail');
  assert.equal(useCheckResults.getState().evaluatedFor, store.getState().evaluation);
  assert.deepEqual(notices, [], 'a failing check never notifies');
  assert.equal(store.getState().checksPanelOpen, false, 'nor opens its panel');
  // While a tool runs the runner does not evaluate (results would be for an older state).
  store.setState({ activeTool: { kind: 'pick', phase: 'collectingReferences' } as never });
  useCheckResults.setState({ results: {} });
  await runChecksNow();
  assert.deepEqual(useCheckResults.getState().results, {});
  store.setState({ activeTool: null });
  await runChecksNow();
  assert.equal(useCheckResults.getState().results[c.id]?.state, 'fail');
  assert.deepEqual(notices, []);
  // A parameter slider's live preview (an uncommitted state on screen): the results describe
  // the committed document, so they are out of date and nothing runs until it ends.
  assert.equal(resultsStale(), false);
  store.setState({ documentPreview: store.getState().evaluation });
  assert.equal(resultsStale(), true, 'stale while a preview is shown');
  useCheckResults.setState({ results: {} });
  await runChecksNow();
  assert.deepEqual(useCheckResults.getState().results, {}, 'no run during the preview');
  store.setState({ documentPreview: null });
  await runChecksNow();
  assert.equal(useCheckResults.getState().results[c.id]?.state, 'fail');
  assert.equal(resultsStale(), false);
});

void test('.hcasm: checks and ignored findings round-trip; unknown kinds are kept; malformed entries reject', async () => {
  await reset();
  const stored: StoredCheck[] = [
    { id: 'check-a', kind: 'clearance', name: 'Lid fit', params: { min: 0.3 } },
    { id: 'check-b', kind: 'fromTheFuture', params: { anything: [1, 2] }, enabled: false },
  ];
  store.setState({ checks: stored });
  usePrintStore.getState().setIgnored(['overlap:body:a|body:b']);
  const sections = await collectProjectSections();
  const text = saveProjectFile({
    ...sections.fields,
    projectName: 'Round trip',
    features: [],
    parameters: [],
    appVersion: 'test',
    createdAt: new Date(0).toISOString(),
  });
  const project = loadProjectFile(text);
  assert.deepEqual(project.checks, stored);
  assert.deepEqual(project.printIgnored, ['overlap:body:a|body:b']);
  store.setState({ checks: [] });
  usePrintStore.getState().setIgnored([]);
  loadProjectSections(project);
  assert.deepEqual(store.getState().checks, stored);
  assert.deepEqual(usePrintStore.getState().ignored, ['overlap:body:a|body:b']);
  // A document without checks writes no field (files stay as before).
  store.setState({ checks: [] });
  usePrintStore.getState().setIgnored([]);
  const plain = saveProjectFile({
    ...(await collectProjectSections()).fields,
    projectName: 'Plain',
    features: [],
    parameters: [],
    appVersion: 'test',
    createdAt: new Date(0).toISOString(),
  });
  assert.equal(/"checks"|"printIgnored"/.test(plain), false);
  const raw = JSON.parse(text) as Record<string, unknown>;
  for (const bad of [
    [{ id: 'x', kind: 'volume' }],
    [{ id: 'has space', kind: 'volume', params: {} }],
    [
      { id: 'x', kind: 'volume', params: {} },
      { id: 'x', kind: 'mass', params: {} },
    ],
    { not: 'a list' },
  ]) {
    assert.throws(
      () => loadProjectFile(JSON.stringify({ ...raw, checks: bad })),
      ProjectFormatError,
      JSON.stringify(bad),
    );
  }
  assert.throws(
    () => loadProjectFile(JSON.stringify({ ...raw, printIgnored: [3] })),
    ProjectFormatError,
  );
});
