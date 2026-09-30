/**
 * Registry commands of the import/export features (File menu, command
 * search, context menu and adaptive toolbar for a selected reference
 * mesh). Spread into `COMMANDS` by `model/commands/registry.ts`.
 */
import type { Command, CommandAvailability, CommandContext } from '../model/commands/registry.js';
import { dxfExportTarget, useInteropStore } from './interopStore.js';

const IGES_REASON =
  'IGES is not in this build: the CAD kernel (replicad-opencascadejs 1.1.0) has no IGES reader or writer.';

function kernelBlocked(ctx: CommandContext): CommandAvailability | null {
  if (ctx.kernelStatus === 'ready') return null;
  return {
    enabled: false,
    reason:
      ctx.kernelStatus === 'error'
        ? 'The CAD kernel failed to load.'
        : 'The CAD kernel is still loading.',
  };
}

function selectedMesh(ctx: CommandContext): string | null {
  const meshes = ctx.selection.filter((s) => s.kind === 'mesh');
  return meshes.length === 1 && ctx.selection.length === 1 && meshes[0]!.kind === 'mesh'
    ? meshes[0]!.meshId
    : null;
}

export const INTEROP_COMMANDS: readonly Command[] = [
  {
    id: 'file.import',
    label: 'Import…',
    group: 'file',
    keywords: [
      'import',
      'open',
      'step',
      'stp',
      'stl',
      '3mf',
      'obj',
      'dxf',
      'mesh',
      'cad',
      'drag',
      'drop',
    ],
    adaptive: false,
    availability: () => ({ enabled: true }),
    run: () => void useInteropStore.getState().openImport(),
  },
  {
    id: 'file.importDxf',
    label: 'Import DXF into Sketch…',
    group: 'file',
    keywords: ['import', 'dxf', 'dwg', 'drawing', 'sketch', '2d', 'outline', 'laser'],
    adaptive: false,
    availability: () => ({ enabled: true }),
    run: () => void useInteropStore.getState().openImport('dxf'),
  },
  {
    id: 'file.importIges',
    label: 'Import IGES…',
    group: 'file',
    keywords: ['import', 'iges', 'igs', 'cad'],
    adaptive: false,
    availability: () => ({ enabled: false, reason: IGES_REASON }),
    run: () => undefined,
  },
  {
    id: 'file.exportDxf',
    label: 'Export DXF…',
    group: 'file',
    keywords: ['export', 'dxf', 'drawing', 'sketch', 'face', 'outline', 'laser', 'cnc', '2d'],
    availability: (ctx) =>
      ctx.selection.length > 0 && dxfExportTarget()
        ? { enabled: true }
        : { enabled: false, reason: 'Select a sketch or a planar face.' },
    run: () => useInteropStore.getState().setDxfExportOpen(true),
  },
  {
    id: 'file.exportIges',
    label: 'Export IGES…',
    group: 'file',
    keywords: ['export', 'iges', 'igs'],
    adaptive: false,
    availability: () => ({ enabled: false, reason: IGES_REASON }),
    run: () => undefined,
  },
  {
    id: 'tools.meshToSolid',
    label: 'Convert Mesh to Solid',
    group: 'tools',
    keywords: ['mesh', 'solid', 'brep', 'b-rep', 'stl', 'convert', 'solidify', 'reference'],
    requiresKernel: true,
    availability: (ctx) => {
      const blocked = kernelBlocked(ctx);
      if (blocked) return blocked;
      return selectedMesh(ctx)
        ? { enabled: true, recommended: true, priority: 40 }
        : { enabled: false, reason: 'Select one reference mesh (an imported STL, 3MF or OBJ).' };
    },
    run: (ctx) => {
      const meshId = selectedMesh(ctx);
      if (meshId) void useInteropStore.getState().convertMeshToSolid(meshId);
    },
  },
];
