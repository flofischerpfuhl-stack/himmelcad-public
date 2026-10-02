/**
 * App-owned boundary to the CAD kernel. The store only talks to this
 * interface, so the OCCT-in-WebAssembly worker used by the Phase 1 spike can
 * later be replaced by a native OCCT/Rust adapter without touching the UI.
 *
 * Contract:
 * - `evaluate` is asynchronous and returns a job with a request id.
 * - Requests are serialized. Per channel at most one request waits; a newer
 *   request on the same channel supersedes the waiting one (its promise
 *   resolves `superseded`). A running request is never interrupted by a
 *   newer one; callers discard stale results by comparing the echoed
 *   `revision` with their current one.
 * - `cancel(id)` resolves the job as `cancelled` immediately. With
 *   `{ hard: true }` a running computation is stopped (the worker adapter
 *   terminates and restarts its worker), so response time is bounded by the
 *   restart, not by the OCCT operation.
 * - The running job reports progress between features (`onActivity`), so a
 *   long computation can show progress and offer Cancel.
 * - Kernel crashes (wasm abort, out of memory) are recovered: the kernel is
 *   restarted, the status carries a user-facing `notice`, and the job that
 *   was running is retried once on the fresh kernel (a second crash fails
 *   it). The document lives in the store, so nothing is lost.
 * - Failures never leave partial state behind: an outcome is either a full
 *   `EvaluationResult` or an error.
 */
import type { Feature } from '../document/document.js';
import type {
  ClearanceRequest,
  ClearanceResult,
  DistanceMeasurement,
  DistanceTarget,
  EvaluationChannel,
  EvaluationOutcome,
  EvaluationProgress,
  EvaluationRequest,
  EvaluationResult,
  KernelStatusInfo,
} from './types.js';
import type { KernelEvaluator } from './evaluator.js';
import type { ExportMeshBody, MeshExportOptions } from './meshExport.js';
import type { IgesExportOptions } from './igesExchange.js';
import type { StepExportOptions } from './stepExport.js';
import { isFatalKernelError } from './fatal.js';
import { isKernelTimeout } from './timeout.js';

export interface KernelJob {
  id: number;
  revision: number;
  outcome: Promise<EvaluationOutcome>;
}

/** The computation currently running in the kernel. */
export interface KernelActivity {
  jobId: number;
  channel: EvaluationChannel;
  revision: number;
  /** `performance.now()`/`Date.now()` time the job started running. */
  startedAt: number;
  /** Last progress report (`null` until the first one). */
  progress: EvaluationProgress | null;
}

export interface KernelAdapter {
  readonly status: KernelStatusInfo;
  /** Subscribes to load/ready/error changes; called immediately with the current status. */
  onStatus(listener: (status: KernelStatusInfo) => void): () => void;
  /**
   * Subscribes to the running computation: called with the activity when a
   * job starts, on every progress report, and with `null` when it ends.
   */
  onActivity(listener: (activity: KernelActivity | null) => void): () => void;
  evaluate(request: EvaluationRequest): KernelJob;
  /**
   * Cancels a job. A waiting job resolves `cancelled` at once. A running job
   * resolves `cancelled` at once too; with `hard` the computation itself is
   * stopped (worker restart), otherwise it finishes and its result is dropped.
   */
  cancel(jobId: number, options?: { hard?: boolean }): void;
  /**
   * One-off exact-geometry STEP export of the given features (optionally
   * only the given body ids). Bypasses the preview/document coalescing
   * queue: it is a user-initiated action, not a continuous evaluation.
   */
  exportStep(
    features: readonly Feature[],
    bodyIds?: readonly string[],
    options?: StepExportOptions,
  ): Promise<Uint8Array>;
  /**
   * One-off export tessellation of the given features' bodies at a chosen
   * deflection (STL/3MF resolution presets); like {@link exportStep} it
   * bypasses the evaluation queue.
   */
  exportMesh(features: readonly Feature[], options: MeshExportOptions): Promise<ExportMeshBody[]>;
  /**
   * One-off IGES export (geometry and unit only), like {@link exportStep}.
   * Rejects with "IGES is not in this build" on the default OCCT module.
   */
  exportIges(
    features: readonly Feature[],
    bodyIds?: readonly string[],
    options?: IgesExportOptions,
  ): Promise<Uint8Array>;
  /**
   * Exact minimum distance between two references of the document
   * `features` evaluates to (Measure panel). Like `exportStep` a one-off
   * query outside the coalescing queue. Optional: adapters without it make
   * the Measure panel fall back to a mesh estimate labelled "approx.".
   */
  measureDistance?(
    features: readonly Feature[],
    a: DistanceTarget,
    b: DistanceTarget,
  ): Promise<DistanceMeasurement>;
  /**
   * Clearance of body pairs of the document `features` evaluates to: exact
   * minimum distance, closest points, contact or overlap with the shared
   * volume (Measure, Print analysis, clearance checks). A one-off query like
   * `measureDistance`; the request's `budgetMs` bounds its kernel time.
   * Optional: adapters without it report clearance as unavailable.
   */
  measureClearance?(
    features: readonly Feature[],
    request: ClearanceRequest,
  ): Promise<ClearanceResult>;
  dispose(): void;
}

interface QueuedJob {
  id: number;
  request: EvaluationRequest;
  resolve: (outcome: EvaluationOutcome) => void;
}

/** Handle a running job gets to report progress. */
export interface RunContext {
  jobId: number;
  progress(progress: EvaluationProgress): void;
}

function clock(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}

/**
 * Shared queue/coalescing/status logic. Subclasses implement `run` (one
 * request at a time) and optionally `abortRunning`.
 */
export abstract class QueuedKernelAdapter implements KernelAdapter {
  private nextId = 1;
  private readonly waiting = new Map<EvaluationChannel, QueuedJob>();
  private running: QueuedJob | null = null;
  private activity: KernelActivity | null = null;
  private listeners = new Set<(status: KernelStatusInfo) => void>();
  private activityListeners = new Set<(activity: KernelActivity | null) => void>();
  private currentStatus: KernelStatusInfo = {
    status: 'loading',
    message: 'Loading CAD kernel…',
    progress: null,
    loadMs: null,
  };
  protected disposed = false;

  get status(): KernelStatusInfo {
    return this.currentStatus;
  }

  protected setStatus(status: KernelStatusInfo): void {
    this.currentStatus = status;
    for (const listener of this.listeners) listener(status);
    if (status.status === 'ready') this.pump();
    if (status.status === 'error') {
      for (const job of this.waiting.values()) {
        job.resolve({ kind: 'failed', revision: job.request.revision, message: status.message });
      }
      this.waiting.clear();
    }
  }

  onStatus(listener: (status: KernelStatusInfo) => void): () => void {
    this.listeners.add(listener);
    listener(this.currentStatus);
    return () => this.listeners.delete(listener);
  }

  onActivity(listener: (activity: KernelActivity | null) => void): () => void {
    this.activityListeners.add(listener);
    listener(this.activity);
    return () => this.activityListeners.delete(listener);
  }

  private setActivity(activity: KernelActivity | null): void {
    this.activity = activity;
    for (const listener of this.activityListeners) listener(activity);
  }

  evaluate(request: EvaluationRequest): KernelJob {
    const id = this.nextId++;
    const outcome = new Promise<EvaluationOutcome>((resolve) => {
      if (this.disposed) {
        resolve({ kind: 'cancelled', revision: request.revision });
        return;
      }
      if (this.currentStatus.status === 'error') {
        resolve({
          kind: 'failed',
          revision: request.revision,
          message: this.currentStatus.message,
        });
        return;
      }
      const previous = this.waiting.get(request.channel);
      if (previous) previous.resolve({ kind: 'superseded', revision: previous.request.revision });
      this.waiting.set(request.channel, { id, request, resolve });
    });
    this.pump();
    return { id, revision: request.revision, outcome };
  }

  cancel(jobId: number, options?: { hard?: boolean }): void {
    for (const [channel, job] of this.waiting) {
      if (job.id === jobId) {
        this.waiting.delete(channel);
        job.resolve({ kind: 'cancelled', revision: job.request.revision });
        return;
      }
    }
    if (this.running?.id !== jobId) return;
    const job = this.running;
    job.resolve({ kind: 'cancelled', revision: job.request.revision });
    if (options?.hard) {
      this.running = null;
      this.setActivity(null);
      this.abortRunning();
      this.pump();
    }
    // Soft cancel: the computation finishes in the background; its (second) resolve is a no-op.
  }

  dispose(): void {
    this.disposed = true;
    for (const job of this.waiting.values()) {
      job.resolve({ kind: 'cancelled', revision: job.request.revision });
    }
    this.waiting.clear();
    if (this.running) {
      this.running.resolve({ kind: 'cancelled', revision: this.running.request.revision });
      this.running = null;
    }
    this.listeners.clear();
    this.activityListeners.clear();
  }

  exportStep(
    _features: readonly Feature[],
    _bodyIds?: readonly string[],
    _options?: StepExportOptions,
  ): Promise<Uint8Array> {
    return Promise.reject(new Error('STEP export is not supported by this kernel adapter'));
  }

  exportIges(
    _features: readonly Feature[],
    _bodyIds?: readonly string[],
    _options?: IgesExportOptions,
  ): Promise<Uint8Array> {
    return Promise.reject(new Error('IGES export is not supported by this kernel adapter'));
  }

  exportMesh(
    _features: readonly Feature[],
    _options: MeshExportOptions,
  ): Promise<ExportMeshBody[]> {
    return Promise.reject(new Error('Mesh export is not supported by this kernel adapter'));
  }

  measureDistance(
    _features: readonly Feature[],
    _a: DistanceTarget,
    _b: DistanceTarget,
  ): Promise<DistanceMeasurement> {
    return Promise.reject(new Error('Distance queries are not supported by this kernel adapter'));
  }

  measureClearance(
    _features: readonly Feature[],
    _request: ClearanceRequest,
  ): Promise<ClearanceResult> {
    return Promise.reject(new Error('Clearance queries are not supported by this kernel adapter'));
  }

  /** Evaluates one request. Must not throw synchronously for kernel errors. */
  protected abstract run(
    request: EvaluationRequest,
    context: RunContext,
  ): Promise<EvaluationResult>;

  /**
   * Queues background work (e.g. cache warm-up) only if nothing is running or
   * waiting; any later request on its channel supersedes it.
   */
  protected evaluateInBackground(request: EvaluationRequest): void {
    if (this.running || this.waiting.size > 0) return;
    void this.evaluate(request).outcome;
  }

  /** Called whenever the queue runs empty (nothing running, nothing waiting). */
  protected onIdle(): void {
    // Nothing to do by default.
  }

  /** Stops the running computation, if the implementation can. Default: let it finish and discard it. */
  protected abortRunning(): void {
    // Nothing to stop in the base implementation; the result is simply dropped.
  }

  private pump(): void {
    if (this.running || this.disposed || this.currentStatus.status !== 'ready') return;
    // The document channel wins over previews (committed state first), background work comes last.
    const next =
      this.waiting.get('document') ?? this.waiting.get('preview') ?? this.waiting.get('background');
    if (!next) {
      this.onIdle();
      return;
    }
    this.waiting.delete(next.request.channel);
    this.running = next;
    this.setActivity({
      jobId: next.id,
      channel: next.request.channel,
      revision: next.request.revision,
      startedAt: clock(),
      progress: null,
    });
    const context: RunContext = {
      jobId: next.id,
      progress: (progress) => {
        if (this.running !== next || !this.activity) return;
        this.setActivity({ ...this.activity, progress });
      },
    };
    this.run(next.request, context)
      .then(
        (result): EvaluationOutcome => ({ kind: 'done', revision: next.request.revision, result }),
        (error: unknown): EvaluationOutcome => ({
          kind: 'failed',
          revision: next.request.revision,
          message: error instanceof Error ? error.message : String(error),
          ...(isKernelTimeout(error) ? { code: 'kernelTimeout' as const } : {}),
        }),
      )
      .then((outcome) => {
        if (this.running === next) {
          this.running = null;
          this.setActivity(null);
          next.resolve(outcome);
        }
        this.pump();
      });
  }
}

/** How many kernel crashes within {@link CRASH_WINDOW_MS} are recovered before giving up. */
export const MAX_KERNEL_RESTARTS = 3;
export const CRASH_WINDOW_MS = 60_000;

/**
 * wasm heap size above which the kernel is restarted when it next runs
 * idle. OCCT in this build leaks inside its own algorithms (40–260 KB per
 * boolean, ~16 KB per `BRepCheck` face check, ~27 B per explored sub-shape;
 * wasm memory never shrinks), so a long session is recycled
 * before wasm32 runs out of address space. The document lives in the store;
 * a restart only drops the kernel's caches.
 */
export const RECYCLE_HEAP_BYTES = 1024 * 1024 * 1024;

/** User-facing notice after a recovered kernel crash. */
export function crashNotice(detail: string): string {
  return `The CAD kernel stopped unexpectedly (${detail}) and was restarted. Your document is unchanged.`;
}

/**
 * Runs the evaluator on the calling thread. Used by the Node test suite
 * (real OCCT, no worker), the headless CLI and as a reference
 * implementation of the contract. Never use it in the browser UI: OCCT
 * calls block the thread. A fatal kernel error reloads the kernel
 * (`load` is called again) and retries the job once; a heap past
 * `recycleHeapBytes` reloads it the next time the queue is idle.
 */
export class InProcessKernelAdapter extends QueuedKernelAdapter {
  private evaluator: KernelEvaluator | null = null;
  private ready: Promise<KernelEvaluator>;
  private crashes: number[] = [];
  private recycleRequested = false;
  /** Heap after the first evaluation on a (re)loaded kernel: what the document needs. */
  private baselineHeap: number | null = null;
  private readonly recycleHeapBytes: number;

  constructor(
    private readonly load: () => Promise<KernelEvaluator>,
    options: { recycleHeapBytes?: number } = {},
  ) {
    super();
    this.recycleHeapBytes = options.recycleHeapBytes ?? RECYCLE_HEAP_BYTES;
    this.ready = this.start();
  }

  protected override onIdle(): void {
    if (!this.recycleRequested || !this.evaluator || this.disposed) return;
    this.recycleRequested = false;
    this.baselineHeap = null;
    this.evaluator = null;
    this.setStatus({
      status: 'loading',
      message: 'Refreshing CAD kernel memory…',
      progress: null,
      loadMs: null,
    });
    this.ready = this.start();
  }

  private start(notice?: string): Promise<KernelEvaluator> {
    const ready = this.load();
    ready.then(
      (evaluator) => {
        this.evaluator = evaluator;
        this.setStatus({
          status: 'ready',
          message: 'CAD kernel ready',
          progress: null,
          loadMs: null,
          ...(notice ? { notice } : {}),
          ...(evaluator.formatCapabilities ? { capabilities: evaluator.formatCapabilities() } : {}),
        });
      },
      (error: unknown) => {
        this.setStatus({
          status: 'error',
          message: `CAD kernel failed to load: ${error instanceof Error ? error.message : String(error)}`,
          progress: null,
          loadMs: null,
        });
      },
    );
    return ready;
  }

  protected async run(request: EvaluationRequest, context: RunContext): Promise<EvaluationResult> {
    // Yield once so callers observe the asynchronous contract.
    await Promise.resolve();
    for (let attempt = 0; ; attempt += 1) {
      const evaluator = this.evaluator ?? (await this.ready);
      try {
        const result = await evaluator.evaluate(request.features, {
          quality: request.quality ?? 'final',
          ...(request.commitCheck ? { commitCheck: request.commitCheck } : {}),
          onProgress: (progress) => context.progress(progress),
        });
        const heap = result.stats.heapBytes ?? 0;
        if (this.baselineHeap === null) this.baselineHeap = heap;
        else if (heap > Math.max(this.recycleHeapBytes, 2 * this.baselineHeap)) {
          this.recycleRequested = true;
        }
        return result;
      } catch (error) {
        if (!isFatalKernelError(error) || this.disposed) throw error;
        const detail = error instanceof Error ? error.message : String(error);
        const now = Date.now();
        this.crashes = [...this.crashes.filter((t) => now - t < CRASH_WINDOW_MS), now];
        this.evaluator = null;
        if (this.crashes.length > MAX_KERNEL_RESTARTS) {
          this.setStatus({
            status: 'error',
            message: `The CAD kernel keeps crashing (${detail}). Save your work and restart the app.`,
            progress: null,
            loadMs: null,
          });
          throw error;
        }
        this.setStatus({
          status: 'loading',
          message: 'Restarting CAD kernel…',
          progress: null,
          loadMs: null,
          notice: crashNotice(detail),
        });
        this.ready = this.start(crashNotice(detail));
        if (attempt >= 1) {
          throw new Error(`The CAD kernel crashed while evaluating this document: ${detail}`);
        }
      }
    }
  }

  override async exportStep(
    features: readonly Feature[],
    bodyIds?: readonly string[],
    options?: StepExportOptions,
  ): Promise<Uint8Array> {
    const evaluator = this.evaluator ?? (await this.ready);
    return evaluator.exportStep(features, bodyIds, options);
  }

  override async exportIges(
    features: readonly Feature[],
    bodyIds?: readonly string[],
    options?: IgesExportOptions,
  ): Promise<Uint8Array> {
    const evaluator = this.evaluator ?? (await this.ready);
    if (!evaluator.exportIges) throw new Error('IGES export is not supported by this kernel');
    return evaluator.exportIges(features, bodyIds, options);
  }

  override async exportMesh(
    features: readonly Feature[],
    options: MeshExportOptions,
  ): Promise<ExportMeshBody[]> {
    const evaluator = this.evaluator ?? (await this.ready);
    if (!evaluator.exportMesh) throw new Error('Mesh export is not supported by this kernel');
    return evaluator.exportMesh(features, options);
  }

  override async measureDistance(
    features: readonly Feature[],
    a: DistanceTarget,
    b: DistanceTarget,
  ): Promise<DistanceMeasurement> {
    const evaluator = this.evaluator ?? (await this.ready);
    if (!evaluator.measureDistance) return super.measureDistance(features, a, b);
    return evaluator.measureDistance(features, a, b);
  }

  override async measureClearance(
    features: readonly Feature[],
    request: ClearanceRequest,
  ): Promise<ClearanceResult> {
    const evaluator = this.evaluator ?? (await this.ready);
    if (!evaluator.measureClearance) return super.measureClearance(features, request);
    return evaluator.measureClearance(features, request);
  }
}
