/**
 * File › Export STL (all bodies / the selected body) and Export 3MF: the
 * evaluated display meshes plus the visible reference meshes, written
 * through the runtime's save dialog or download (`persistence.ts`). 3MF
 * objects carry the user's body names and `setAppearance` colours. Each
 * resolves `false` when there was nothing to export or the save was
 * cancelled.
 */
import { useItemsStore, withDisplayNames } from '../../foundation/commands/items.js';
import { referenceMeshToBody } from '../../foundation/commands/referenceMesh.js';
import { useAssemblerStore } from '../../foundation/commands/store.js';
import * as io from '../../foundation/document/persistence.js';
import { exportBodyStl, stlBufferForMeshes } from '../../foundation/geometry-kernel/stlExport.js';
import { buildThreeMf } from '../../foundation/geometry-kernel/threeMf.js';

function sanitizeFileName(name: string): string {
  const cleaned = name.trim().replace(/[\\/:*?"<>|]+/g, '_');
  return cleaned || 'Project';
}

/** One STL of every evaluated body and every visible reference mesh. */
export async function exportStlAll(): Promise<boolean> {
  const doc = useAssemblerStore.getState();
  const visibleMeshes = doc.referenceMeshes.filter((m) => !m.hidden);
  if (doc.evaluation.bodies.length === 0 && visibleMeshes.length === 0) return false;
  const meshBodies = visibleMeshes.map(referenceMeshToBody);
  const bytes = new Uint8Array(
    stlBufferForMeshes([...doc.evaluation.bodies, ...meshBodies].map((b) => b.mesh)),
  );
  const result = await io.exportBinary(
    bytes,
    `${sanitizeFileName(doc.projectName)}.stl`,
    [{ name: 'STL', extensions: ['stl'] }],
    'model/stl',
  );
  return result !== null;
}

/** One body as STL, named after its Items name. */
export async function exportStlBody(bodyId: string): Promise<boolean> {
  const doc = useAssemblerStore.getState();
  const body = withDisplayNames(doc.evaluation.bodies, useItemsStore.getState()).find(
    (b) => b.id === bodyId,
  );
  if (!body) return false;
  const buffer = exportBodyStl(doc.evaluation.bodies, bodyId);
  if (!buffer) return false;
  const result = await io.exportBinary(
    new Uint8Array(buffer),
    `${sanitizeFileName(body.name)}.stl`,
    [{ name: 'STL', extensions: ['stl'] }],
    'model/stl',
  );
  return result !== null;
}

/** A 3MF package of every evaluated body and every visible reference mesh. */
export async function export3mf(): Promise<boolean> {
  const doc = useAssemblerStore.getState();
  const visibleMeshes = doc.referenceMeshes.filter((m) => !m.hidden);
  if (doc.evaluation.bodies.length === 0 && visibleMeshes.length === 0) return false;
  // 3MF objects carry the user's body names and `setAppearance` colours (`Body.color`).
  const bytes = buildThreeMf([
    ...withDisplayNames(doc.evaluation.bodies, useItemsStore.getState()),
    ...visibleMeshes.map(referenceMeshToBody),
  ]);
  const result = await io.exportBinary(
    bytes,
    `${sanitizeFileName(doc.projectName)}.3mf`,
    [{ name: '3MF', extensions: ['3mf'] }],
    'model/3mf',
  );
  return result !== null;
}
