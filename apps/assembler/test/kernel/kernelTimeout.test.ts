/**
 * Kernel time budget (assembler/ROBUSTNESS.md F13): an OCCT call that never
 * returns must not hang a headless/stdio agent caller. The worker adapter
 * stops a job that makes no progress within its budget (terminate +
 * restart), fails it with `kernelTimeout`, resends an evaluation that was
 * waiting, and the agent session answers `kernelTimeout` with nothing
 * committed. Scripted workers stand in for OCCT; the real thread kernel is
 * covered by the headless and fuzz tests.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { ThreadKernelAdapter } from '../../headless/threadKernel.js';
import { ApiError } from '../../renderer/src/foundation/commands/api/errors.js';
import { registeredFeatureKinds } from '../../renderer/src/foundation/document/featureKinds.js';
import { featureEvaluator } from '../../renderer/src/foundation/geometry-kernel/features/registry.js';
import { setSketchSolverFactory } from '../../renderer/src/foundation/sketch-solver/solverProvider.js';
import { loadNodeSolver } from '../sketch/nodeSolver.js';
import { createDemoDocument } from '../../renderer/src/foundation/commands/demoDocument.js';
import { useAssemblerStore } from '../../renderer/src/foundation/commands/store.js';
import {
  KernelTimeoutError,
  isKernelTimeout,
  kernelTimeoutFromEnv,
} from '../../renderer/src/foundation/geometry-kernel/timeout.js';
import {
  EMPTY_EVALUATION,
  type KernelStatusInfo,
} from '../../renderer/src/foundation/geometry-kernel/types.js';
import { WorkerKernelAdapter } from '../../renderer/src/foundation/geometry-kernel/workerAdapter.js';
import type {
  WorkerRequest,
  WorkerResponse,
} from '../../renderer/src/foundation/geometry-kernel/workerProtocol.js';
import {
  AgentSession,
  HEADLESS_CAPABILITIES,
} from '../../renderer/src/interface/agent-api/session.js';

type Behaviour = (message: WorkerRequest, worker: FakeWorker) => void;

/** A stand-in for the kernel worker; `hang` requests are never answered (OCCT stuck). */
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

const answer = (message: WorkerRequest, worker: FakeWorker) => {
  if (message.type === 'evaluate') {
    worker.send({ type: 'result', jobId: message.jobId, result: EMPTY_EVALUATION });
  } else if (message.type === 'exportStep') {
    worker.send({ type: 'exportResult', jobId: message.jobId, bytes: new ArrayBuffer(4) });
  }
};

function harness(behaviour: Behaviour, jobTimeoutMs: number | undefined) {
  const workers: FakeWorker[] = [];
  const adapter = new WorkerKernelAdapter(
    () => {
      const worker = new FakeWorker(behaviour);
      workers.push(worker);
      return worker as unknown as Worker;
    },
    jobTimeoutMs !== undefined ? { jobTimeoutMs } : {},
  );
  const statuses: KernelStatusInfo[] = [];
  adapter.onStatus((s) => statuses.push(s));
  return { adapter, workers, statuses };
}

const doc = (revision: number, features: unknown[] = []) => ({
  channel: 'document' as const,
  revision,
  features: features as never[],
});

void test('a stuck evaluation fails with kernelTimeout; the worker restarts and the next job runs', async () => {
  // The first evaluation never returns; every later request is answered.
  let first = true;
  const { adapter, workers, statuses } = harness((message, worker) => {
    if (message.type === 'evaluate' && first) {
      first = false;
      return;
    }
    answer(message, worker);
  }, 60);
  const started = Date.now();
  const outcome = await adapter.evaluate(doc(1)).outcome;
  assert.equal(outcome.kind, 'failed');
  assert.equal(outcome.kind === 'failed' && outcome.code, 'kernelTimeout');
  assert.match(outcome.kind === 'failed' ? outcome.message : '', /did not finish evaluating/);
  assert.ok(Date.now() - started < 2000, 'answered within the budget, not hung');
  assert.equal(workers[0]!.terminated, true, 'the stuck worker is terminated');
  assert.equal(workers.length, 2, 'and a fresh one started');
  assert.ok(statuses.some((s) => s.notice?.includes('ran longer than')));
  assert.equal((await adapter.evaluate(doc(2)).outcome).kind, 'done');
  adapter.dispose();
});

void test('progress keeps a long evaluation alive: the budget is per step', async () => {
  const { adapter, workers } = harness((message, worker) => {
    if (message.type !== 'evaluate') return;
    let step = 0;
    const tick = setInterval(() => {
      step += 1;
      if (step < 6) {
        worker.send({
          type: 'progress',
          jobId: message.jobId,
          progress: {
            phase: 'model',
            done: step,
            total: 6,
            featureId: `f${step}`,
            featureName: `Step ${step}`,
          },
        });
        return;
      }
      clearInterval(tick);
      worker.send({ type: 'result', jobId: message.jobId, result: EMPTY_EVALUATION });
    }, 40);
  }, 100);
  // 6 × 40 ms = 240 ms in total, more than the 100 ms budget, but never 100 ms without progress.
  assert.equal((await adapter.evaluate(doc(1)).outcome).kind, 'done');
  assert.equal(workers.length, 1, 'never restarted');
  adapter.dispose();
});

void test('a stuck export fails with KernelTimeoutError; an evaluation waiting behind it is resent', async () => {
  let stuck = true;
  const { adapter, workers } = harness((message, worker) => {
    if (message.type === 'exportStep' && stuck) {
      stuck = false;
      return; // OCCT never returns; the worker cannot answer anything else meanwhile
    }
    if (workers.indexOf(worker) === 0 && message.type === 'evaluate') return;
    answer(message, worker);
  }, 80);
  await new Promise((resolve) => setTimeout(resolve, 10));
  const exported = adapter.exportStep([]);
  const evaluation = adapter.evaluate(doc(1)).outcome;
  await assert.rejects(exported, (error: unknown) => {
    assert.ok(error instanceof KernelTimeoutError);
    assert.ok(isKernelTimeout(error));
    assert.equal(error.budgetMs, 80);
    return true;
  });
  const outcome = await evaluation;
  assert.equal(outcome.kind, 'done', 'the waiting evaluation ran on the fresh worker');
  assert.equal(workers.length, 2);
  adapter.dispose();
});

void test('without a budget (the app default) a slow job is simply waited for', async () => {
  const { adapter, workers } = harness((message, worker) => {
    setTimeout(() => answer(message, worker), 150);
  }, undefined);
  assert.equal((await adapter.evaluate(doc(1)).outcome).kind, 'done');
  assert.equal(workers.length, 1);
  adapter.dispose();
});

void test('agent API: a write whose evaluation times out answers kernelTimeout, nothing committed', async () => {
  // Documents with steps never evaluate (a stuck OCCT call); the empty document does.
  const { adapter } = harness((message, worker) => {
    if (message.type === 'evaluate' && message.features.length > 0) return;
    answer(message, worker);
  }, 60);
  const store = useAssemblerStore;
  store.getState().attachKernel(adapter);
  store.getState().loadDocument(createDemoDocument(), { projectName: 'Timeout' });
  await store.getState().whenSettled();
  const session = new AgentSession({
    store,
    kernel: adapter,
    host: { server: 'headless', capabilities: HEADLESS_CAPABILITIES },
  });
  const before = store.getState().features;
  const baseRevision = session.documentRevision;
  const started = Date.now();
  await assert.rejects(
    session.handle('feature.rename', { featureId: before[0]!.id, name: 'Renamed' }),
    (error: unknown) => {
      assert.ok(error instanceof ApiError);
      assert.equal(error.code, 'kernelTimeout');
      assert.equal(error.details?.committed, false);
      assert.match(error.hint ?? '', /document is unchanged/);
      return true;
    },
  );
  assert.ok(Date.now() - started < 5000, 'the caller got an answer, not a hang');
  assert.equal(store.getState().features, before, 'nothing committed');
  assert.equal(session.documentRevision, baseRevision);
  session.dispose();
  adapter.dispose();
});

void test('agent API: a module handler whose kernel query times out answers kernelTimeout too', async () => {
  // measure.distance is the measure module's handler; its kernel query never returns.
  const { adapter } = harness((message, worker) => {
    if (message.type === 'measureDistance') return;
    answer(message, worker);
  }, 60);
  const store = useAssemblerStore;
  store.getState().attachKernel(adapter);
  store.getState().loadDocument([], { projectName: 'Timeout' });
  await store.getState().whenSettled();
  const session = new AgentSession({
    store,
    kernel: adapter,
    host: { server: 'headless', capabilities: HEADLESS_CAPABILITIES },
  });
  await assert.rejects(
    session.handle('measure.distance', {
      a: { kind: 'point', point: [0, 0, 0] },
      b: { kind: 'point', point: [10, 0, 0] },
    }),
    (error: unknown) => {
      assert.ok(error instanceof ApiError);
      assert.equal(error.code, 'kernelTimeout');
      assert.equal(error.details?.committed, false);
      assert.equal(error.details?.budgetMs, 60);
      return true;
    },
  );
  session.dispose();
  adapter.dispose();
});

void test('HIMMELCAD_KERNEL_TIMEOUT_MS: default, explicit budget, 0 switches it off, junk fails', () => {
  assert.equal(kernelTimeoutFromEnv({}, 120_000), 120_000);
  assert.equal(kernelTimeoutFromEnv({ HIMMELCAD_KERNEL_TIMEOUT_MS: '5000' }, 120_000), 5000);
  assert.equal(kernelTimeoutFromEnv({ HIMMELCAD_KERNEL_TIMEOUT_MS: '0' }, 120_000), undefined);
  assert.throws(
    () => kernelTimeoutFromEnv({ HIMMELCAD_KERNEL_TIMEOUT_MS: 'soon' }, 1),
    /non-negative/,
  );
});

void test('F13 (real OCCT, kernel thread): the hanging loft fillet answers kernelTimeout; the kernel recovers', async () => {
  // `kernelTimeout-s1-q29`: the fillet never returns in OCCT. The thread kernel stops it.
  const kernel = new ThreadKernelAdapter({ quiet: true, jobTimeoutMs: 4000 });
  const store = useAssemblerStore;
  store.getState().attachKernel(kernel);
  setSketchSolverFactory(() => ({
    solve: async (request) => (await loadNodeSolver()).solve(request),
  }));
  const session = new AgentSession({
    store,
    kernel,
    host: { server: 'headless', capabilities: HEADLESS_CAPABILITIES },
  });
  try {
    await session.handle('project.new', { name: 'F13' });
    const sketch = async (plane: string, x: number, y: number, width: number, height: number) =>
      (
        (await session.handle('feature.create', {
          kind: 'sketch',
          params: {
            plane: { kind: 'plane', plane, offset: 0 },
            profiles: [{ kind: 'rectangle', x, y, width, height }],
          },
        })) as { featureId: string }
      ).featureId;
    const a = await sketch('YZ', -2.5, -9, 26, 12.5);
    const b = await sketch('XZ', 4.5, 7, 9, 29.5);
    const loft = (await session.handle('feature.create', {
      kind: 'loft',
      params: {
        profiles: [
          { kind: 'sketch', featureId: b },
          { kind: 'sketch', featureId: a },
        ],
        ruled: false,
        operation: 'new',
      },
    })) as { featureId: string };
    const before = store.getState().features;
    const started = Date.now();
    await assert.rejects(
      session.handle('feature.create', {
        kind: 'fillet',
        params: { edges: [{ bodyId: `body:${loft.featureId}`, select: '>Z' }], radius: 0.7 },
      }),
      (error: unknown) => {
        assert.ok(error instanceof ApiError);
        assert.equal(error.code, 'kernelTimeout');
        return true;
      },
    );
    assert.ok(Date.now() - started < 60_000, 'answered, not hung');
    assert.equal(store.getState().features, before, 'nothing committed');
    // The restarted kernel serves the next request.
    const bodies = (await session.handle('bodies.list', {})) as unknown[];
    assert.equal(bodies.length, 1);
  } finally {
    session.dispose();
    kernel.dispose();
  }
});

void test('kernel thread: the module kernel parts are registered as in the app (kinds + evaluators)', async () => {
  // The thread loads `app/kernelModules.ts` like the app's kernel Web Worker; the
  // main thread here has the whole composition (`test/setup.ts`).
  const kernel = new ThreadKernelAdapter({ quiet: true });
  try {
    const thread = await kernel.diagnostics();
    const kinds = registeredFeatureKinds();
    assert.deepEqual([...thread.featureKinds].sort(), [...kinds].sort());
    assert.deepEqual(
      [...thread.evaluatorKinds].sort(),
      kinds.filter((kind) => featureEvaluator(kind) !== undefined).sort(),
    );
    for (const kind of [
      'loft',
      'offsetFace',
      'deleteFace',
      'constructionPlane',
      // Block 8: modeling, direct-edit and canvas kinds.
      'primitive',
      'scale',
      'translate',
      'moveEdge',
      'moveFace',
      'referenceImage',
    ]) {
      assert.ok(thread.evaluatorKinds.includes(kind), `${kind} evaluates on the thread`);
    }
  } finally {
    kernel.dispose();
  }
});
