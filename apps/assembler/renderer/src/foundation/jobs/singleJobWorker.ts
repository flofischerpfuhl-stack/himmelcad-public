/**
 * Background jobs in a dedicated Web Worker, one at a time (assembler/
 * MODULES.md, module `jobs`): the shape every module worker shares
 * (printability, import parsing).
 *
 * - One job at a time: starting a job cancels the running one.
 * - `cancel()` terminates the worker, so Cancel answers within a bounded
 *   time whatever the job is doing; the next job starts a fresh worker.
 * - Progress messages reach the running job's callback.
 * - Without a worker factory (tests, headless CLI) the job runs on the
 *   calling thread with the same asynchronous contract.
 *
 * The module owns its protocol: it builds the request for a job id and
 * decodes the worker's messages ({@link JobMessage}).
 */

/** What a worker message means for the running job. */
export type JobMessage =
  | { kind: 'progress'; fraction: number; label?: string }
  | { kind: 'done'; value: unknown }
  | { kind: 'failed'; error: Error };

export interface WorkerJob<T> {
  id: number;
  promise: Promise<T>;
  cancel(): void;
}

export interface SingleJobWorkerOptions<Response extends { jobId: number }> {
  /** Starts the worker; `null` runs every job inline. */
  createWorker: (() => Worker) | null;
  /** Reads one message of the running job. */
  decode(message: Response): JobMessage;
  /** The error a cancelled job rejects with. */
  cancelled(): Error;
  /** Message of a worker crash that reports none. */
  crashMessage: string;
}

type Progress = (fraction: number, label: string) => void;

interface Running {
  id: number;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  onProgress?: Progress;
}

export class SingleJobWorker<Request, Response extends { jobId: number }> {
  private worker: Worker | null = null;
  private running: Running | null = null;
  private nextId = 1;

  constructor(private readonly options: SingleJobWorkerOptions<Response>) {}

  /** A job is running. */
  get busy(): boolean {
    return this.running !== null;
  }

  /**
   * Starts a job (cancelling the running one): `request` in the worker, or
   * `inline` on this thread without a worker.
   */
  start<T>(
    request: (jobId: number) => Request,
    inline: () => T | Promise<T>,
    onProgress?: Progress,
  ): WorkerJob<T> {
    this.cancel();
    const id = this.nextId++;
    const promise = new Promise<T>((resolve, reject) => {
      this.running = {
        id,
        resolve: resolve as (value: unknown) => void,
        reject,
        ...(onProgress ? { onProgress } : {}),
      };
      if (!this.options.createWorker) {
        // Same asynchronous contract without a worker (tests, headless).
        setTimeout(() => {
          if (this.running?.id !== id) return;
          // `.then(inline)`: a job that throws synchronously rejects the job, not the timer.
          Promise.resolve()
            .then(inline)
            .then(
              (value) => {
                if (this.running?.id !== id) return;
                this.running = null;
                resolve(value);
              },
              (error: unknown) => {
                if (this.running?.id !== id) return;
                this.running = null;
                reject(error instanceof Error ? error : new Error(String(error)));
              },
            );
        }, 0);
        return;
      }
      this.ensureWorker().postMessage(request(id));
    });
    return {
      id,
      promise,
      cancel: () => {
        if (this.running?.id === id) this.cancel();
      },
    };
  }

  /** Cancels the running job (terminating the worker). */
  cancel(): void {
    const running = this.running;
    if (!running) return;
    this.running = null;
    this.worker?.terminate();
    this.worker = null;
    running.reject(this.options.cancelled());
  }

  dispose(): void {
    this.cancel();
    this.worker?.terminate();
    this.worker = null;
  }

  private ensureWorker(): Worker {
    if (this.worker) return this.worker;
    const worker = this.options.createWorker!();
    this.worker = worker;
    worker.onmessage = (event: MessageEvent<Response>) => {
      if (this.worker !== worker) return;
      const running = this.running;
      if (!running || running.id !== event.data.jobId) return;
      const message = this.options.decode(event.data);
      if (message.kind === 'progress') {
        running.onProgress?.(message.fraction, message.label ?? '');
        return;
      }
      this.running = null;
      if (message.kind === 'failed') running.reject(message.error);
      else running.resolve(message.value);
    };
    worker.onerror = (event) => {
      if (this.worker !== worker) return;
      event.preventDefault?.();
      const running = this.running;
      this.running = null;
      worker.terminate();
      this.worker = null;
      running?.reject(new Error(event.message || this.options.crashMessage));
    };
    return worker;
  }
}
