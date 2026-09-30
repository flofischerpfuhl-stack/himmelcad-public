/**
 * Print exports from the UI: STL with options (scope, binary/ASCII,
 * resolution preset, triangle-count preview) and "Open in slicer" (3MF
 * handed to a registered slicer by the Electron main process; `dev:web`
 * downloads the file instead). Meshes of the `current` resolution are the
 * evaluated render meshes; the presets re-tessellate a copy of each body in
 * the kernel worker (`kernel/meshExport.ts`).
 */
import type { KernelAdapter } from '../foundation/geometry-kernel/adapter.js';
import { MESH_RESOLUTIONS, type MeshResolution } from '../foundation/geometry-kernel/meshExport.js';
import { stlBytes, type StlFormat } from '../kernel/stlExport.js';
import { buildThreeMf } from '../kernel/threeMf.js';
import type { BodyMesh } from '../foundation/geometry-kernel/types.js';
import { useItemsStore, withDisplayNames } from '../interface/shell-ui/items.js';
import * as io from '../foundation/document/persistence.js';
import { referenceMeshToBody } from '../model/referenceMesh.js';
import { shownFeatures, useAssemblerStore } from '../foundation/commands/store.js';

let kernel: KernelAdapter | null = null;

/** The kernel adapter used for re-tessellated exports (set once by `main.tsx`). */
export function setPrintKernel(adapter: KernelAdapter): void {
  kernel = adapter;
}

export type StlScope = 'all' | 'visible' | 'selected' | 'each';

export interface StlExportOptions {
  scope: StlScope;
  format: StlFormat;
  resolution: MeshResolution;
}

export interface NamedMesh {
  id: string;
  name: string;
  mesh: BodyMesh;
}

function sanitizeFileName(name: string): string {
  return name.trim().replace(/[\\/:*?"<>|]+/g, '_') || 'Model';
}

/** Body ids an STL export of `scope` covers (selected = selected bodies). */
export function stlBodyIds(scope: StlScope): string[] {
  const state = useAssemblerStore.getState();
  if (scope === 'selected') {
    return state.selection
      .filter((s): s is { kind: 'body'; bodyId: string } => s.kind === 'body')
      .map((s) => s.bodyId);
  }
  if (scope === 'visible') {
    const hidden = new Set(state.hiddenBodyIds);
    return state.evaluation.bodies.filter((b) => !hidden.has(b.id)).map((b) => b.id);
  }
  return state.evaluation.bodies.map((b) => b.id);
}

/** Meshes of the given bodies at `resolution` (display names applied). */
export async function meshesFor(
  bodyIds: readonly string[],
  resolution: MeshResolution,
): Promise<NamedMesh[]> {
  const state = useAssemblerStore.getState();
  const named = withDisplayNames(state.evaluation.bodies, useItemsStore.getState());
  const nameOf = new Map(named.map((b) => [b.id, b.name]));
  if (resolution === 'current') {
    return named
      .filter((b) => bodyIds.includes(b.id))
      .map((b) => ({ id: b.id, name: b.name, mesh: b.mesh }));
  }
  if (!kernel) throw new Error('The CAD kernel is not available.');
  const preset = MESH_RESOLUTIONS[resolution];
  const bodies = await kernel.exportMesh(shownFeatures(state), {
    bodyIds,
    tolerance: preset.tolerance,
    angularTolerance: preset.angularTolerance,
  });
  return bodies.map((b) => ({ id: b.id, name: nameOf.get(b.id) ?? b.name, mesh: b.mesh }));
}

/** Triangle count per body for the options (the export preview). */
export async function previewTriangleCounts(
  options: StlExportOptions,
): Promise<{ id: string; name: string; triangles: number }[]> {
  const ids = stlBodyIds(options.scope);
  if (ids.length === 0) return [];
  const meshes = await meshesFor(ids, options.resolution);
  return meshes.map((m) => ({ id: m.id, name: m.name, triangles: m.mesh.indices.length / 3 }));
}

/** Estimated STL size in bytes. */
export function estimateStlBytes(triangles: number, format: StlFormat, solids = 1): number {
  // ASCII: ~260 bytes per facet with 7-digit exponent numbers.
  return format === 'binary' ? 84 + triangles * 50 : triangles * 262 + solids * 40;
}

/** Runs the STL export: one merged file, or one file per body (`each`). Returns the files written. */
export async function exportStl(options: StlExportOptions): Promise<number> {
  const ids = stlBodyIds(options.scope);
  if (ids.length === 0) throw new Error('No bodies to export.');
  const meshes = await meshesFor(ids, options.resolution);
  const project = useAssemblerStore.getState().projectName;
  const filters = [{ name: 'STL', extensions: ['stl'] }];
  if (options.scope === 'each') {
    let written = 0;
    for (const mesh of meshes) {
      const result = await io.exportBinary(
        stlBytes([mesh], options.format),
        `${sanitizeFileName(mesh.name)}.stl`,
        filters,
        'model/stl',
      );
      if (!result) break; // the user cancelled: stop asking for the remaining bodies
      written += 1;
    }
    return written;
  }
  const name = meshes.length === 1 ? meshes[0]!.name : project;
  const result = await io.exportBinary(
    stlBytes(meshes, options.format),
    `${sanitizeFileName(name)}.stl`,
    filters,
    'model/stl',
  );
  return result ? 1 : 0;
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
  const api = typeof window !== 'undefined' ? window.assembler?.slicers : undefined;
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
