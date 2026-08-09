import assert from 'node:assert/strict';
import test from 'node:test';

import {
  KernelDecodeWorkerError,
  KernelDecodeWorkerPool,
  type KernelDecodeJob,
} from '../src/kernel/KernelDecodeWorkerPool.js';

void test('active abort terminates the non-cooperative worker and starts the next job immediately', async () => {
  const workers: FakeWorker[] = [];
  const pool = workerPool(1, workers);
  const controller = new AbortController();
  const promise = pool.decode(decodeJob(8), controller.signal);
  assert.equal(pool.diagnostics().activeDecodes, 1);

  controller.abort();
  await rejectsWithin(
    promise,
    (error) => error instanceof DOMException && error.name === 'AbortError',
  );
  assert.equal(pool.diagnostics().activeDecodes, 0);
  assert.equal(pool.diagnostics().canceledDecodes, 1);
  assert.equal(workers[0]!.terminated, true);
  assert.equal(workers.length, 2);

  const next = pool.decode(decodeJob(9), new AbortController().signal);
  assert.equal(pool.diagnostics().activeDecodes, 1);
  workers[1]!.respondDecoded();
  await next;
  assert.equal(pool.diagnostics().completedDecodes, 1);
  pool.dispose();
});

void test('downscale followed by upscale un-retires active workers', async () => {
  const workers: FakeWorker[] = [];
  const pool = workerPool(2, workers);
  const first = pool.decode(decodeJob(1), new AbortController().signal);
  const second = pool.decode(decodeJob(2), new AbortController().signal);

  pool.setWorkerCount(1);
  pool.setWorkerCount(2);
  assert.equal(pool.diagnostics().actualDecodeWorkers, 2);
  workers[0]!.respondDecoded();
  workers[1]!.respondDecoded();
  await Promise.all([first, second]);

  assert.equal(pool.diagnostics().actualDecodeWorkers, 2);
  assert.equal(workers.filter((worker) => worker.terminated).length, 0);
  pool.dispose();
});

void test('decode failure transfers input ownership back to the caller', async () => {
  const workers: FakeWorker[] = [];
  const pool = workerPool(1, workers);
  const job = decodeJob(7);
  const promise = pool.decode(job, new AbortController().signal);
  assert.equal(job.primary.byteLength, 0);

  workers[0]!.respondFailure('hostile payload');
  let failure: unknown;
  await assert.rejects(promise, (error: unknown) => {
    failure = error;
    return error instanceof KernelDecodeWorkerError && error.message === 'hostile payload';
  });
  assert.ok(failure instanceof KernelDecodeWorkerError);
  assert.deepEqual([...new Uint8Array(failure.primary)], [7, 7, 7, 7]);
  assert.equal(failure.bundle.byteLength, 2);
  assert.equal(failure.secondary.byteLength, 1);
  assert.equal(pool.diagnostics().failedDecodes, 1);
  pool.dispose();
});

void test('bad response id is a fatal protocol failure and replaces the worker', async () => {
  const workers: FakeWorker[] = [];
  const pool = workerPool(1, workers);
  const promise = pool.decode(decodeJob(3), new AbortController().signal);

  workers[0]!.respondDecoded(1_000);
  await assert.rejects(promise, /protocol response did not match/);
  assert.equal(workers[0]!.terminated, true);
  assert.equal(workers.length, 2);
  assert.equal(pool.diagnostics().actualDecodeWorkers, 1);
  assert.equal(pool.diagnostics().activeDecodes, 0);
  pool.dispose();
});

void test('worker crash and dispose settle every active and queued promise', async () => {
  const workers: FakeWorker[] = [];
  const pool = workerPool(1, workers);
  const crashed = pool.decode(decodeJob(4), new AbortController().signal);
  workers[0]!.crash('decoder trap');
  await assert.rejects(crashed, /decoder trap/);
  assert.equal(workers.length, 2);

  const active = pool.decode(decodeJob(5), new AbortController().signal);
  const queued = pool.decode(decodeJob(6), new AbortController().signal);
  pool.dispose();
  await Promise.all([
    assert.rejects(active, /pool disposed/),
    assert.rejects(queued, /pool disposed/),
  ]);
  assert.equal(workers[1]!.terminated, true);
});

function workerPool(count: number, workers: FakeWorker[]): KernelDecodeWorkerPool {
  return new KernelDecodeWorkerPool('/decode.js', count, () => {
    const worker = new FakeWorker();
    workers.push(worker);
    return worker as unknown as Worker;
  });
}

function decodeJob(value: number): KernelDecodeJob {
  return {
    kind: 'gaussianSplats',
    metadataJson: '{}',
    bundleManifestJson: '{}',
    decodeParametersJson: '',
    primary: Uint8Array.from([value, value, value, value]).buffer,
    bundle: Uint8Array.from([value, value]).buffer,
    secondary: Uint8Array.from([value]).buffer,
  };
}

async function rejectsWithin(
  promise: Promise<unknown>,
  predicate: (error: unknown) => boolean,
): Promise<void> {
  await Promise.race([
    assert.rejects(promise, predicate),
    new Promise<never>((_resolve, reject) => {
      setTimeout(() => reject(new Error('promise did not settle after abort')), 100);
    }),
  ]);
}

interface PostedDecode {
  readonly id: number;
  readonly job: {
    readonly primary: ArrayBuffer;
    readonly bundle: ArrayBuffer;
    readonly secondary: ArrayBuffer;
  };
}

class FakeWorker {
  onmessage: ((event: MessageEvent<unknown>) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  onmessageerror: ((event: MessageEvent<unknown>) => void) | null = null;
  terminated = false;
  private active: PostedDecode | null = null;

  postMessage(value: unknown, transfer: Transferable[]): void {
    if (this.terminated) throw new Error('postMessage after terminate');
    this.active = structuredClone(value, { transfer }) as PostedDecode;
  }

  terminate(): void {
    this.terminated = true;
  }

  respondDecoded(idOffset = 0): void {
    const request = this.takeActive();
    const artifact = Uint8Array.from([72, 67]).buffer;
    this.respond(
      {
        kind: 'decoded',
        id: request.id + idOffset,
        artifact,
        primary: request.job.primary,
        bundle: request.job.bundle,
        secondary: request.job.secondary,
        workerDurationMs: 2,
        workerContext: true,
        workerBaselineLinearMemoryBytes: 16 * 1024 * 1024,
        workerLinearMemoryBytes: 24 * 1024 * 1024,
      },
      [artifact, request.job.primary, request.job.bundle, request.job.secondary],
    );
  }

  respondFailure(message: string): void {
    const request = this.takeActive();
    this.respond(
      {
        kind: 'failed',
        id: request.id,
        message,
        primary: request.job.primary,
        bundle: request.job.bundle,
        secondary: request.job.secondary,
        workerDurationMs: 3,
        workerContext: true,
        workerBaselineLinearMemoryBytes: 16 * 1024 * 1024,
        workerLinearMemoryBytes: 32 * 1024 * 1024,
      },
      [request.job.primary, request.job.bundle, request.job.secondary],
    );
  }

  crash(message: string): void {
    this.takeActive();
    this.onerror?.({ message, preventDefault: () => {} } as ErrorEvent);
  }

  private respond(value: unknown, transfer: Transferable[]): void {
    const data = structuredClone(value, { transfer });
    this.onmessage?.({ data } as MessageEvent<unknown>);
  }

  private takeActive(): PostedDecode {
    assert.ok(this.active, 'fake worker has no active request');
    const request = this.active;
    this.active = null;
    return request;
  }
}
