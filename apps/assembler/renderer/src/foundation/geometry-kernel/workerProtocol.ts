/**
 * Messages between the UI thread (`workerAdapter.ts`) and the kernel Web
 * Worker (`kernel.worker.ts`). Kept apart from the worker module so tests
 * and the adapter can use the types without the worker's Vite imports.
 */
import type { Feature } from '../document/document.js';
import type { ExportMeshBody } from './meshExport.js';
import type { IgesExportOptions } from './igesExchange.js';
import type { StepExportOptions } from './stepExport.js';
import type {
  Body,
  DistanceMeasurement,
  DistanceTarget,
  EvaluationProgress,
  EvaluationResult,
  KernelStatusInfo,
  TessellationQuality,
} from './types.js';

export type WorkerRequest =
  | {
      type: 'evaluate';
      jobId: number;
      features: Feature[];
      quality?: TessellationQuality;
      /** `EvaluationRequest.commitCheck`. */
      commitCheck?: string[];
    }
  | {
      type: 'exportStep';
      jobId: number;
      features: Feature[];
      bodyIds?: string[];
      options?: StepExportOptions;
    }
  | {
      /** IGES export; answered like `exportStep` (`exportResult` / `exportFailed`). */
      type: 'exportIges';
      jobId: number;
      features: Feature[];
      bodyIds?: string[];
      options?: IgesExportOptions;
    }
  | {
      type: 'exportMesh';
      jobId: number;
      features: Feature[];
      bodyIds?: string[];
      tolerance: number;
      angularTolerance: number;
    }
  | {
      type: 'measureDistance';
      jobId: number;
      features: Feature[];
      a: DistanceTarget;
      b: DistanceTarget;
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
  | { type: 'meshFailed'; jobId: number; message: string }
  | { type: 'measureResult'; jobId: number; result: DistanceMeasurement }
  | { type: 'measureFailed'; jobId: number; message: string };
