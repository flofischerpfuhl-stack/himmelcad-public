/**
 * 3D-printing commands (registered into `registry.ts`'s `COMMANDS`): the
 * Printability mode (`P`), Place on Plate, Auto Orient, Export STL… and
 * Open in Slicer / Slicers…. Same availability for the toolbar, command
 * search, context menu and keyboard.
 */
import type { Command, CommandAvailability, CommandContext } from '../model/commands/registry.js';
import { referenceMeshIdOf } from '../model/referenceMesh.js';
import { isPlanarFace } from '../model/store.js';
import { useWorkspaceStore } from '../model/workspace.js';
import { usePrintStore } from './printStore.js';
import { useSlicerStore } from './slicerStore.js';

const enabled: CommandAvailability = { enabled: true };

function kernelReason(ctx: CommandContext): CommandAvailability | null {
  if (ctx.kernelStatus === 'ready') return null;
  return {
    enabled: false,
    reason:
      ctx.kernelStatus === 'error'
        ? 'The CAD kernel failed to load.'
        : 'The CAD kernel is still loading.',
  };
}

/** The single selected planar face of a modelled body, or `null`. */
function selectedFlatFace(ctx: CommandContext): { bodyId: string; faceKey: string } | null {
  if (ctx.selection.length !== 1) return null;
  const item = ctx.selection[0]!;
  if (item.kind !== 'face' || referenceMeshIdOf(item.bodyId) !== null) return null;
  return isPlanarFace(ctx.evaluation, item.bodyId, item.faceKey) ? item : null;
}

/** The single selected modelled body, or `null`. */
function selectedBody(ctx: CommandContext): string | null {
  if (ctx.selection.length !== 1) return null;
  const item = ctx.selection[0]!;
  if (item.kind !== 'body' || referenceMeshIdOf(item.bodyId) !== null) return null;
  return item.bodyId;
}

function notBusy(ctx: CommandContext): CommandAvailability | null {
  return ctx.activeTool
    ? { enabled: false, reason: 'Finish or cancel the active tool first.' }
    : null;
}

export const PRINT_COMMANDS: readonly Command[] = [
  {
    id: 'modes.print',
    label: 'Printability',
    group: 'modes',
    shortcut: 'P',
    keywords: [
      'print',
      '3d print',
      'overhang',
      'wall thickness',
      'support',
      'analysis',
      'material',
    ],
    availability: () => ({ enabled: true, recommended: usePrintStore.getState().enabled }),
    run: () => {
      const print = usePrintStore.getState();
      print.setEnabled(!print.enabled);
    },
  },
  {
    id: 'print.placeOnPlate',
    label: 'Place on Plate',
    group: 'transform',
    keywords: ['print', 'lay flat', 'build plate', 'orient', 'face down', 'bed'],
    requiresKernel: true,
    availability: (ctx) => {
      const problem = kernelReason(ctx) ?? notBusy(ctx);
      if (problem) return problem;
      if (selectedFlatFace(ctx)) return { enabled: true, recommended: true, priority: 20 };
      if (selectedBody(ctx)) return { enabled: true, priority: 5 };
      return {
        enabled: false,
        reason: 'Select the flat face to lay on the plate (or a body, then click its face).',
      };
    },
    run: (ctx) => {
      const face = selectedFlatFace(ctx);
      const print = usePrintStore.getState();
      if (face) {
        const problem = print.placeOnPlate(face.bodyId, face.faceKey);
        if (problem) useWorkspaceStore.getState().notify(problem, 'warning');
        return;
      }
      const body = selectedBody(ctx);
      if (body) print.startPlacePicking(body);
    },
  },
  {
    id: 'print.autoOrient',
    label: 'Auto Orient for Print',
    group: 'transform',
    keywords: ['print', 'orientation', 'minimize overhang', 'support', 'build plate'],
    requiresKernel: true,
    availability: (ctx) => {
      const problem = kernelReason(ctx) ?? notBusy(ctx);
      if (problem) return problem;
      return selectedBody(ctx)
        ? { enabled: true, priority: 4 }
        : { enabled: false, reason: 'Select one body to orient.' };
    },
    run: (ctx) => {
      const body = selectedBody(ctx);
      if (body) usePrintStore.getState().startAutoOrient(body);
    },
  },
  {
    id: 'file.exportStlOptions',
    label: 'Export STL…',
    group: 'file',
    keywords: ['export', 'print', 'stl', 'ascii', 'binary', 'resolution', 'triangles'],
    adaptive: false,
    availability: (ctx) =>
      ctx.evaluation.bodies.length > 0
        ? enabled
        : { enabled: false, reason: 'No bodies to export.' },
    run: () => usePrintStore.getState().setStlDialogOpen(true),
  },
  {
    id: 'file.openInSlicer',
    label: 'Open in Slicer',
    group: 'file',
    keywords: ['print', 'slicer', 'bambu', 'orca', 'prusa', 'cura', '3mf', 'send'],
    adaptive: false,
    availability: (ctx) =>
      ctx.evaluation.bodies.length > 0
        ? enabled
        : { enabled: false, reason: 'No bodies to print.' },
    run: () => {
      const slicers = useSlicerStore.getState();
      if (!slicers.available) {
        void slicers.open();
        return;
      }
      void slicers.refresh().then(() => {
        const current = useSlicerStore.getState();
        if (current.defaultId) void current.open();
        else usePrintStore.getState().setSlicerDialogOpen(true);
      });
    },
  },
  {
    id: 'file.slicers',
    label: 'Slicers…',
    group: 'file',
    keywords: ['print', 'slicer', 'settings', 'bambu', 'orca', 'prusa', 'cura'],
    adaptive: false,
    availability: () => enabled,
    run: () => usePrintStore.getState().setSlicerDialogOpen(true),
  },
];
