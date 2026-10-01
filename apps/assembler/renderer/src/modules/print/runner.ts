/**
 * Runs printability jobs in the printability worker (browser/Electron) or,
 * without a worker factory (tests, headless CLI), on the calling thread —
 * on the shared single-job worker of the jobs module
 * (`foundation/jobs/singleJobWorker.ts`):
 *
 * - One job at a time: starting a job cancels the running one.
 * - `cancel()` terminates the worker (bounded response time, whatever the
 *   analysis is doing); the next job starts a fresh worker.
 * - Progress is reported between analysis steps (at most ~20 per second).
 */
import {
  SingleJobWorker,
  type JobMessage,
  type WorkerJob,
} from '../../foundation/jobs/singleJobWorker.js';
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

export type PrintJob<T> = WorkerJob<T>;

type Progress = (fraction: number, label: string) => void;

function decode(message: PrintWorkerResponse): JobMessage {
  switch (message.type) {
    case 'progress':
      return { kind: 'progress', fraction: message.fraction, label: message.label };
    case 'failed':
      return { kind: 'failed', error: new Error(message.message) };
    case 'report':
      return { kind: 'done', value: message.report };
    case 'orientation':
      return { kind: 'done', value: message.candidates };
  }
}

export class PrintabilityRunner {
  private readonly jobs: SingleJobWorker<PrintWorkerRequest, PrintWorkerResponse>;

  constructor(createWorker: (() => Worker) | null) {
    this.jobs = new SingleJobWorker({
      createWorker,
      decode,
      cancelled: () => new PrintJobCancelled(),
      crashMessage: 'The printability worker failed',
    });
  }

  analyze(
    bodies: PrintBodyInput[],
    settings: PrintSettings,
    onProgress?: Progress,
    sampleBudget?: number,
  ): PrintJob<PrintReport> {
    return this.jobs.start<PrintReport>(
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
    return this.jobs.start<OrientationCandidate[]>(
      (id) => ({ type: 'orient', jobId: id, mesh, thresholdDeg, faceLabels }),
      () =>
        rankOrientations(mesh, thresholdDeg, {
          faceLabel: (_key, index) => faceLabels[index] ?? `Face ${index + 1} down`,
        }),
    );
  }

  /** Cancels the running job (terminating the worker). */
  cancel(): void {
    this.jobs.cancel();
  }

  dispose(): void {
    this.jobs.dispose();
  }
}
