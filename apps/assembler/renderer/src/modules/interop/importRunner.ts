/**
 * Runs import parsing in the import worker (browser/Electron) or, without a
 * worker factory (tests, headless CLI), on the calling thread — on the
 * shared single-job worker of the jobs module
 * (`foundation/jobs/singleJobWorker.ts`): one job at a time; `cancel()`
 * terminates the worker, so Cancel answers immediately whatever the parser
 * is doing; progress reaches the running job's callback.
 */
import { SingleJobWorker, type JobMessage } from '../../foundation/jobs/singleJobWorker.js';
import type { DxfDrawing } from './dxf.js';
import { parseDxfBytes, parseMeshFile, prepareMeshForSolid } from './importParsers.js';
import type { ImportWorkerRequest, ImportWorkerResponse } from './importProtocol.js';
import { ImportCancelledError, type MeshImportResult } from './meshObjects.js';
import type { MeshCheck, WeldedMesh } from '../../foundation/geometry-kernel/meshSolidPayload.js';

type Progress = (fraction: number) => void;

function decode(message: ImportWorkerResponse): JobMessage {
  switch (message.type) {
    case 'progress':
      return { kind: 'progress', fraction: message.fraction };
    case 'failed': {
      const error = new Error(message.message);
      error.name = message.name;
      return { kind: 'failed', error };
    }
    case 'mesh':
      return { kind: 'done', value: message.result };
    case 'dxf':
      return { kind: 'done', value: message.drawing };
    case 'solid':
      return { kind: 'done', value: { mesh: message.mesh, check: message.check } };
  }
}

export class ImportRunner {
  private readonly jobs: SingleJobWorker<ImportWorkerRequest, ImportWorkerResponse>;

  constructor(createWorker: (() => Worker) | null) {
    this.jobs = new SingleJobWorker({
      createWorker,
      decode,
      cancelled: () => new ImportCancelledError(),
      crashMessage: 'The import worker failed',
    });
  }

  get busy(): boolean {
    return this.jobs.busy;
  }

  parseMesh(bytes: Uint8Array, fileName: string, onProgress?: Progress): Promise<MeshImportResult> {
    return this.jobs.start<MeshImportResult>(
      (jobId) => ({ type: 'mesh', jobId, bytes, fileName }),
      () => parseMeshFile(bytes, fileName, onProgress),
      onProgress,
    ).promise;
  }

  parseDxf(bytes: Uint8Array, onProgress?: Progress): Promise<DxfDrawing> {
    return this.jobs.start<DxfDrawing>(
      (jobId) => ({ type: 'dxf', jobId, bytes }),
      () => parseDxfBytes(bytes),
      onProgress,
    ).promise;
  }

  prepareSolid(
    positions: Float32Array,
    onProgress?: Progress,
  ): Promise<{ mesh: WeldedMesh; check: MeshCheck }> {
    return this.jobs.start<{ mesh: WeldedMesh; check: MeshCheck }>(
      (jobId) => ({ type: 'solid', jobId, positions }),
      () => prepareMeshForSolid(positions),
      onProgress,
    ).promise;
  }

  /** Cancels the running job (terminating the worker); it rejects with {@link ImportCancelledError}. */
  cancel(): void {
    this.jobs.cancel();
  }

  dispose(): void {
    this.jobs.dispose();
  }
}

let runner = new ImportRunner(null);

/** The runner the UI imports use (the interop module installs the worker-backed one). */
export function importRunner(): ImportRunner {
  return runner;
}

export function setImportRunner(next: ImportRunner): void {
  runner = next;
}
