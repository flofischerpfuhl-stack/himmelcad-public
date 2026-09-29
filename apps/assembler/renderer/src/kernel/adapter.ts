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
 * - Failures never leave partial state behind: an outcome is either a full
 *   `EvaluationResult` or an error.
 */
import type {
  EvaluationChannel,
  EvaluationOutcome,
  EvaluationRequest,
  EvaluationResult,
  KernelStatusInfo,
} from './types.js';
import type { KernelEvaluator } from './evaluator.js';

export interface KernelJob {
  id: number;
  revision: number;
  outcome: Promise<EvaluationOutcome>;
}

export interface KernelAdapter {
  readonly status: KernelStatusInfo;
  /** Subscribes to load/ready/error changes; called immediately with the current status. */
  onStatus(listener: (status: KernelStatusInfo) => void): () => void;
  evaluate(request: EvaluationRequest): KernelJob;
  /**
   * Cancels a job. A waiting job resolves `cancelled` at once. A running job
   * resolves `cancelled` at once too; with `hard` the computation itself is
   * stopped (worker restart), otherwise it finishes and its result is dropped.
   */
  cancel(jobId: number, options?: { hard?: boolean }): void;
  dispose(): void;
}

interface QueuedJob {
  id: number;
  request: EvaluationRequest;
  resolve: (outcome: EvaluationOutcome) => void;
}

/**
 * Shared queue/coalescing/status logic. Subclasses implement `run` (one
 * request at a time) and optionally `abortRunning`.
 */
export abstract class QueuedKernelAdapter implements KernelAdapter {
  private nextId = 1;
  private readonly waiting = new Map<EvaluationChannel, QueuedJob>();
  private running: QueuedJob | null = null;
  private listeners = new Set<(status: KernelStatusInfo) => void>();
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
  }

  /** Evaluates one request. Must not throw synchronously for kernel errors. */
  protected abstract run(request: EvaluationRequest): Promise<EvaluationResult>;

  /** Stops the running computation, if the implementation can. Default: let it finish and discard it. */
  protected abortRunning(): void {
    // Nothing to stop in the base implementation; the result is simply dropped.
  }

  private pump(): void {
    if (this.running || this.disposed || this.currentStatus.status !== 'ready') return;
    // The document channel wins over previews: committed state first.
    const next = this.waiting.get('document') ?? this.waiting.get('preview');
    if (!next) return;
    this.waiting.delete(next.request.channel);
    this.running = next;
    this.run(next.request)
      .then(
        (result): EvaluationOutcome => ({ kind: 'done', revision: next.request.revision, result }),
        (error: unknown): EvaluationOutcome => ({
          kind: 'failed',
          revision: next.request.revision,
          message: error instanceof Error ? error.message : String(error),
        }),
      )
      .then((outcome) => {
        if (this.running === next) {
          this.running = null;
          next.resolve(outcome);
        }
        this.pump();
      });
  }
}

/**
 * Runs the evaluator on the calling thread. Used by the Node test suite
 * (real OCCT, no worker) and as a reference implementation of the contract.
 * Never use it in the browser UI: OCCT calls block the thread.
 */
export class InProcessKernelAdapter extends QueuedKernelAdapter {
  private evaluator: KernelEvaluator | null = null;

  constructor(load: () => Promise<KernelEvaluator>) {
    super();
    load().then(
      (evaluator) => {
        this.evaluator = evaluator;
        this.setStatus({
          status: 'ready',
          message: 'CAD kernel ready',
          progress: null,
          loadMs: null,
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
  }

  protected async run(request: EvaluationRequest): Promise<EvaluationResult> {
    // Yield once so callers observe the asynchronous contract.
    await Promise.resolve();
    return this.evaluator!.evaluate(request.features);
  }
}
