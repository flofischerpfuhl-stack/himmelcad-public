// Himmelcad vendor patch: webpack `require('./*.worker.js').default` → Vite
// `?worker` imports. Vite bundles the worker entry as a Worker constructor.
// See vendor/three-loader/VENDOR.md.
import DecoderWorker from './decoder.worker.js?worker';
import GltfDecoderWorker from './gltf-decoder.worker.js?worker';
import GltfSplatsDecoderWorker from './gltf-splats-decoder.worker.js?worker';

// Create enums for different types of workers
export enum WorkerType {
  DECODER_WORKER = 'DECODER_WORKER',
  DECODER_WORKER_GLTF = 'DECODER_WORKER_GLTF',
  DECODER_WORKER_SPLATS = 'DECODER_WORKER_SPLATS',
}

function createWorker(type: WorkerType): Worker {
  switch (type) {
    case WorkerType.DECODER_WORKER:
      return new DecoderWorker();
    case WorkerType.DECODER_WORKER_GLTF:
      return new GltfDecoderWorker();
    case WorkerType.DECODER_WORKER_SPLATS:
      return new GltfSplatsDecoderWorker();
    default:
      throw new Error('Unknown worker type');
  }
}

export class WorkerPool {
  // Workers will be an object that has a key for each worker type and the value is an array of Workers that can be empty
  private workers: { [key in WorkerType]: Worker[] } = {
    DECODER_WORKER: [],
    DECODER_WORKER_GLTF: [],
    DECODER_WORKER_SPLATS: [],
  };

  getWorker(workerType: WorkerType): Worker {
    // Throw error if workerType is not recognized
    if (this.workers[workerType] === undefined) {
      throw new Error('Unknown worker type');
    }
    // Given a worker URL, if URL does not exist in the worker object, create a new array with the URL as a key
    if (this.workers[workerType].length === 0) {
      const worker = createWorker(workerType);
      this.workers[workerType].push(worker);
    }
    const worker = this.workers[workerType].pop();
    if (worker === undefined) {
      // Typescript needs this
      throw new Error('No workers available');
    }
    // Return the last worker in the array and remove it from the array
    return worker;
  }

  returnWorker(workerType: WorkerType, worker: Worker) {
    this.workers[workerType].push(worker);
  }
}
