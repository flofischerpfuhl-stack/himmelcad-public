/**
 * Messages between the UI thread (`workerAdapter.ts`) and the kernel Web
 * Worker (`kernel.worker.ts`). Kept apart from the worker module so tests
 * and the adapter can use the types without the worker's Vite imports.
 */
import type { Feature } from '../model/document.js';
import type { ExportMeshBody } from './meshExport.js';
import type {
  Body,
  EvaluationProgress,
  EvaluationResult,
  KernelStatusInfo,
  TessellationQuality,
} from './types.js';

export type WorkerRequest =
  | { type: 'evaluate'; jobId: number; features: Feature[]; quality?: TessellationQuality }
  | { type: 'exportStep'; jobId: number; features: Feature[]; bodyIds?: string[] }
  | {
      type: 'exportMesh';
      jobId: number;
      features: Feature[];
      bodyIds?: string[];
      tolerance: number;
      angularTolerance: number;
    };

/** A body whose mesh arrays were already sent with the previous result (`meshRef: true`). */
export type WireBody = Body & { meshRef?: true };

export type WorkerResponse =
  | { type: 'status'; status: KernelStatusInfo }
  | { type: 'progress'; jobId: number; progress: EvaluationProgress }
  | { type: 'result'; jobId: number; result: EvaluationResult & { bodies: WireBody[] } }
  | { type: 'failed'; jobId: number; message: string }
  | { type: 'fatal'; jobId: number; message: string }
  | { type: 'exportResult'; jobId: number; bytes: ArrayBuffer }
  | { type: 'exportFailed'; jobId: number; message: string }
  | { type: 'meshResult'; jobId: number; bodies: ExportMeshBody[] }
  | { type: 'meshFailed'; jobId: number; message: string };
