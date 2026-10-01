/// <reference lib="webworker" />
/**
 * Import worker: parses mesh files, DXF drawings and prepares meshes for
 * mesh → solid off the UI thread, with progress. Cancel = terminate
 * (`importRunner.ts`), so a large file never blocks the window.
 */
import { parseDxfBytes, parseMeshFile, prepareMeshForSolid } from './importParsers.js';
import type { ImportWorkerRequest, ImportWorkerResponse } from './importProtocol.js';

declare const self: DedicatedWorkerGlobalScope;

function post(message: ImportWorkerResponse, transfer: Transferable[] = []): void {
  self.postMessage(message, transfer);
}

self.onmessage = (event: MessageEvent<ImportWorkerRequest>) => {
  const request = event.data;
  let last = 0;
  const progress = (fraction: number) => {
    const now = Date.now();
    if (now - last < 50 && fraction < 1) return;
    last = now;
    post({ type: 'progress', jobId: request.jobId, fraction });
  };
  void (async () => {
    try {
      if (request.type === 'mesh') {
        const result = await parseMeshFile(request.bytes, request.fileName, progress);
        const transfer = result.objects.flatMap((o) => [
          o.mesh.positions.buffer,
          o.mesh.normals.buffer,
          o.mesh.indices.buffer,
        ]);
        post({ type: 'mesh', jobId: request.jobId, result }, transfer as Transferable[]);
      } else if (request.type === 'dxf') {
        post({ type: 'dxf', jobId: request.jobId, drawing: parseDxfBytes(request.bytes) });
      } else {
        const prepared = prepareMeshForSolid(request.positions);
        post({ type: 'solid', jobId: request.jobId, ...prepared }, [
          prepared.mesh.positions.buffer,
          prepared.mesh.indices.buffer,
        ] as Transferable[]);
      }
    } catch (error) {
      post({
        type: 'failed',
        jobId: request.jobId,
        message: error instanceof Error ? error.message : String(error),
        name: error instanceof Error ? error.name : 'Error',
      });
    }
  })();
};
