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
  DistanceMeasurement,
  DistanceTarget,
  EvaluationRequest,
  EvaluationResult,
} from './types.js';
import type { ExportMeshBody, MeshExportOptions } from './meshExport.js';
import type { IgesExportOptions } from './igesExchange.js';
import type { StepExportOptions } from './stepExport.js';

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

  constructor(
    private readonly createWorker: () => Worker,
    options: { recycleHeapBytes?: number } = {},
  ) {
    super();
    this.recycleHeapBytes = options.recycleHeapBytes ?? RECYCLE_HEAP_BYTES;
    this.start();
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
    if (message.type === 'measureResult' || message.type === 'measureFailed') {
      const pending = this.measurePending.get(message.jobId);
      if (!pending) return;
      this.measurePending.delete(message.jobId);
      if (message.type === 'measureResult') pending.resolve(message.result);
      else pending.reject(new Error(message.message));
      return;
    }
    if (message.type === 'exportResult' || message.type === 'exportFailed') {
      const pending = this.exportPending.get(message.jobId);
      if (!pending) return;
      this.exportPending.delete(message.jobId);
      if (message.type === 'exportResult') pending.resolve(new Uint8Array(message.bytes));
      else pending.reject(new Error(message.message));
      return;
    }
    if (message.type === 'meshResult' || message.type === 'meshFailed') {
      const pending = this.meshPending.get(message.jobId);
      if (!pending) return;
      this.meshPending.delete(message.jobId);
      if (message.type === 'meshResult') pending.resolve(message.bodies);
      else pending.reject(new Error(message.message));
      return;
    }
    if (message.type === 'progress') {
      if (this.pending?.jobId === message.jobId) this.pending.context.progress(message.progress);
      return;
    }
    // Every result updates the mesh table, even one nobody waits for any more:
    // the worker's next result refers to it.
    const result = message.type === 'result' ? this.resolveMeshes(message.result) : null;
    if (result) this.checkHeap(result.stats.heapBytes ?? 0, this.pending?.request.revision === -1);
    const pending = this.pending;
    if (!pending || pending.jobId !== message.jobId) return;
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
    });
  }

  /** Fails every outstanding export (the worker that would answer is gone). */
  private failExports(message: string): void {
    for (const pending of this.exportPending.values()) pending.reject(new Error(message));
    this.exportPending.clear();
    for (const pending of this.meshPending.values()) pending.reject(new Error(message));
    this.meshPending.clear();
  }

  private rejectMeasurements(reason: string): void {
    for (const pending of this.measurePending.values()) pending.reject(new Error(reason));
    this.measurePending.clear();
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
    this.worker?.terminate();
    this.worker = null;
  }
}
