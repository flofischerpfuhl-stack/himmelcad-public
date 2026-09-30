/**
 * Document edits of the interop features, shared by the UI
 * (`interopStore.ts`) and the agent API (`api/interopApi.ts`) so both
 * produce the same result:
 *
 * - STEP → one `importStep` History step with assembly structure;
 * - mesh files → reference meshes (document-level, not History steps, like
 *   STL import) with their colours and Items folders;
 * - DXF → one new `sketch` step on a plane or planar face;
 * - mesh → solid → one `meshSolid` step (the source reference mesh is only
 *   hidden, never deleted).
 */
import {
  MESH_SOLID_LIMITS,
  encodeMeshSolidPayload,
  type MeshCheck,
  type WeldedMesh,
} from './meshSolid.js';
import { insunitsToMm, INSUNITS_NAME, type DxfDrawing } from './dxf.js';
import { dxfToSketchData, type DxfImportStats } from './dxfSketch.js';
import type { MeshImportResult } from './meshObjects.js';
import type {
  ImportStepFeature,
  MeshSolidFeature,
  SketchFeature,
  SketchPlaneRef,
} from '../model/document.js';
import { IDENTITY_TRANSFORM, type ReferenceMesh } from '../model/referenceMesh.js';
import { EMPTY_SKETCH } from '../sketch/types.js';

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

let meshSerial = 0;

/** A fresh reference mesh id. */
export function newReferenceMeshId(): string {
  meshSerial += 1;
  return `refmesh-${Date.now().toString(36)}-${meshSerial.toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

/** Reference meshes (and their Items folder paths) of a parsed mesh file. */
export function referenceMeshesFromImport(
  result: MeshImportResult,
  fileName: string,
  makeId: () => string = newReferenceMeshId,
): { mesh: ReferenceMesh; folder: string[] }[] {
  return result.objects.map((object) => ({
    folder: object.folder,
    mesh: {
      id: makeId(),
      name: object.name,
      fileName,
      positions: object.mesh.positions,
      normals: object.mesh.normals,
      indices: object.mesh.indices,
      min: object.mesh.min,
      max: object.mesh.max,
      transform: { ...IDENTITY_TRANSFORM },
      hidden: false,
      ...(object.color ? { color: object.color } : {}),
    },
  }));
}

/** An `importStep` step that keeps the product structure. */
export function importStepFeature(input: {
  id: string;
  name: string;
  data: string;
  fileName: string;
}): ImportStepFeature {
  return {
    id: input.id,
    name: input.name,
    suppressed: false,
    kind: 'importStep',
    data: input.data,
    fileName: input.fileName,
    structure: 'assembly',
  };
}

export interface DxfUnits {
  /** Millimetres per drawing unit. */
  scale: number;
  /** Where the scale comes from. */
  source: 'file' | 'unitless' | 'override';
  /** Human-readable, e.g. "inches (from the file)". */
  label: string;
  /** The file's own unit name (`inches`), `null` when it states none. */
  fileUnit: string | null;
}

/**
 * The drawing's unit: `$INSUNITS` when the file states one; otherwise
 * millimetres, said so (never a silent guess); `override` wins.
 */
export function dxfUnits(
  drawing: Pick<DxfDrawing, 'insunits'>,
  override?: number | null,
): DxfUnits {
  const fromFile = insunitsToMm(drawing.insunits);
  const fileUnit =
    fromFile !== null
      ? (INSUNITS_NAME[drawing.insunits ?? -1] ?? `unit code ${drawing.insunits}`)
      : null;
  if (override !== undefined && override !== null) {
    return { scale: override, source: 'override', label: `×${override} to mm (chosen)`, fileUnit };
  }
  if (fromFile !== null) {
    return { scale: fromFile, source: 'file', label: `${fileUnit} (from the file)`, fileUnit };
  }
  return {
    scale: 1,
    source: 'unitless',
    label: 'no unit in the file: read as millimetres',
    fileUnit: null,
  };
}

/** A new sketch step holding the drawing's geometry. */
export function dxfSketchFeature(input: {
  id: string;
  name: string;
  plane: SketchPlaneRef;
  drawing: DxfDrawing;
  scaleToMm: number;
  connect?: boolean;
}): { feature: SketchFeature; stats: DxfImportStats } {
  const { sketch, stats } = dxfToSketchData(
    input.drawing.entities,
    {
      scaleToMm: input.scaleToMm,
      ...(input.connect !== undefined ? { connect: input.connect } : {}),
    },
    EMPTY_SKETCH,
  );
  if (stats.curves === 0 && stats.points === 0) {
    throw new Error(
      'The DXF file has no lines, arcs, circles, polylines, splines or points to import',
    );
  }
  return {
    feature: {
      id: input.id,
      name: input.name,
      suppressed: false,
      kind: 'sketch',
      plane: input.plane,
      ...sketch,
    },
    stats,
  };
}

/** Triangle soup of a reference mesh in world coordinates (its translation applied). */
export function referenceMeshWorldPositions(mesh: ReferenceMesh): Float32Array {
  const { dx, dy, dz } = mesh.transform;
  const out = new Float32Array(mesh.indices.length * 3);
  for (let i = 0; i < mesh.indices.length; i += 1) {
    const v = mesh.indices[i]! * 3;
    out[i * 3] = mesh.positions[v]! + dx;
    out[i * 3 + 1] = mesh.positions[v + 1]! + dy;
    out[i * 3 + 2] = mesh.positions[v + 2]! + dz;
  }
  return out;
}

/** A `meshSolid` step from a prepared (welded, checked) mesh. */
export function meshSolidFeature(input: {
  id: string;
  name: string;
  sourceName: string;
  mesh: WeldedMesh;
}): MeshSolidFeature {
  return {
    id: input.id,
    name: input.name,
    suppressed: false,
    kind: 'meshSolid',
    data: bytesToBase64(encodeMeshSolidPayload(input.mesh)),
    fileName: input.sourceName,
    triangles: input.mesh.indices.length / 3,
  };
}

/** One-line summary of a mesh check for notices and API results. */
export function describeMeshCheck(check: MeshCheck): string {
  const fixes: string[] = [];
  if (check.flipped > 0)
    fixes.push(`${check.flipped} flipped triangle${check.flipped === 1 ? '' : 's'} re-oriented`);
  if (check.inverted) fixes.push('inside-out mesh reversed');
  if (check.degenerate > 0)
    fixes.push(
      `${check.degenerate} degenerate triangle${check.degenerate === 1 ? '' : 's'} dropped`,
    );
  return `${check.triangles.toLocaleString('en-US')} triangles → ${check.faces.toLocaleString('en-US')} faces${fixes.length ? ` (${fixes.join(', ')})` : ''}`;
}

export { MESH_SOLID_LIMITS };
