/**
 * "Open in slicer": the model as a 3MF handed to a registered slicer by the
 * Electron main process (`electron/slicerIpc.ts`); `dev:web` downloads the
 * file instead. Moved from the print exports unchanged.
 */
import { buildThreeMf } from '../../foundation/geometry-kernel/threeMf.js';
import { useItemsStore, withDisplayNames } from '../../foundation/commands/items.js';
import { referenceMeshToBody } from '../../foundation/commands/referenceMesh.js';
import { useAssemblerStore } from '../../foundation/commands/store.js';
import * as io from '../../foundation/document/persistence.js';
import { host } from '../../foundation/host/index.js';

function sanitizeFileName(name: string): string {
  return name.trim().replace(/[\\/:*?"<>|]+/g, '_') || 'Model';
}

/** The 3MF handed to a slicer: every body (display names, colours) plus visible reference meshes. */
export function handoffThreeMf(): Uint8Array {
  const state = useAssemblerStore.getState();
  const bodies = [
    ...withDisplayNames(state.evaluation.bodies, useItemsStore.getState()),
    ...state.referenceMeshes.filter((m) => !m.hidden).map(referenceMeshToBody),
  ];
  return buildThreeMf(bodies, { title: state.projectName });
}

/**
 * Opens the model in slicer `slicerId` (desktop), or downloads the 3MF in
 * the browser build. Returns a user-facing result message.
 */
export async function openInSlicer(
  slicerId: string | null,
): Promise<{ ok: boolean; message: string }> {
  const state = useAssemblerStore.getState();
  if (state.evaluation.bodies.length === 0 && state.referenceMeshes.every((m) => m.hidden)) {
    return { ok: false, message: 'There is nothing to print yet.' };
  }
  const bytes = handoffThreeMf();
  const api = host().slicers;
  if (!api) {
    await io.exportBinary(
      bytes,
      `${sanitizeFileName(state.projectName)}.3mf`,
      [{ name: '3MF', extensions: ['3mf'] }],
      'model/3mf',
    );
    return {
      ok: true,
      message: 'Downloaded the 3MF: open it in your slicer (direct handoff needs the desktop app).',
    };
  }
  if (!slicerId) return { ok: false, message: 'Register a slicer first (Slicers…).' };
  const result = await api.open(slicerId, bytes, state.projectName);
  return result.ok
    ? { ok: true, message: `Opened in ${result.slicer}.` }
    : { ok: false, message: result.error };
}
