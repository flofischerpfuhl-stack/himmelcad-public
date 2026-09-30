/**
 * Runs import parsing in the import worker (browser/Electron) or, without a
 * worker factory (tests, headless CLI), on the calling thread. One job at a
 * time; `cancel()` terminates the worker, so Cancel answers immediately
 * whatever the parser is doing.
 */
import type { DxfDrawing } from './dxf.js';
import { parseDxfBytes, parseMeshFile, prepareMeshForSolid } from './importParsers.js';
import type { ImportWorkerRequest, ImportWorkerResponse } from './importProtocol.js';
import { ImportCancelledError, type MeshImportResult } from './meshObjects.js';
import type { MeshCheck, WeldedMesh } from '../foundation/geometry-kernel/meshSolidPayload.js';

type Progress = (fraction: number) => void;

interface Running {
  id: number;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  onProgress?: Progress;
}

export class ImportRunner {
  private worker: Worker | null = null;
  private running: Running | null = null;
  private nextId = 1;

  constructor(private readonly createWorker: (() => Worker) | null) {}

  get busy(): boolean {
    return this.running !== null;
  }

  parseMesh(bytes: Uint8Array, fileName: string, onProgress?: Progress): Promise<MeshImportResult> {
    return this.start(
      (jobId) => ({ type: 'mesh', jobId, bytes, fileName }),
      () => parseMeshFile(bytes, fileName, onProgress),
      onProgress,
    );
  }

  parseDxf(bytes: Uint8Array, onProgress?: Progress): Promise<DxfDrawing> {
    return this.start(
      (jobId) => ({ type: 'dxf', jobId, bytes }),
      () => Promise.resolve(parseDxfBytes(bytes)),
      onProgress,
    );
  }

  prepareSolid(
    positions: Float32Array,
    onProgress?: Progress,
  ): Promise<{ mesh: WeldedMesh; check: MeshCheck }> {
    return this.start(
      (jobId) => ({ type: 'solid', jobId, positions }),
      () => Promise.resolve(prepareMeshForSolid(positions)),
      onProgress,
    );
  }

  cancel(): void {
    const running = this.running;
    if (!running) return;
    this.running = null;
    this.worker?.terminate();
    this.worker = null;
    running.reject(new ImportCancelledError());
  }

  private start<T>(
    request: (jobId: number) => ImportWorkerRequest,
    inline: () => Promise<T>,
    onProgress?: Progress,
  ): Promise<T> {
    this.cancel();
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      this.running = {
        id,
        resolve: resolve as (value: unknown) => void,
        reject,
        ...(onProgress ? { onProgress } : {}),
      };
      if (!this.createWorker) {
        setTimeout(() => {
          if (this.running?.id !== id) return;
          // `.then(inline)`: a parser that throws synchronously rejects the job, not the timer.
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
  }

  private ensureWorker(): Worker {
    if (this.worker) return this.worker;
    const worker = this.createWorker!();
    this.worker = worker;
    worker.onmessage = (event: MessageEvent<ImportWorkerResponse>) => {
      if (this.worker !== worker) return;
      const message = event.data;
      const running = this.running;
      if (!running || running.id !== message.jobId) return;
      if (message.type === 'progress') {
        running.onProgress?.(message.fraction);
        return;
      }
      this.running = null;
      if (message.type === 'failed') {
        const error = new Error(message.message);
        error.name = message.name;
        running.reject(error);
      } else if (message.type === 'mesh') running.resolve(message.result);
      else if (message.type === 'dxf') running.resolve(message.drawing);
      else running.resolve({ mesh: message.mesh, check: message.check });
    };
    worker.onerror = (event) => {
      if (this.worker !== worker) return;
      event.preventDefault?.();
      const running = this.running;
      this.running = null;
      worker.terminate();
      this.worker = null;
      running?.reject(new Error(event.message || 'The import worker failed'));
    };
    return worker;
  }
}

let runner = new ImportRunner(null);

/** The runner the UI imports use (`main.tsx` installs the worker-backed one). */
export function importRunner(): ImportRunner {
  return runner;
}

export function setImportRunner(next: ImportRunner): void {
  runner = next;
}
