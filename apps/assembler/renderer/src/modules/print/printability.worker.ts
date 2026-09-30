/// <reference lib="webworker" />
/**
 * Printability worker: runs the analysis (`analysis.ts`) and the
 * orientation ranking (`orientation.ts`) off the UI thread. Pure
 * TypeScript, no WebAssembly. Cancel = the UI terminates this worker.
 */
import { analyzePrintability } from './analysis.js';
import { rankOrientations } from './orientation.js';
import type { PrintWorkerRequest, PrintWorkerResponse } from './workerProtocol.js';

declare const self: DedicatedWorkerGlobalScope;

function post(message: PrintWorkerResponse): void {
  self.postMessage(message);
}

self.onmessage = (event: MessageEvent<PrintWorkerRequest>) => {
  const message = event.data;
  try {
    if (message.type === 'analyze') {
      let last = 0;
      const report = analyzePrintability(message.bodies, message.settings, {
        ...(message.sampleBudget !== undefined ? { sampleBudget: message.sampleBudget } : {}),
        onProgress: (fraction, label) => {
          const now = performance.now();
          if (now - last < 50 && fraction < 1) return;
          last = now;
          post({ type: 'progress', jobId: message.jobId, fraction, label });
        },
      });
      post({ type: 'report', jobId: message.jobId, report });
    } else {
      const candidates = rankOrientations(message.mesh, message.thresholdDeg, {
        faceLabel: (_key, index) => message.faceLabels[index] ?? `Face ${index + 1} down`,
      });
      post({ type: 'orientation', jobId: message.jobId, candidates });
    }
  } catch (error) {
    post({
      type: 'failed',
      jobId: message.jobId,
      message: error instanceof Error ? error.message : String(error),
    });
  }
};
