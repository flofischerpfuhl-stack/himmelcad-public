/**
 * Main-thread side of the sketch solver worker (`solver.worker.ts`): an
 * async {@link SketchSolver}. Requests are answered in order; a crashed
 * worker rejects the pending requests and is restarted on the next call.
 */
import type { SolverWorkerRequest, SolverWorkerResponse } from './solver.worker.js';
import type { SketchSolver, SolveRequest, SolveResult } from './solverTypes.js';

export class WorkerSketchSolver implements SketchSolver {
  private worker: Worker | null = null;
  private nextId = 1;
  private readonly pending = new Map<
    number,
    { resolve: (r: SolveResult) => void; reject: (e: Error) => void }
  >();

  constructor(private readonly createWorker: () => Worker) {}

  private ensure(): Worker {
    if (this.worker) return this.worker;
    const worker = this.createWorker();
    worker.onmessage = (event: MessageEvent<SolverWorkerResponse>) => {
      const message = event.data;
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if ('result' in message) pending.resolve(message.result);
      else pending.reject(new Error(message.error));
    };
    worker.onerror = (event) => {
      const error = new Error(event.message || 'Sketch solver worker crashed');
      for (const pending of this.pending.values()) pending.reject(error);
      this.pending.clear();
      worker.terminate();
      if (this.worker === worker) this.worker = null;
    };
    this.worker = worker;
    return worker;
  }

  solve(request: SolveRequest): Promise<SolveResult> {
    return new Promise((resolve, reject) => {
      const id = this.nextId++;
      this.pending.set(id, { resolve, reject });
      const message: SolverWorkerRequest = { id, request };
      this.ensure().postMessage(message);
    });
  }

  dispose(): void {
    this.worker?.terminate();
    this.worker = null;
    for (const pending of this.pending.values()) pending.reject(new Error('Sketch solver stopped'));
    this.pending.clear();
  }
}
