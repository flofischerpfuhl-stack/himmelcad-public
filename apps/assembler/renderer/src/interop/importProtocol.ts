/** Messages between the UI thread (`importRunner.ts`) and the import worker. */
import type { DxfDrawing } from './dxf.js';
import type { MeshImportResult } from './meshObjects.js';
import type { MeshCheck, WeldedMesh } from './meshSolid.js';

export type ImportWorkerRequest =
  | { type: 'mesh'; jobId: number; bytes: Uint8Array; fileName: string }
  | { type: 'dxf'; jobId: number; bytes: Uint8Array }
  | { type: 'solid'; jobId: number; positions: Float32Array };

export type ImportWorkerResponse =
  | { type: 'progress'; jobId: number; fraction: number }
  | { type: 'mesh'; jobId: number; result: MeshImportResult }
  | { type: 'dxf'; jobId: number; drawing: DxfDrawing }
  | { type: 'solid'; jobId: number; mesh: WeldedMesh; check: MeshCheck }
  | { type: 'failed'; jobId: number; message: string; name: string };
