/**
 * Browser/Electron kernel adapter: OCCT runs in a dedicated Web Worker so
 * loading (~23 MB WebAssembly) and modelling never block the UI thread.
 *
 * - Cancelling a running evaluation hard terminates and restarts the worker.
 * - A crashed worker (uncaught error, wasm abort, out of memory) is
 *   restarted automatically: the status carries a notice for the user, the
 *   job that was running is sent again once to the fresh worker (a second
 *   crash fails it with a readable message) and the store re-evaluates the
 *   current document — the document itself lives in the store and is never
 *   lost. More than {@link MAX_KERNEL_RESTARTS} crashes a minute stop the
 *   retries with an error status.
 * - Meshes are received once per `meshId` (see `kernel.worker.ts`).
 * - Memory: once the worker's wasm heap passes `RECYCLE_HEAP_BYTES` the
 *   worker is restarted the next time the queue is idle, then warmed up with
 *   the last document (OCCT leaks a little per operation; see `adapter.ts`).
 * - Time budget (`jobTimeoutMs`, off by default; the headless CLI sets it):
 *   an evaluation that reports no progress for the budget, or an export,
 *   distance or query job that does not answer within it, fails with
 *   `KernelTimeoutError` (`timeout.ts`, agent API `kernelTimeout`); the
 *   worker is terminated and restarted and an evaluation that was waiting is
 *   sent again. OCCT calls that never return cannot hang the caller.
 */
import type { Feature } from '../document/document.js';
import {
  CRASH_WINDOW_MS,
  MAX_KERNEL_RESTARTS,
  QueuedKernelAdapter,
  RECYCLE_HEAP_BYTES,
  crashNotice,
  type RunContext,
} from './adapter.js';
import type { WireBody, WorkerRequest, WorkerResponse } from './workerProtocol.js';
import type {
  Body,
  BodyMesh,
  ClearanceRequest,
  ClearanceResult,
  DistanceMeasurement,
  DistanceTarget,
  EvaluationRequest,
  EvaluationResult,
} from './types.js';
import type { ExportMeshBody, MeshExportOptions } from './meshExport.js';
import type { IgesExportOptions } from './igesExchange.js';
import type { StepExportOptions } from './stepExport.js';
import { KernelTimeoutError } from './timeout.js';

interface Pending {
  jobId: number;
  request: EvaluationRequest;
  context: RunContext;
  attempts: number;
  resolve: (result: EvaluationResult) => void;
  reject: (error: Error) => void;
}

interface PendingExport {
  resolve: (bytes: Uint8Array) => void;
  reject: (error: Error) => void;
}

interface MeshRecord {
  mesh: BodyMesh;
  segments: Float32Array[];
}

export class WorkerKernelAdapter extends QueuedKernelAdapter {
  private worker: Worker | null = null;
  private pending: Pending | null = null;
  private nextJobId = 1;
  private readonly exportPending = new Map<number, PendingExport>();
  private readonly meshPending = new Map<
    number,
    { resolve: (bodies: ExportMeshBody[]) => void; reject: (error: Error) => void }
  >();
  private nextExportJobId = 1;
  private readonly measurePending = new Map<
    number,
    { resolve: (result: DistanceMeasurement) => void; reject: (error: Error) => void }
  >();
  private readonly clearancePending = new Map<
    number,
    { resolve: (result: ClearanceResult) => void; reject: (error: Error) => void }
  >();
  /** Meshes of the last result the worker posted, by `meshId`. */
  private meshes = new Map<string, MeshRecord>();
  private crashes: number[] = [];
  /** Set while a crashed worker restarts: the notice for the next `ready` status. */
  private restartNotice: string | null = null;
  /** The last document evaluated (warms the caches of a recycled worker). */
  private lastDocument: EvaluationRequest | null = null;
  private recycleRequested = false;
  private warmUpAfterReady = false;
  /** Heap right after a recycle's warm-up: what the document itself needs. */
  private baselineHeap = 0;
  private readonly recycleHeapBytes: number;
  /** Budget of one job, ms (`undefined`: none). */
  private readonly jobTimeoutMs: number | undefined;
  private readonly budgets = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly queryPending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (error: Error) => void }
  >();

  constructor(
    private readonly createWorker: () => Worker,
    options: { recycleHeapBytes?: number; jobTimeoutMs?: number } = {},
  ) {
    super();
    this.recycleHeapBytes = options.recycleHeapBytes ?? RECYCLE_HEAP_BYTES;
    this.jobTimeoutMs = options.jobTimeoutMs;
    this.start();
  }

  // ---- time budget ----------------------------------------------------------------

  /** Starts (or restarts) the budget of job `key`; `what` names it in the timeout message. */
  private arm(key: string, what: string): void {
    const budget = this.jobTimeoutMs;
    if (budget === undefined) return;
    this.disarm(key);
    this.budgets.set(
      key,
      setTimeout(() => {
        this.budgets.delete(key);
        this.timeOut(key, new KernelTimeoutError(what, budget));
      }, budget),
    );
  }

  private disarm(key: string): void {
    const timer = this.budgets.get(key);
    if (timer === undefined) return;
    clearTimeout(timer);
    this.budgets.delete(key);
  }

  private disarmAll(): void {
    for (const timer of this.budgets.values()) clearTimeout(timer);
    this.budgets.clear();
  }

  /**
   * Job `key` ran out of time: it fails with `error`, the worker (stuck in
   * OCCT) is terminated and restarted, the other jobs it held fail, and an
   * evaluation that was waiting is sent again to the fresh worker.
   */
  private timeOut(key: string, error: KernelTimeoutError): void {
    this.disarmAll();
    this.worker?.terminate();
    this.worker = null;
    const jobId = Number(key.slice(1));
    if (key.startsWith('e') && this.pending?.jobId === jobId) {
      this.pending.reject(error);
      this.pending = null;
    } else {
      for (const table of [
        this.exportPending,
        this.meshPending,
        this.measurePending,
        this.clearancePending,
        this.queryPending,
      ]) {
        const job = table.get(jobId);
        if (!job) continue;
        table.delete(jobId);
        job.reject(error);
      }
    }
    const lost = 'The CAD kernel was restarted after another computation ran out of time; retry.';
    this.failExports(lost);
    this.rejectMeasurements(lost);
    if (this.disposed) return;
    // An evaluation that was waiting behind the stuck job is resent once the worker is ready.
    this.restartNotice = `The CAD kernel stopped a computation that ran longer than ${Math.round(error.budgetMs / 1000)} s and was restarted. Your document is unchanged.`;
    this.setStatus({
      status: 'loading',
      message: 'Restarting CAD kernel…',
      progress: null,
      loadMs: null,
      notice: this.restartNotice,
    });
    this.start();
  }

  // ---- host queries -----------------------------------------------------------------

  /**
   * Runs a named query the worker's host registered (`workerHost.ts`),
   * outside the evaluation queue, within the job budget.
   */
  protected query<T>(query: string, params: unknown, what: string): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const worker = this.worker;
      if (!worker) {
        reject(new Error('CAD kernel worker is not running'));
        return;
      }
      const jobId = this.nextExportJobId++;
      this.queryPending.set(jobId, { resolve: (value) => resolve(value as T), reject });
      const message: WorkerRequest = { type: 'query', jobId, query, params };
      worker.postMessage(message);
      this.arm(`x${jobId}`, what);
    });
  }

  /** Resolves once the kernel is ready (or rejects when it failed to load). */
  protected whenReady(): Promise<void> {
    return new Promise((resolve, reject) => {
      const off = this.onStatus((status) => {
        if (status.status === 'ready') {
          queueMicrotask(() => off());
          resolve();
        } else if (status.status === 'error') {
          queueMicrotask(() => off());
          reject(new Error(status.message));
        }
      });
    });
  }

  /**
   * Requests a recycle once the heap passes the threshold — or twice what
   * the document needed right after the last recycle, so a document that
   * legitimately needs a large heap is not restarted in a loop.
   */
  private checkHeap(heapBytes: number, warmUp: boolean): void {
    if (warmUp) {
      this.baselineHeap = heapBytes;
      return;
    }
    if (heapBytes > Math.max(this.recycleHeapBytes, 2 * this.baselineHeap)) {
      this.recycleRequested = true;
    }
  }

  /** Restarts a worker whose heap grew past the threshold, while nothing runs. */
  protected override onIdle(): void {
    if (!this.recycleRequested || !this.worker || this.disposed) return;
    if (this.status.status !== 'ready') return;
    // Exports, distance and host queries bypass the queue: never recycle under them.
    if (this.exportPending.size + this.meshPending.size + this.measurePending.size > 0) return;
    if (this.clearancePending.size > 0) return;
    if (this.queryPending.size > 0) return;
    this.recycleRequested = false;
    this.worker.terminate();
    this.worker = null;
    this.warmUpAfterReady = this.lastDocument !== null;
    this.setStatus({
      status: 'loading',
      message: 'Refreshing CAD kernel memory…',
      progress: null,
      loadMs: null,
    });
    this.start();
  }

  private start(): void {
    const worker = this.createWorker();
    this.worker = worker;
    this.meshes = new Map();
    worker.onmessage = (event: MessageEvent<WorkerResponse>) => {
      if (this.worker !== worker) return;
      this.handle(event.data);
    };
    worker.onerror = (event) => {
      if (this.worker !== worker) return;
      event.preventDefault?.();
      this.crash(event.message || 'the kernel worker failed');
    };
  }

  private handle(message: WorkerResponse): void {
    if (message.type === 'status') {
      if (message.status.status === 'ready' && this.restartNotice) {
        const notice = this.restartNotice;
        this.restartNotice = null;
        this.setStatus({ ...message.status, notice });
        this.resend();
        return;
      }
      this.setStatus(message.status);
      if (message.status.status === 'ready' && this.warmUpAfterReady && this.lastDocument) {
        this.warmUpAfterReady = false;
        // Rebuild the prefix cache off the critical path; nobody waits for the result.
        this.evaluateInBackground({ ...this.lastDocument, revision: -1 });
      }
      return;
    }
    if (message.type === 'fatal') {
      this.crash(message.message);
      return;
    }
    if (message.type === 'queryResult' || message.type === 'queryFailed') {
      this.disarm(`x${message.jobId}`);
      const pending = this.queryPending.get(message.jobId);
      if (!pending) return;
      this.queryPending.delete(message.jobId);
      if (message.type === 'queryResult') pending.resolve(message.value);
      else pending.reject(new Error(message.message));
      return;
    }
    if (message.type === 'clearanceResult') {
      this.disarm(`x${message.jobId}`);
      const pending = this.clearancePending.get(message.jobId);
      if (!pending) return;
      this.clearancePending.delete(message.jobId);
      pending.resolve(message.result);
      return;
    }
    if (message.type === 'measureFailed' && this.clearancePending.has(message.jobId)) {
      this.disarm(`x${message.jobId}`);
      const pending = this.clearancePending.get(message.jobId)!;
      this.clearancePending.delete(message.jobId);
      pending.reject(new Error(message.message));
      return;
    }
    if (message.type === 'measureResult' || message.type === 'measureFailed') {
      this.disarm(`x${message.jobId}`);
      const pending = this.measurePending.get(message.jobId);
      if (!pending) return;
      this.measurePending.delete(message.jobId);
      if (message.type === 'measureResult') pending.resolve(message.result);
      else pending.reject(new Error(message.message));
      return;
    }
    if (message.type === 'exportResult' || message.type === 'exportFailed') {
      this.disarm(`x${message.jobId}`);
      const pending = this.exportPending.get(message.jobId);
      if (!pending) return;
      this.exportPending.delete(message.jobId);
      if (message.type === 'exportResult') pending.resolve(new Uint8Array(message.bytes));
      else pending.reject(new Error(message.message));
      return;
    }
    if (message.type === 'meshResult' || message.type === 'meshFailed') {
      this.disarm(`x${message.jobId}`);
      const pending = this.meshPending.get(message.jobId);
      if (!pending) return;
      this.meshPending.delete(message.jobId);
      if (message.type === 'meshResult') pending.resolve(message.bodies);
      else pending.reject(new Error(message.message));
      return;
    }
    if (message.type === 'progress') {
      if (this.pending?.jobId === message.jobId) {
        this.pending.context.progress(message.progress);
        // The budget is per step: a long document that keeps progressing is not stuck.
        this.arm(`e${message.jobId}`, 'evaluating the document');
      }
      return;
    }
    // Every result updates the mesh table, even one nobody waits for any more:
    // the worker's next result refers to it.
    const result = message.type === 'result' ? this.resolveMeshes(message.result) : null;
    if (result) this.checkHeap(result.stats.heapBytes ?? 0, this.pending?.request.revision === -1);
    const pending = this.pending;
    if (!pending || pending.jobId !== message.jobId) return;
    this.disarm(`e${message.jobId}`);
    this.pending = null;
    if (result) pending.resolve(result);
    else if (message.type === 'failed') pending.reject(new Error(message.message));
  }

  /** Fills bodies sent as `meshRef` from the previous result and records this result's meshes. */
  private resolveMeshes(result: EvaluationResult & { bodies: WireBody[] }): EvaluationResult {
    const next = new Map<string, MeshRecord>();
    const bodies = (result.bodies as WireBody[]).map((wire): Body => {
      const { meshRef, ...body } = wire;
      let out: Body = body;
      if (meshRef && body.meshId) {
        const known = this.meshes.get(body.meshId);
        if (known) {
          out = {
            ...body,
            mesh: known.mesh,
            edges: body.edges.map((edge, i) => ({
              ...edge,
              segments: known.segments[i] ?? edge.segments,
            })),
          };
        }
      }
      if (out.meshId) {
        next.set(out.meshId, { mesh: out.mesh, segments: out.edges.map((e) => e.segments) });
      }
      return out;
    });
    this.meshes = next;
    return { ...result, bodies };
  }

  /** Restarts a crashed worker (see the module comment). */
  private crash(detail: string): void {
    this.disarmAll();
    this.worker?.terminate();
    this.worker = null;
    this.failExports(`The CAD kernel stopped while exporting: ${detail}`);
    this.rejectMeasurements(`The CAD kernel stopped: ${detail}`);
    if (this.disposed) return;
    const now = Date.now();
    this.crashes = [...this.crashes.filter((t) => now - t < CRASH_WINDOW_MS), now];
    if (this.crashes.length > MAX_KERNEL_RESTARTS) {
      this.pending?.reject(new Error(`The CAD kernel crashed: ${detail}`));
      this.pending = null;
      this.setStatus({
        status: 'error',
        message: `The CAD kernel keeps crashing (${detail}). Save your work and restart the app.`,
        progress: null,
        loadMs: null,
      });
      return;
    }
    const pending = this.pending;
    if (pending && pending.attempts >= 2) {
      this.pending = null;
      pending.reject(new Error(`The CAD kernel crashed while evaluating this document: ${detail}`));
    }
    this.restartNotice = crashNotice(detail);
    this.setStatus({
      status: 'loading',
      message: 'Restarting CAD kernel…',
      progress: null,
      loadMs: null,
      notice: this.restartNotice,
    });
    this.start();
  }

  /** Sends the job that was running when the worker crashed to the fresh worker (once). */
  private resend(): void {
    const pending = this.pending;
    if (!pending || !this.worker) return;
    pending.attempts += 1;
    this.post(pending);
  }

  private post(pending: Pending): void {
    const message: WorkerRequest = {
      type: 'evaluate',
      jobId: pending.jobId,
      features: pending.request.features,
      ...(pending.request.quality ? { quality: pending.request.quality } : {}),
      ...(pending.request.commitCheck ? { commitCheck: [...pending.request.commitCheck] } : {}),
    };
    this.worker!.postMessage(message);
    this.arm(`e${pending.jobId}`, 'evaluating the document');
  }

  override exportStep(
    features: readonly Feature[],
    bodyIds?: readonly string[],
    options?: StepExportOptions,
  ): Promise<Uint8Array> {
    return new Promise((resolve, reject) => {
      const worker = this.worker;
      if (!worker) {
        reject(new Error('CAD kernel worker is not running'));
        return;
      }
      const jobId = this.nextExportJobId++;
      this.exportPending.set(jobId, { resolve, reject });
      const message: WorkerRequest = {
        type: 'exportStep',
        jobId,
        features: [...features],
        ...(bodyIds ? { bodyIds: [...bodyIds] } : {}),
        ...(options ? { options } : {}),
      };
      worker.postMessage(message);
      this.arm(`x${jobId}`, 'STEP export');
    });
  }

  override exportIges(
    features: readonly Feature[],
    bodyIds?: readonly string[],
    options?: IgesExportOptions,
  ): Promise<Uint8Array> {
    return new Promise((resolve, reject) => {
      const worker = this.worker;
      if (!worker) {
        reject(new Error('CAD kernel worker is not running'));
        return;
      }
      const jobId = this.nextExportJobId++;
      this.exportPending.set(jobId, { resolve, reject });
      const message: WorkerRequest = {
        type: 'exportIges',
        jobId,
        features: [...features],
        ...(bodyIds ? { bodyIds: [...bodyIds] } : {}),
        ...(options ? { options } : {}),
      };
      worker.postMessage(message);
      this.arm(`x${jobId}`, 'IGES export');
    });
  }

  override exportMesh(
    features: readonly Feature[],
    options: MeshExportOptions,
  ): Promise<ExportMeshBody[]> {
    return new Promise((resolve, reject) => {
      const worker = this.worker;
      if (!worker) {
        reject(new Error('CAD kernel worker is not running'));
        return;
      }
      const jobId = this.nextExportJobId++;
      this.meshPending.set(jobId, { resolve, reject });
      const message: WorkerRequest = {
        type: 'exportMesh',
        jobId,
        features: [...features],
        ...(options.bodyIds ? { bodyIds: [...options.bodyIds] } : {}),
        tolerance: options.tolerance,
        angularTolerance: options.angularTolerance,
      };
      worker.postMessage(message);
      this.arm(`x${jobId}`, 'the export tessellation');
    });
  }

  override measureDistance(
    features: readonly Feature[],
    a: DistanceTarget,
    b: DistanceTarget,
  ): Promise<DistanceMeasurement> {
    return new Promise((resolve, reject) => {
      const worker = this.worker;
      if (!worker) {
        reject(new Error('CAD kernel worker is not running'));
        return;
      }
      const jobId = this.nextExportJobId++;
      this.measurePending.set(jobId, { resolve, reject });
      const message: WorkerRequest = {
        type: 'measureDistance',
        jobId,
        features: [...features],
        a,
        b,
      };
      worker.postMessage(message);
      this.arm(`x${jobId}`, 'the distance query');
    });
  }

  override measureClearance(
    features: readonly Feature[],
    request: ClearanceRequest,
  ): Promise<ClearanceResult> {
    return new Promise((resolve, reject) => {
      const worker = this.worker;
      if (!worker) {
        reject(new Error('CAD kernel worker is not running'));
        return;
      }
      const jobId = this.nextExportJobId++;
      this.clearancePending.set(jobId, { resolve, reject });
      const message: WorkerRequest = {
        type: 'measureClearance',
        jobId,
        features: [...features],
        request: {
          pairs: request.pairs.map((p) => ({ a: p.a, b: p.b })),
          ...(request.overlap !== undefined ? { overlap: request.overlap } : {}),
          ...(request.budgetMs !== undefined ? { budgetMs: request.budgetMs } : {}),
        },
      };
      worker.postMessage(message);
      this.arm(`x${jobId}`, 'the clearance query');
    });
  }

  /** Fails every outstanding export (the worker that would answer is gone). */
  private failExports(message: string): void {
    for (const pending of this.exportPending.values()) pending.reject(new Error(message));
    this.exportPending.clear();
    for (const pending of this.meshPending.values()) pending.reject(new Error(message));
    this.meshPending.clear();
    for (const pending of this.queryPending.values()) pending.reject(new Error(message));
    this.queryPending.clear();
  }

  private rejectMeasurements(reason: string): void {
    for (const pending of this.measurePending.values()) pending.reject(new Error(reason));
    this.measurePending.clear();
    for (const pending of this.clearancePending.values()) pending.reject(new Error(reason));
    this.clearancePending.clear();
  }

  protected run(request: EvaluationRequest, context: RunContext): Promise<EvaluationResult> {
    return new Promise((resolve, reject) => {
      if (!this.worker) {
        reject(new Error('CAD kernel worker is not running'));
        return;
      }
      const jobId = this.nextJobId++;
      if (request.channel === 'document') this.lastDocument = request;
      this.pending = { jobId, request, context, attempts: 1, resolve, reject };
      this.post(this.pending);
    });
  }

  protected override abortRunning(): void {
    this.disarmAll();
    this.pending?.reject(new Error('cancelled'));
    this.pending = null;
    this.worker?.terminate();
    this.worker = null;
    this.failExports('cancelled');
    this.rejectMeasurements('cancelled');
    if (this.disposed) return;
    this.setStatus({
      status: 'loading',
      message: 'Restarting CAD kernel…',
      progress: null,
      loadMs: null,
    });
    this.start();
  }

  override dispose(): void {
    super.dispose();
    this.disarmAll();
    this.failExports('The CAD kernel was closed.');
    this.rejectMeasurements('The CAD kernel was closed.');
    this.worker?.terminate();
    this.worker = null;
  }
}
