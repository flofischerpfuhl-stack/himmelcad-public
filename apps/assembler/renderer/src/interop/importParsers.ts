/**
 * The file parsers the import worker runs (also used in-process by the
 * headless CLI and tests): mesh files (STL, 3MF, OBJ) → mesh objects,
 * DXF text → drawing, and the mesh-to-solid preparation (weld + checks).
 * Pure TypeScript, no DOM, no OCCT.
 */
import { parseStl } from '../kernel/stlImport.js';
import { parseDxf, type DxfDrawing } from './dxf.js';
import { MeshImportError, type MeshImportResult } from './meshObjects.js';
import {
  prepareSolidMesh,
  weldMesh,
  type MeshCheck,
  type WeldedMesh,
} from '../foundation/geometry-kernel/meshSolidPayload.js';
import { parseObj } from './objImport.js';
import { parseThreeMf } from './threeMfImport.js';

export type ImportFormat = 'hcasm' | 'step' | 'iges' | 'stl' | '3mf' | 'obj' | 'dxf';

/** Import format of a file name (by extension), or `null`. */
export function importFormatOf(fileName: string): ImportFormat | null {
  const ext = /\.([^.\\/]+)$/.exec(fileName)?.[1]?.toLowerCase() ?? '';
  switch (ext) {
    case 'hcasm':
      return 'hcasm';
    case 'step':
    case 'stp':
    case 'p21':
      return 'step';
    case 'iges':
    case 'igs':
      return 'iges';
    case 'stl':
      return 'stl';
    case '3mf':
      return '3mf';
    case 'obj':
      return 'obj';
    case 'dxf':
      return 'dxf';
    default:
      return null;
  }
}

export type Progress = (fraction: number) => void;

export async function parseMeshFile(
  bytes: Uint8Array,
  fileName: string,
  onProgress?: Progress,
): Promise<MeshImportResult> {
  const format = importFormatOf(fileName);
  if (format === '3mf') return parseThreeMf(bytes, fileName, onProgress);
  if (format === 'obj') {
    return parseObj(new TextDecoder('utf-8', { fatal: false }).decode(bytes), fileName, onProgress);
  }
  if (format === 'stl') {
    const mesh = parseStl(bytes);
    if (mesh.triangleCount === 0)
      throw new MeshImportError(`"${fileName}" has no usable triangles.`);
    onProgress?.(1);
    return {
      format: 'stl',
      objects: [
        {
          name: fileName.replace(/\.stl$/i, '') || 'Reference mesh',
          color: null,
          folder: [],
          mesh,
        },
      ],
      declaredUnit: null,
      unitScale: 1,
      warnings:
        mesh.degenerateCount > 0
          ? [
              `${mesh.degenerateCount} degenerate triangle${mesh.degenerateCount === 1 ? ' was' : 's were'} dropped`,
            ]
          : [],
    };
  }
  throw new MeshImportError(`"${fileName}" is not a mesh file (STL, 3MF or OBJ)`);
}

export function parseDxfBytes(bytes: Uint8Array): DxfDrawing {
  return parseDxf(new TextDecoder('utf-8', { fatal: false }).decode(bytes));
}

/** Welds and checks a triangle soup for mesh → solid (throws `MeshSolidError` with the reason). */
export function prepareMeshForSolid(positions: Float32Array): {
  mesh: WeldedMesh;
  check: MeshCheck;
} {
  const welded = weldMesh(positions);
  return prepareSolidMesh(welded);
}
