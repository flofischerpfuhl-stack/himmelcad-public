/**
 * Browser/Electron kernel adapter: OCCT runs in a dedicated Web Worker so
 * loading (~23 MB WebAssembly) and modelling never block the UI thread.
 * Cancelling a running evaluation terminates and restarts the worker.
 */
import type { Feature } from '../model/document.js';
import { QueuedKernelAdapter } from './adapter.js';
import type { WorkerRequest, WorkerResponse } from './kernel.worker.js';
import type { EvaluationRequest, EvaluationResult } from './types.js';

interface Pending {
  jobId: number;
  resolve: (result: EvaluationResult) => void;
  reject: (error: Error) => void;
}

interface PendingExport {
  resolve: (bytes: Uint8Array) => void;
  reject: (error: Error) => void;
}

export class WorkerKernelAdapter extends QueuedKernelAdapter {
  private worker: Worker | null = null;
  private pending: Pending | null = null;
  private nextJobId = 1;
  private readonly exportPending = new Map<number, PendingExport>();
  private nextExportJobId = 1;

  constructor(private readonly createWorker: () => Worker) {
    super();
    this.start();
  }

  private start(): void {
    const worker = this.createWorker();
    this.worker = worker;
    worker.onmessage = (event: MessageEvent<WorkerResponse>) => {
      if (this.worker !== worker) return;
      const message = event.data;
      if (message.type === 'status') {
        this.setStatus(message.status);
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
      const pending = this.pending;
      if (!pending || pending.jobId !== message.jobId) return;
      this.pending = null;
      if (message.type === 'result') pending.resolve(message.result);
      else pending.reject(new Error(message.message));
    };
    worker.onerror = (event) => {
      if (this.worker !== worker) return;
      const text = event.message || 'CAD kernel worker crashed';
      this.pending?.reject(new Error(text));
      this.pending = null;
      for (const pending of this.exportPending.values()) pending.reject(new Error(text));
      this.exportPending.clear();
      this.setStatus({ status: 'error', message: text, progress: null, loadMs: null });
    };
  }

  override exportStep(
    features: readonly Feature[],
    bodyIds?: readonly string[],
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
      };
      worker.postMessage(message);
    });
  }

  protected run(request: EvaluationRequest): Promise<EvaluationResult> {
    return new Promise((resolve, reject) => {
      const worker = this.worker;
      if (!worker) {
        reject(new Error('CAD kernel worker is not running'));
        return;
      }
      const jobId = this.nextJobId++;
      this.pending = { jobId, resolve, reject };
      const message: WorkerRequest = { type: 'evaluate', jobId, features: request.features };
      worker.postMessage(message);
    });
  }

  protected override abortRunning(): void {
    this.pending?.reject(new Error('cancelled'));
    this.pending = null;
    this.worker?.terminate();
    this.worker = null;
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
