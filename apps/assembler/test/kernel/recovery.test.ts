/**
 * Kernel robustness at the adapter boundary: progress/activity reporting,
 * worker crash and out-of-memory recovery (restart, notice, one retry, a
 * give-up limit), memory recycling, meshes sent once per `meshId`, and the
 * in-process adapter reloading a kernel after a fatal error.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { InProcessKernelAdapter, type KernelActivity } from '../../renderer/src/kernel/adapter.js';
import type { KernelEvaluator } from '../../renderer/src/kernel/evaluator.js';
import { KernelFatalError } from '../../renderer/src/kernel/fatal.js';
import type { WorkerRequest, WorkerResponse } from '../../renderer/src/kernel/workerProtocol.js';
import {
  EMPTY_EVALUATION,
  type Body,
  type EvaluationResult,
  type KernelStatusInfo,
} from '../../renderer/src/kernel/types.js';
import { WorkerKernelAdapter } from '../../renderer/src/kernel/workerAdapter.js';

type Behaviour = (message: WorkerRequest, worker: FakeWorker) => void;

/** A stand-in for the kernel Web Worker, scripted per test. */
class FakeWorker {
  onmessage: ((event: MessageEvent<WorkerResponse>) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  terminated = false;
  received: WorkerRequest[] = [];

  constructor(private readonly behaviour: Behaviour) {
    setTimeout(() => this.send({ type: 'status', status: ready() }), 0);
  }

  send(message: WorkerResponse): void {
    if (this.terminated) return;
    this.onmessage?.({ data: message } as MessageEvent<WorkerResponse>);
  }

  crash(message: string): void {
    if (this.terminated) return;
    this.onerror?.({ message, preventDefault() {} } as unknown as ErrorEvent);
  }

  postMessage(message: WorkerRequest): void {
    this.received.push(message);
    setTimeout(() => this.behaviour(message, this), 0);
  }

  terminate(): void {
    this.terminated = true;
  }
}

function ready(): KernelStatusInfo {
  return { status: 'ready', message: 'CAD kernel ready', progress: 1, loadMs: 1 };
}

function body(id: string, meshId: string, triangles: number): Body {
  return {
    id,
    name: id,
    color: '#B8BCC2',
    createdBy: id,
    meshId,
    min: [0, 0, 0],
    max: [1, 1, 1],
    volume: 1,
    valid: true,
    mesh: {
      positions: new Float32Array(9 * triangles),
      normals: new Float32Array(9 * triangles),
      indices: new Uint32Array(3 * triangles).map((_, i) => i),
      triangleFaces: new Uint32Array(triangles),
    },
    faces: [],
    edges: [
      {
        key: 'a|b',
        faceIndices: [],
        curve: 'line',
        midpoint: [0, 0, 0],
        length: 1,
        direction: null,
        segments: new Float32Array([0, 0, 0, 1, 1, 1]),
      },
    ],
  };
}

function result(bodies: Body[] = [], heapBytes = 0): EvaluationResult {
  return { ...EMPTY_EVALUATION, bodies, stats: { ...EMPTY_EVALUATION.stats, heapBytes } };
}

const doc = (revision: number) => ({ channel: 'document' as const, revision, features: [] });

function harness(behaviour: Behaviour, options: { recycleHeapBytes?: number } = {}) {
  const workers: FakeWorker[] = [];
  const adapter = new WorkerKernelAdapter(() => {
    const worker = new FakeWorker(behaviour);
    workers.push(worker);
    return worker as unknown as Worker;
  }, options);
  const statuses: KernelStatusInfo[] = [];
  adapter.onStatus((s) => statuses.push(s));
  return { adapter, workers, statuses };
}

void test('activity: a running job reports its channel and progress, and ends with null', async () => {
  const { adapter } = harness((message, worker) => {
    if (message.type !== 'evaluate') return;
    worker.send({
      type: 'progress',
      jobId: message.jobId,
      progress: { phase: 'model', done: 1, total: 3, featureId: 'f2', featureName: 'Fillet 1' },
    });
    worker.send({ type: 'result', jobId: message.jobId, result: result() });
  });
  const seen: (KernelActivity | null)[] = [];
  adapter.onActivity((a) => seen.push(a));
  const job = adapter.evaluate(doc(1));
  assert.equal((await job.outcome).kind, 'done');
  const started = seen.find((a) => a !== null)!;
  assert.equal(started.channel, 'document');
  assert.equal(started.revision, 1);
  assert.ok(seen.some((a) => a?.progress?.featureName === 'Fillet 1'));
  assert.equal(seen.at(-1), null);
});

void test('a crashed worker is restarted with a notice and the running job is retried once', async () => {
  let crashes = 0;
  const { adapter, workers, statuses } = harness((message, worker) => {
    if (message.type !== 'evaluate') return;
    if (crashes === 0) {
      crashes += 1;
      worker.crash('RuntimeError: Aborted(OOM)');
      return;
    }
    worker.send({ type: 'result', jobId: message.jobId, result: result() });
  });
  const job = adapter.evaluate(doc(1));
  const outcome = await job.outcome;
  assert.equal(outcome.kind, 'done', 'the retry on the fresh worker succeeded');
  assert.equal(workers.length, 2);
  assert.equal(workers[0]!.terminated, true);
  const notice = statuses.find((s) => s.notice)?.notice ?? '';
  assert.match(notice, /stopped unexpectedly .*Aborted\(OOM\).*document is unchanged/);
  assert.equal(adapter.status.status, 'ready');
});

void test('a fatal kernel error reported by the worker also restarts it; a second crash fails the job', async () => {
  const { adapter, workers } = harness((message, worker) => {
    if (message.type !== 'evaluate') return;
    worker.send({ type: 'fatal', jobId: message.jobId, message: 'Aborted(Cannot enlarge memory)' });
  });
  const outcome = await adapter.evaluate(doc(1)).outcome;
  assert.equal(outcome.kind, 'failed');
  assert.match(
    outcome.kind === 'failed' ? outcome.message : '',
    /crashed while evaluating this document: Aborted\(Cannot enlarge memory\)/,
  );
  assert.equal(workers.length, 3, 'restarted after each crash');
  // The kernel is usable again for the next (different) document.
  assert.equal(adapter.status.status, 'loading');
});

void test('repeated crashes within a minute stop the retries with an error status', async () => {
  const { adapter } = harness((message, worker) => {
    if (message.type === 'evaluate') worker.crash('boom');
  });
  for (let i = 1; i <= 3; i += 1) {
    await adapter.evaluate(doc(i)).outcome;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  const last = await adapter.evaluate(doc(9)).outcome;
  assert.equal(last.kind, 'failed');
  assert.equal(adapter.status.status, 'error');
  assert.match(adapter.status.message, /keeps crashing/);
});

void test('meshes are sent once: a meshRef body reuses the arrays of the previous result', async () => {
  let call = 0;
  const { adapter } = harness((message, worker) => {
    if (message.type !== 'evaluate') return;
    call += 1;
    const b = body('body:a', 'm1', 2);
    const wire =
      call === 1
        ? b
        : {
            ...b,
            meshRef: true as const,
            mesh: { ...b.mesh, positions: new Float32Array(0), indices: new Uint32Array(0) },
            edges: b.edges.map((e) => ({ ...e, segments: new Float32Array(0) })),
          };
    worker.send({ type: 'result', jobId: message.jobId, result: { ...result(), bodies: [wire] } });
  });
  const first = await adapter.evaluate(doc(1)).outcome;
  const second = await adapter.evaluate(doc(2)).outcome;
  assert.ok(first.kind === 'done' && second.kind === 'done');
  const a = first.result.bodies[0]!;
  const b = second.result.bodies[0]!;
  assert.equal(b.mesh, a.mesh, 'same mesh object, not a copy');
  assert.equal(b.edges[0]!.segments, a.edges[0]!.segments);
  assert.equal(b.mesh.indices.length, 6);
  assert.equal('meshRef' in b, false);
});

void test('a worker past the heap threshold is recycled when idle and warmed up with the last document', async () => {
  const { adapter, workers, statuses } = harness(
    (message, worker) => {
      if (message.type !== 'evaluate') return;
      worker.send({ type: 'result', jobId: message.jobId, result: result([], 2048) });
    },
    { recycleHeapBytes: 1024 },
  );
  await adapter.evaluate(doc(1)).outcome;
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.ok(statuses.some((s) => /Refreshing CAD kernel memory/.test(s.message)));
  assert.ok(workers.length >= 2, 'a fresh worker was started');
  assert.ok(
    workers[1]!.received.some((m) => m.type === 'evaluate'),
    'the fresh worker re-evaluated the last document',
  );
});

void test('in-process adapter: a fatal error reloads the kernel and retries the job once', async () => {
  let loads = 0;
  let evaluations = 0;
  const evaluator = (): KernelEvaluator => ({
    evaluate: async () => {
      evaluations += 1;
      if (evaluations === 1) throw new KernelFatalError('Aborted(OOM)');
      return result();
    },
    exportStep: async () => new Uint8Array(),
    cacheInfo: () => ({
      entries: 0,
      shapes: 0,
      faces: 0,
      bytes: 0,
      budgetBytes: 0,
      evicted: 0,
      meshBytes: 0,
      meshes: 0,
      faceMeshes: 0,
      facesMeshed: 0,
      heapBytes: 0,
    }),
    clearCache: () => undefined,
  });
  const adapter = new InProcessKernelAdapter(async () => {
    loads += 1;
    return evaluator();
  });
  const notices: string[] = [];
  adapter.onStatus((s) => {
    if (s.notice) notices.push(s.notice);
  });
  const outcome = await adapter.evaluate(doc(1)).outcome;
  assert.equal(outcome.kind, 'done');
  assert.equal(loads, 2, 'the kernel was loaded again');
  assert.ok(notices.some((n) => /Aborted\(OOM\)/.test(n)));
});
