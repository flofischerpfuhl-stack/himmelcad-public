/**
 * The kernel side of the worker protocol (`workerProtocol.ts`), independent
 * of the transport: the app's Web Worker (`workerRuntime.ts`) and the
 * headless CLI's Node worker thread (`headless/kernelThread.ts`) both feed
 * it the requests and hand it their `postMessage`.
 *
 * Meshes are sent once: a body whose `meshId` was part of the previous
 * result is sent without its mesh arrays (`meshRef`), and the main thread
 * takes them from the previous result (`workerAdapter.ts`). The evaluator
 * keeps its meshes cached for reuse, so arrays are copied, not transferred.
 */
import type { KernelEvaluator } from './evaluator.js';
import { isFatalKernelError } from './fatal.js';
import type { EvaluationResult } from './types.js';
import type { WireBody, WorkerRequest, WorkerResponse } from './workerProtocol.js';

/** A named query of a host (`WorkerRequest` `query`): runs on the loaded evaluator. */
export type KernelQuery = (evaluator: KernelEvaluator, params: unknown) => Promise<unknown>;

/** Posts a response to the main thread (with transferable buffers). */
export type KernelPost = (message: WorkerResponse, transfer?: Transferable[]) => void;

/**
 * A handler for the requests of one worker: evaluations, STEP/IGES/mesh
 * exports, distance queries and the host's named `queries`, each answered
 * once the kernel is `ready`.
 */
export function createKernelRequestHandler(
  ready: Promise<KernelEvaluator>,
  post: KernelPost,
  queries: Readonly<Record<string, KernelQuery>> = {},
): (message: WorkerRequest) => void {
  /** Mesh ids of the bodies in the last posted result (the main thread holds their arrays). */
  let sentMeshIds = new Set<string>();

  function toWire(result: EvaluationResult): EvaluationResult & { bodies: WireBody[] } {
    const next = new Set<string>();
    const bodies = result.bodies.map((body): WireBody => {
      if (!body.meshId) return body;
      next.add(body.meshId);
      if (!sentMeshIds.has(body.meshId)) return body;
      return {
        ...body,
        meshRef: true,
        mesh: {
          positions: new Float32Array(0),
          normals: new Float32Array(0),
          indices: new Uint32Array(0),
          triangleFaces: new Uint32Array(0),
        },
        edges: body.edges.map((edge) => ({ ...edge, segments: new Float32Array(0) })),
      };
    });
    sentMeshIds = next;
    return { ...result, bodies };
  }

  const failure = (
    error: unknown,
    type: 'failed' | 'exportFailed' | 'meshFailed' | 'measureFailed' | 'queryFailed',
    jobId: number,
  ): WorkerResponse => ({
    type: isFatalKernelError(error) ? 'fatal' : type,
    jobId,
    message: error instanceof Error ? error.message : String(error),
  });

  return (message) => {
    if (message.type === 'exportStep' || message.type === 'exportIges') {
      void ready.then(
        async (evaluator) => {
          try {
            const bytes = (
              message.type === 'exportIges'
                ? await (evaluator.exportIges
                    ? evaluator.exportIges(message.features, message.bodyIds, message.options)
                    : Promise.reject(new Error('IGES export is not supported by this kernel')))
                : await evaluator.exportStep(message.features, message.bodyIds, message.options)
            ).slice();
            post({ type: 'exportResult', jobId: message.jobId, bytes: bytes.buffer }, [
              bytes.buffer,
            ]);
          } catch (error) {
            post(failure(error, 'exportFailed', message.jobId));
          }
        },
        () => undefined,
      );
      return;
    }
    if (message.type === 'exportMesh') {
      void ready.then(
        async (evaluator) => {
          try {
            if (!evaluator.exportMesh) throw new Error('Mesh export is not supported');
            const bodies = await evaluator.exportMesh(message.features, {
              ...(message.bodyIds ? { bodyIds: message.bodyIds } : {}),
              tolerance: message.tolerance,
              angularTolerance: message.angularTolerance,
            });
            const transfer = bodies.flatMap((b) => [
              b.mesh.positions.buffer,
              b.mesh.normals.buffer,
              b.mesh.indices.buffer,
              b.mesh.triangleFaces.buffer,
            ]);
            post({ type: 'meshResult', jobId: message.jobId, bodies }, transfer);
          } catch (error) {
            post(failure(error, 'meshFailed', message.jobId));
          }
        },
        () => undefined,
      );
      return;
    }
    if (message.type === 'measureDistance') {
      void ready.then(
        async (evaluator) => {
          try {
            if (!evaluator.measureDistance) throw new Error('Distance queries are not available');
            const result = await evaluator.measureDistance(message.features, message.a, message.b);
            post({ type: 'measureResult', jobId: message.jobId, result });
          } catch (error) {
            post(failure(error, 'measureFailed', message.jobId));
          }
        },
        () => undefined,
      );
      return;
    }
    if (message.type === 'measureClearance') {
      void ready.then(
        async (evaluator) => {
          try {
            if (!evaluator.measureClearance) throw new Error('Clearance queries are not available');
            const result = await evaluator.measureClearance(message.features, message.request);
            post({ type: 'clearanceResult', jobId: message.jobId, result });
          } catch (error) {
            post(failure(error, 'measureFailed', message.jobId));
          }
        },
        () => undefined,
      );
      return;
    }
    if (message.type === 'query') {
      void ready.then(
        async (evaluator) => {
          try {
            const query = queries[message.query];
            if (!query) throw new Error(`Unknown kernel query "${message.query}"`);
            post({
              type: 'queryResult',
              jobId: message.jobId,
              value: await query(evaluator, message.params),
            });
          } catch (error) {
            post(failure(error, 'queryFailed', message.jobId));
          }
        },
        () => undefined,
      );
      return;
    }
    if (message.type !== 'evaluate') return;
    void ready.then(
      async (evaluator) => {
        let result: EvaluationResult;
        try {
          result = await evaluator.evaluate(message.features, {
            quality: message.quality ?? 'final',
            ...(message.commitCheck ? { commitCheck: message.commitCheck } : {}),
            onProgress: (progress) => post({ type: 'progress', jobId: message.jobId, progress }),
          });
        } catch (error) {
          post(failure(error, 'failed', message.jobId));
          return;
        }
        post({ type: 'result', jobId: message.jobId, result: toWire(result) });
      },
      () => undefined,
    );
  };
}
