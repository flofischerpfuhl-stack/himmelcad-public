import assert from 'node:assert/strict';
import test from 'node:test';

import {
  JOB_COMPLETED_RETENTION_MS,
  JobMirror,
  JobRegistry,
  jobVisibleInChip,
  type JobBridge,
  type JobEvent,
} from '../src/jobs.js';

const input = (id: string, extra = {}) => ({
  id,
  label: `Import ${id}.laz`,
  owner: 'builder.import',
  expectedDurationMs: 2_000,
  cancellable: true,
  ...extra,
});

test('G-UIP-JOBS register, progress, complete and clear retained history', () => {
  let now = 10_000;
  const registry = new JobRegistry(() => now);
  registry.register(input('one'));
  assert.equal(registry.update('one', { fraction: 0.42, phase: 'Reading points' }).fraction, 0.42);
  now += 1_100;
  assert.equal(registry.complete('one').state, 'completed');
  now += JOB_COMPLETED_RETENTION_MS;
  assert.equal(registry.list().length, 1);
  registry.clearFinished();
  assert.deepEqual(registry.list(), []);
});

test('G-UIP-JOBS maps sidecar progressKey lines', () => {
  const registry = new JobRegistry(() => 0);
  registry.register(input('one', { progressKey: 'registration-1' }));
  const job = registry.updateByProgressKey('registration-1', 0.5, 'Writing objects');
  assert.equal(job?.fraction, 0.5);
  assert.equal(job?.phase, 'Writing objects');
});

test('G-UIP-JOBS cancellation is declared and defers across atomic units', async () => {
  const registry = new JobRegistry(() => 0);
  assert.throws(() => registry.register(input('bad', { cancellable: false })));
  let cancelled = false;
  registry.register(
    input('one', {
      cancellable: false,
      cancellationReason: 'Publishing one atomic journal entry',
    }),
    { cancel: () => void (cancelled = true) },
  );
  registry.update('one', {
    cancellation: {
      cancellable: false,
      reason: 'Publishing one atomic journal entry',
      atNextSafeBoundary: true,
    },
  });
  assert.equal((await registry.cancel('one')).phase, 'Cancelling at next safe boundary');
  assert.equal(cancelled, true);
});

test('G-UIP-JOBS needs-input jobs respond through their owner', async () => {
  const registry = new JobRegistry(() => 0);
  let restored = false;
  registry.register(input('one', { needsInput: true }), {
    respond: () => void (restored = true),
  });
  assert.equal((await registry.respond('one')).state, 'running');
  assert.equal(restored, true);
});

test('G-UIP-JOBS threshold and debounce suppress short work and chip flicker', () => {
  let now = 0;
  const registry = new JobRegistry(() => now);
  registry.register(input('bounded', { expectedDurationMs: 500 }));
  assert.deepEqual(registry.list(), []);
  assert.equal(registry.complete('bounded').suppressChip, true);
  assert.throws(() => registry.get('bounded'));
  registry.register(input('long'));
  assert.equal(jobVisibleInChip(registry.get('long'), now), false);
  now = 300;
  assert.equal(jobVisibleInChip(registry.get('long'), now), true);
  now = 900;
  registry.complete('long');
  assert.equal(registry.get('long').suppressChip, true);
});

test('reload bridge rehydrates a running job and its working cancel', async () => {
  const registry = new JobRegistry(() => 1_000);
  let cancellationCount = 0;
  registry.register(input('running'), { cancel: () => void (cancellationCount += 1) });
  const listeners = new Set<(event: JobEvent) => void>();
  registry.subscribe((event) => listeners.forEach((listener) => listener(event)));
  const bridge: JobBridge = {
    list: async () => registry.list(),
    cancel: (id) => registry.cancel(id),
    respond: (id) => registry.respond(id),
    onEvent: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  const first = new JobMirror(bridge);
  const unmount = await first.mount();
  unmount();
  const reloaded = new JobMirror(bridge);
  await reloaded.mount();
  assert.equal(reloaded.snapshot()[0]?.label, 'Import running.laz');
  await reloaded.cancel('running');
  assert.equal(reloaded.snapshot()[0]?.state, 'cancelling');
  assert.equal(cancellationCount, 1);
});

test('three-import bridge gate keeps progress and cancellation across reload', async () => {
  const registry = new JobRegistry(() => 2_000);
  const cancelled: string[] = [];
  for (const fixture of ['scan_01.las', 'scan_02.laz', 'terrain.xyz']) {
    registry.register(input(fixture, { progressKey: `registration-${fixture}` }), {
      cancel: (job) => void cancelled.push(job.id),
    });
  }
  registry.updateByProgressKey('registration-scan_01.las', 0.25, 'Reading LAS points');
  registry.updateByProgressKey('registration-scan_02.laz', 0.5, 'Building hierarchy');
  registry.updateByProgressKey('registration-terrain.xyz', 0.75, 'Hashing objects');
  const bridge: JobBridge = {
    list: async () => registry.list(),
    cancel: (id) => registry.cancel(id),
    respond: (id) => registry.respond(id),
    onEvent: (listener) => registry.subscribe(listener),
  };
  const beforeReload = new JobMirror(bridge);
  const unmount = await beforeReload.mount();
  unmount();
  const afterReload = new JobMirror(bridge);
  await afterReload.mount();
  assert.deepEqual(afterReload.snapshot().map((job) => job.fraction), [0.25, 0.5, 0.75]);
  await afterReload.cancel('scan_02.laz');
  assert.deepEqual(cancelled, ['scan_02.laz']);
});
