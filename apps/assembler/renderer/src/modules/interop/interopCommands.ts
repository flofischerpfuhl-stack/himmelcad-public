/**
 * Registry commands of the import/export features (File menu, command
 * search, context menu and adaptive toolbar for a selected reference
 * mesh). Spread into `COMMANDS` by `model/commands/registry.ts`.
 */
import {
  alwaysEnabled,
  kernelNotReady,
  type Command,
  type CommandAvailability,
  type CommandContext,
} from '../../foundation/commands/registry.js';
import { dxfExportTarget, kernelFormatCapabilities, useInteropStore } from './interopStore.js';

const IGES_REASON =
  'IGES is not in this build: the CAD kernel (replicad-opencascadejs 1.1.0) has no IGES reader or writer.';

/** IGES needs the HimmelCAD OCCT build; known once the kernel is ready. */
function igesAvailability(ctx: CommandContext, side: 'read' | 'write'): CommandAvailability {
  const blocked = kernelBlocked(ctx);
  if (blocked) return blocked;
  const caps = kernelFormatCapabilities();
  return (side === 'read' ? caps?.igesRead : caps?.igesWrite)
    ? { enabled: true }
    : { enabled: false, reason: IGES_REASON };
}

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
    availability: (ctx) => igesAvailability(ctx, 'read'),
    run: () => void useInteropStore.getState().openImport('iges'),
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
    availability: (ctx) => {
      const iges = igesAvailability(ctx, 'write');
      if (!iges.enabled) return iges;
      return ctx.evaluation.bodies.length > 0
        ? iges
        : { enabled: false, reason: 'There are no bodies to export.' };
    },
    run: () => useInteropStore.getState().setIgesExportOpen(true),
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

/** File › Export STEP…, Import STEP…, Import STL… (moved out of the command registry unchanged). */
export const FILE_INTEROP_COMMANDS: readonly Command[] = [
  {
    id: 'file.exportStep',
    label: 'Export STEP…',
    group: 'file',
    keywords: ['export', 'step', 'cad', 'assembly', 'ap214', 'ap242'],
    requiresKernel: true,
    availability: (ctx) => {
      const notReady = kernelNotReady(ctx);
      if (notReady) return notReady;
      return ctx.evaluation.bodies.length > 0
        ? alwaysEnabled
        : { enabled: false, reason: 'No bodies to export.' };
    },
    // Options dialog (assembly/flat/per body, AP214/AP242, units, visible only): `interop/`.
    run: () => useInteropStore.getState().setStepExportOpen(true),
  },
  {
    id: 'file.importStep',
    label: 'Import STEP…',
    group: 'file',
    keywords: ['import', 'step', 'cad', 'assembly'],
    requiresKernel: true,
    availability: (ctx) => kernelNotReady(ctx) ?? alwaysEnabled,
    // Keeps the product structure (Items folders, names, colours): `interop/interopStore.ts`.
    run: () => void useInteropStore.getState().openImport('step'),
  },
  {
    id: 'file.importStl',
    label: 'Import STL…',
    group: 'file',
    keywords: ['import', 'stl', 'mesh', 'scan', 'reference'],
    // Never a kernel input (`apps/assembler/README.md` "STL import"): the
    // reference mesh is stored and rendered outside OCCT entirely, so this
    // works even while the kernel is still loading or unavailable.
    availability: () => alwaysEnabled,
    run: () => void useInteropStore.getState().openImport('stl'),
  },
];
