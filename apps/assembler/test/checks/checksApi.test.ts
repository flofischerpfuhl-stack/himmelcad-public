/**
 * The checks and clearance part of the agent contract on the real kernel:
 * `checks.kinds/list/add/update/remove/run` (one undo step each, refused in
 * transactions, staged runs), `measure.clearance`, the two-body clearance
 * in `measure.get`, and `print.analyze`'s clearance findings with the
 * findings the user ignored marked (agents always get every finding).
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { ApiError } from '../../renderer/src/foundation/commands/api/errors.js';
import { usePrintStore } from '../../renderer/src/modules/print/printStore.js';
import { call, enclosureWithLid, liftLid, reset, session, store, type Json } from './fixtures.js';

async function fails(promise: Promise<unknown>, code: string): Promise<ApiError> {
  try {
    await promise;
  } catch (error) {
    assert.ok(error instanceof ApiError, String(error));
    assert.equal(error.code, code, error.message);
    return error;
  }
  assert.fail(`expected ${code}`);
}

void test('checks.kinds lists every kind with its parameter schema', async () => {
  const kinds = await call<Json[]>('checks.kinds');
  const clearance = kinds.find((k) => k.kind === 'clearance')!;
  assert.equal(clearance.module, 'measure');
  assert.equal(clearance.cost, 'kernel');
  assert.deepEqual((clearance.params as { required: string[] }).required, ['min']);
});

void test('checks.add → run → fix → run: an agent closes the loop with structured results', async () => {
  await reset();
  const { base, lid } = await enclosureWithLid(20);
  const revision = session.documentRevision;
  const added = await call<{ check: Json; revision: number; result: Json }>('checks.add', {
    kind: 'clearance',
    params: { a: base, b: lid, min: 0.2 },
    name: 'Lid fit',
  });
  assert.equal(added.revision, revision + 1, 'a check edit is a document revision');
  assert.equal(added.check.name, 'Lid fit');
  assert.equal(added.result.status, 'fail');
  assert.equal(added.result.value, 0);
  assert.deepEqual(added.result.expected, { min: 0.2 });
  const location = (added.result.locations as Json[])[0]!;
  assert.deepEqual(location.bodyIds, [base, lid]);
  assert.ok(Array.isArray(location.segment));

  await call('checks.add', { kind: 'bodyCount', params: { min: 2, max: 2 } });
  const run = await call<{ passed: boolean; summary: Json; results: Json[] }>('checks.run');
  assert.equal(run.passed, false);
  assert.deepEqual(run.summary, { total: 2, passed: 1, failed: 1, errors: 0, disabled: 0 });

  await liftLid(lid, 0.4);
  const fixed = await call<{ passed: boolean; results: Json[] }>('checks.run');
  assert.equal(fixed.passed, true);
  assert.ok(Math.abs((fixed.results[0]!.value as number) - 0.4) < 1e-6);

  const listed = await call<{ checks: Json[] }>('checks.list');
  assert.deepEqual(
    listed.checks.map((c) => c.displayName),
    ['Lid fit', 'Body count 2'],
  );
});

void test('checks.update / checks.remove are one undo step each; bad params are refused', async () => {
  await reset();
  const { base, lid } = await enclosureWithLid(20.3);
  const { check } = await call<{ check: Json }>('checks.add', {
    kind: 'clearance',
    params: { a: base, b: lid, min: 0.2 },
  });
  const id = String(check.id);
  const updated = await call<{ result: Json }>('checks.update', {
    checkId: id,
    params: { a: base, b: lid, min: 0.5 },
  });
  assert.equal(updated.result.status, 'fail', '0.3 mm < 0.5 mm');
  await call('history.undo');
  assert.equal((store.getState().checks[0]!.params as Json).min, 0.2);
  await call('history.redo');
  assert.equal((store.getState().checks[0]!.params as Json).min, 0.5);
  await call('checks.update', { checkId: id, enabled: false, name: 'Off for now' });
  const off = await call<{ results: Json[] }>('checks.run');
  assert.equal(off.results[0]!.status, 'disabled');
  await call('checks.remove', { checkId: id });
  assert.deepEqual(store.getState().checks, []);
  await call('history.undo');
  assert.equal(store.getState().checks.length, 1);

  await fails(call('checks.add', { kind: 'clearance', params: {} }), 'invalidParams');
  await fails(call('checks.add', { kind: 'nope', params: {} }), 'invalidParams');
  await fails(call('checks.update', { checkId: 'nope', enabled: true }), 'notFound');
  await fails(
    call('checks.add', { kind: 'bodyCount', params: { min: 1 }, expectedRevision: 0 }),
    'conflict',
  );
});

void test('checks in transactions: edits refused, runs see the staged document', async () => {
  await reset();
  const { base, lid } = await enclosureWithLid(20);
  await call('checks.add', { kind: 'clearance', params: { a: base, b: lid, min: 0.2 } });
  await call('transaction.begin', { label: 'lift' });
  await fails(call('checks.add', { kind: 'bodyCount', params: { min: 1 } }), 'transactionState');
  await call('feature.create', { kind: 'move', params: { bodyId: lid, dx: 0, dy: 0, dz: 1 } });
  const staged = await call<{ scope: string; passed: boolean }>('checks.run', { scope: 'staged' });
  assert.equal(staged.scope, 'staged');
  assert.equal(staged.passed, true);
  const committed = await call<{ passed: boolean }>('checks.run', { scope: 'committed' });
  assert.equal(committed.passed, false);
  await call('transaction.cancel');
});

void test('measure.clearance and measure.get report gaps, contact and overlap volumes', async () => {
  await reset();
  const sunk = await enclosureWithLid(19);
  const pair = await call<{ pairs: Json[]; checkedPairs: number }>('measure.clearance', {
    a: sunk.base,
    b: sunk.lid,
  });
  assert.equal(pair.pairs[0]!.relation, 'overlap');
  assert.ok(Math.abs((pair.pairs[0]!.overlapVolume as number) - 264) < 1e-3);
  const panel = await call<{ title: string; values: Json[] }>('measure.get', {
    items: [
      { kind: 'body', bodyId: sunk.base },
      { kind: 'body', bodyId: sunk.lid },
    ],
  });
  assert.equal(panel.title, 'Bodies overlap');
  assert.ok(panel.values.some((v) => v.label === 'Overlap volume' && v.unit === 'mm³'));
  // Far apart pairs are skipped by their bounding boxes when `below` is given.
  const all = await call<{ pairs: Json[]; checkedPairs: number }>('measure.clearance', {
    below: 0.1,
  });
  assert.equal(all.checkedPairs, 1);
  await fails(call('measure.clearance', { a: sunk.base }), 'invalidParams');
});

void test('print.analyze: overlap and clearance findings, ignored ones marked but returned', async () => {
  await reset();
  const { lid } = await enclosureWithLid(19);
  const report = await call<{ findings: Json[] }>('print.analyze');
  const overlap = report.findings.find((f) => f.kind === 'overlap')!;
  assert.ok(overlap, 'overlap finding');
  assert.equal(overlap.severity, 'error');
  assert.ok(Array.isArray(overlap.point));
  usePrintStore.getState().ignoreFinding(String(overlap.id));
  const again = await call<{ findings: Json[] }>('print.analyze');
  assert.equal(again.findings.find((f) => f.id === overlap.id)?.ignored, true);
  usePrintStore.getState().restoreAllFindings();

  await liftLid(lid, 1.1);
  const gap = await call<{ findings: Json[] }>('print.analyze');
  const clearance = gap.findings.find((f) => f.kind === 'clearance')!;
  assert.ok(clearance, 'a 0.1 mm gap is below the 0.3 mm default');
  assert.ok(Math.abs((clearance.value as number) - 0.1) < 1e-3);
  const off = await call<{ findings: Json[] }>('print.analyze', {
    settings: { checkClearance: false },
  });
  assert.equal(
    off.findings.some((f) => f.kind === 'clearance' || f.kind === 'overlap'),
    false,
  );
});
