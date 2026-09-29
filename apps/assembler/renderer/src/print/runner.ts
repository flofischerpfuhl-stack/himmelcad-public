/**
 * Runs printability jobs in the printability worker (browser/Electron) or,
 * without a worker factory (tests, headless CLI), on the calling thread.
 *
 * - One job at a time: starting a job cancels the running one.
 * - `cancel()` terminates the worker (bounded response time, whatever the
 *   analysis is doing); the next job starts a fresh worker.
 * - Progress is reported between analysis steps (at most ~20 per second).
 */
import { analyzePrintability, type PrintBodyInput, type PrintReport } from './analysis.js';
import {
  rankOrientations,
  type OrientationCandidate,
  type OrientationMesh,
} from './orientation.js';
import type { PrintSettings } from './settings.js';
import type { PrintWorkerRequest, PrintWorkerResponse } from './workerProtocol.js';

export class PrintJobCancelled extends Error {
  constructor() {
    super('cancelled');
    this.name = 'PrintJobCancelled';
  }
}

export interface PrintJob<T> {
  id: number;
  promise: Promise<T>;
  cancel(): void;
}

type Progress = (fraction: number, label: string) => void;

interface Running {
  id: number;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  onProgress?: Progress;
}

export class PrintabilityRunner {
  private worker: Worker | null = null;
  private running: Running | null = null;
  private nextId = 1;

  constructor(private readonly createWorker: (() => Worker) | null) {}

  analyze(
    bodies: PrintBodyInput[],
    settings: PrintSettings,
    onProgress?: Progress,
    sampleBudget?: number,
  ): PrintJob<PrintReport> {
    return this.start<PrintReport>(
      (id) => ({
        type: 'analyze',
        jobId: id,
        bodies,
        settings,
        ...(sampleBudget !== undefined ? { sampleBudget } : {}),
      }),
      () =>
        analyzePrintability(bodies, settings, {
          ...(onProgress ? { onProgress } : {}),
          ...(sampleBudget !== undefined ? { sampleBudget } : {}),
        }),
      onProgress,
    );
  }

  orient(
    mesh: OrientationMesh,
    thresholdDeg: number,
    faceLabels: string[],
  ): PrintJob<OrientationCandidate[]> {
    return this.start<OrientationCandidate[]>(
      (id) => ({ type: 'orient', jobId: id, mesh, thresholdDeg, faceLabels }),
      () =>
        rankOrientations(mesh, thresholdDeg, {
          faceLabel: (_key, index) => faceLabels[index] ?? `Face ${index + 1} down`,
        }),
    );
  }

  /** Cancels the running job (terminating the worker). */
  cancel(): void {
    const running = this.running;
    if (!running) return;
    this.running = null;
    this.worker?.terminate();
    this.worker = null;
    running.reject(new PrintJobCancelled());
  }

  dispose(): void {
    this.cancel();
    this.worker?.terminate();
    this.worker = null;
  }

  private start<T>(
    request: (id: number) => PrintWorkerRequest,
    inline: () => T,
    onProgress?: Progress,
  ): PrintJob<T> {
    this.cancel();
    const id = this.nextId++;
    const promise = new Promise<T>((resolve, reject) => {
      this.running = {
        id,
        resolve: resolve as (value: unknown) => void,
        reject,
        ...(onProgress ? { onProgress } : {}),
      };
      if (!this.createWorker) {
        // Same asynchronous contract without a worker (tests, headless).
        setTimeout(() => {
          if (this.running?.id !== id) return;
          try {
            const value = inline();
            if (this.running?.id !== id) return;
            this.running = null;
            resolve(value);
          } catch (error) {
            if (this.running?.id !== id) return;
            this.running = null;
            reject(error instanceof Error ? error : new Error(String(error)));
          }
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

  private ensureWorker(): Worker {
    if (this.worker) return this.worker;
    const worker = this.createWorker!();
    this.worker = worker;
    worker.onmessage = (event: MessageEvent<PrintWorkerResponse>) => {
      if (this.worker !== worker) return;
      const message = event.data;
      const running = this.running;
      if (!running || running.id !== message.jobId) return;
      if (message.type === 'progress') {
        running.onProgress?.(message.fraction, message.label);
        return;
      }
      this.running = null;
      if (message.type === 'failed') running.reject(new Error(message.message));
      else if (message.type === 'report') running.resolve(message.report);
      else running.resolve(message.candidates);
    };
    worker.onerror = (event) => {
      if (this.worker !== worker) return;
      event.preventDefault?.();
      const running = this.running;
      this.running = null;
      worker.terminate();
      this.worker = null;
      running?.reject(new Error(event.message || 'The printability worker failed'));
    };
    return worker;
  }
}
