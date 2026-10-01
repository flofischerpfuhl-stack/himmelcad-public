import assert from 'node:assert/strict';
import test from 'node:test';

import { QueuedKernelAdapter } from '../../renderer/src/foundation/geometry-kernel/adapter.js';
import {
  EMPTY_EVALUATION,
  type EvaluationRequest,
  type EvaluationResult,
} from '../../renderer/src/foundation/geometry-kernel/types.js';

/** Adapter whose runs complete only when the test says so. */
class ManualAdapter extends QueuedKernelAdapter {
  runs: { request: EvaluationRequest; finish: () => void }[] = [];
  aborts = 0;

  ready(): void {
    this.setStatus({ status: 'ready', message: 'ready', progress: null, loadMs: 1 });
  }

  protected run(request: EvaluationRequest): Promise<EvaluationResult> {
    return new Promise((resolve) => {
      this.runs.push({ request, finish: () => resolve(EMPTY_EVALUATION) });
    });
  }

  protected override abortRunning(): void {
    this.aborts += 1;
  }
}

const request = (channel: 'document' | 'preview', revision: number): EvaluationRequest => ({
  channel,
  revision,
  features: [],
});

void test('requests wait for the kernel; a newer request supersedes the waiting one per channel', async () => {
  const adapter = new ManualAdapter();
  const a = adapter.evaluate(request('document', 1));
  const b = adapter.evaluate(request('document', 2));
  const p = adapter.evaluate(request('preview', 7));
  assert.deepEqual(await a.outcome, { kind: 'superseded', revision: 1 });
  assert.equal(adapter.runs.length, 0, 'nothing runs before ready');
  adapter.ready();
  // Document channel first, then preview.
  assert.equal(adapter.runs.length, 1);
  assert.equal(adapter.runs[0]!.request.revision, 2);
  adapter.runs[0]!.finish();
  const outcomeB = await b.outcome;
  assert.equal(outcomeB.kind, 'done');
  assert.equal(outcomeB.revision, 2);
  await Promise.resolve();
  assert.equal(adapter.runs.length, 2);
  assert.equal(adapter.runs[1]!.request.channel, 'preview');
  adapter.runs[1]!.finish();
  assert.equal((await p.outcome).kind, 'done');
});

void test('a running request is not interrupted by newer ones; the newest waiting one runs next', async () => {
  const adapter = new ManualAdapter();
  adapter.ready();
  const first = adapter.evaluate(request('document', 1));
  const second = adapter.evaluate(request('document', 2));
  const third = adapter.evaluate(request('document', 3));
  assert.equal((await second.outcome).kind, 'superseded');
  adapter.runs[0]!.finish();
  assert.equal((await first.outcome).revision, 1, 'caller compares revisions to drop it');
  await Promise.resolve();
  assert.equal(adapter.runs[1]!.request.revision, 3);
  adapter.runs[1]!.finish();
  assert.equal((await third.outcome).kind, 'done');
});

void test('cancel: waiting jobs resolve cancelled; a hard cancel aborts the running computation', async () => {
  const adapter = new ManualAdapter();
  adapter.ready();
  const running = adapter.evaluate(request('document', 1));
  const waiting = adapter.evaluate(request('preview', 2));
  adapter.cancel(waiting.id);
  assert.deepEqual(await waiting.outcome, { kind: 'cancelled', revision: 2 });

  adapter.cancel(running.id);
  assert.deepEqual(await running.outcome, { kind: 'cancelled', revision: 1 });
  assert.equal(adapter.aborts, 0, 'soft cancel lets the computation finish in the background');

  adapter.runs[0]!.finish();
  const hard = adapter.evaluate(request('document', 3));
  await Promise.resolve();
  await Promise.resolve();
  adapter.cancel(hard.id, { hard: true });
  assert.deepEqual(await hard.outcome, { kind: 'cancelled', revision: 3 });
  assert.equal(adapter.aborts, 1);
});

void test('a kernel load error fails waiting and later requests with the error message', async () => {
  const adapter = new ManualAdapter();
  const waiting = adapter.evaluate(request('document', 1));
  (adapter as unknown as { setStatus: (s: unknown) => void }).setStatus({
    status: 'error',
    message: 'CAD kernel failed to load: boom',
    progress: null,
    loadMs: null,
  });
  assert.deepEqual(await waiting.outcome, {
    kind: 'failed',
    revision: 1,
    message: 'CAD kernel failed to load: boom',
  });
  const later = adapter.evaluate(request('document', 2));
  assert.equal((await later.outcome).kind, 'failed');
});
