/** Messages between the UI thread (`runner.ts`) and the printability worker. */
import type { PrintBodyInput, PrintReport } from './analysis.js';
import type { OrientationCandidate, OrientationMesh } from './orientation.js';
import type { PrintSettings } from './settings.js';

export type PrintWorkerRequest =
  | {
      type: 'analyze';
      jobId: number;
      bodies: PrintBodyInput[];
      settings: PrintSettings;
      sampleBudget?: number;
    }
  | {
      type: 'orient';
      jobId: number;
      mesh: OrientationMesh;
      thresholdDeg: number;
      /** Labels of the planar faces (by index in `mesh.planarFaces`). */
      faceLabels: string[];
    };

export type PrintWorkerResponse =
  | { type: 'progress'; jobId: number; fraction: number; label: string }
  | { type: 'report'; jobId: number; report: PrintReport }
  | { type: 'orientation'; jobId: number; candidates: OrientationCandidate[] }
  | { type: 'failed'; jobId: number; message: string };
