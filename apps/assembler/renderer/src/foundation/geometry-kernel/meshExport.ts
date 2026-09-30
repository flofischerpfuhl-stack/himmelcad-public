/**
 * Export tessellation at a chosen resolution (STL/3MF export options).
 *
 * OCCT keeps a face's triangulation on the face and `BRepMesh` never
 * coarsens an existing finer one, so meshing the evaluated shape itself
 * could not produce a "coarse" export — and would disturb the viewport's
 * face-mesh cache. Instead the body is deep-copied without its
 * triangulation (`BRepBuilderAPI_Transform` with an identity transform,
 * copying geometry, not meshes) and the copy is meshed and released.
 */
import type { OpenCascade, RawShape, Shape3D } from './occt.js';
import { meshShape } from './occt.js';
import type { BodyMesh } from './types.js';

export type MeshResolution = 'current' | 'coarse' | 'standard' | 'fine';

/** Chordal deflection (mm) and angular deflection (rad) of the export presets. */
export const MESH_RESOLUTIONS: Record<
  Exclude<MeshResolution, 'current'>,
  { tolerance: number; angularTolerance: number; label: string }
> = {
  coarse: { tolerance: 0.1, angularTolerance: 0.5, label: 'Coarse (0.1 mm, 29°)' },
  standard: { tolerance: 0.025, angularTolerance: 0.25, label: 'Standard (0.025 mm, 14°)' },
  fine: { tolerance: 0.005, angularTolerance: 0.1, label: 'Fine (0.005 mm, 6°)' },
};

export interface MeshExportOptions {
  bodyIds?: readonly string[];
  /** Chordal deflection, mm. */
  tolerance: number;
  /** Angular deflection, rad. */
  angularTolerance: number;
}

/** One body tessellated for export. */
export interface ExportMeshBody {
  id: string;
  name: string;
  color: string;
  mesh: BodyMesh;
}

/** Meshes a triangulation-free deep copy of `shape` (the shape itself is not touched). */
export function tessellateCopy(
  oc: OpenCascade,
  shape: Shape3D,
  tolerance: number,
  angularTolerance: number,
): BodyMesh {
  const trsf = new oc.gp_Trsf();
  const builder = new oc.BRepBuilderAPI_Transform(shape.wrapped as never, trsf, true, false);
  let copy: RawShape | null = null;
  try {
    copy = builder.Shape() as unknown as RawShape;
    const raw = meshShape(oc, { wrapped: copy } as unknown as Shape3D, tolerance, angularTolerance);
    const triangleFaces = new Uint32Array(raw.indices.length / 3);
    for (let g = 0, face = 0; g + 2 < raw.faceGroups.length; g += 3, face += 1) {
      const start = raw.faceGroups[g]! / 3;
      const count = raw.faceGroups[g + 1]! / 3;
      triangleFaces.fill(face, start, start + count);
    }
    return {
      positions: raw.positions,
      normals: raw.normals,
      indices: raw.indices,
      triangleFaces,
    };
  } finally {
    (copy as { delete?: () => void } | null)?.delete?.();
    builder.delete();
    trsf.delete();
  }
}
