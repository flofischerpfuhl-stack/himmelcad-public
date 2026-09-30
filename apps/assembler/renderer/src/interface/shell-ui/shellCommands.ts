/**
 * Commands of the shell: the view presets and File (Home, New, Open,
 * Save, Save As, STL/3MF export through the project lifecycle). Registered
 * through the shell-ui module (`module.ts`) into the command registry;
 * moved out of the registry unchanged.
 */
import {
  alwaysEnabled,
  selected,
  type Command,
  type CommandAvailability,
  type CommandContext,
} from '../../foundation/commands/registry.js';
import { export3mf, exportStlAll, exportStlBody } from '../../modules/interop/meshExports.js';
import { useProjectStore } from './project/projectStore.js';
import { useWorkspaceStore } from './workspace.js';

/** Camera presets and Zoom to fit. */
export const VIEW_COMMANDS: readonly Command[] = [
  ...(
    [
      ['view.front', 'Front', 'front', 'Ctrl+2'],
      ['view.back', 'Back', 'back', 'Ctrl+3'],
      ['view.top', 'Top', 'top', 'Ctrl+4'],
      ['view.bottom', 'Bottom', 'bottom', 'Ctrl+5'],
      ['view.right', 'Right', 'right', 'Ctrl+6'],
      ['view.left', 'Left', 'left', 'Ctrl+7'],
      ['view.iso', 'Iso (reset)', 'iso', 'Ctrl+1'],
    ] as const
  ).map(([id, label, preset, shortcut]) => ({
    id,
    label,
    group: 'view' as const,
    shortcut,
    keywords: ['view', 'camera', preset, ...(preset === 'iso' ? ['home', 'reset'] : [])],
    availability: (): CommandAvailability => alwaysEnabled,
    run: (ctx: CommandContext) => {
      // Ctrl+1 is Shapr3D's "Reset": the isometric home view, fitted.
      if (preset === 'iso') useWorkspaceStore.getState().sendCamera({ kind: 'home' });
      else ctx.requestCamera(preset);
    },
  })),
  {
    id: 'view.zoomToFit',
    label: 'Zoom to fit',
    group: 'view',
    keywords: ['view', 'camera', 'frame all'],
    availability: () => alwaysEnabled,
    run: (ctx) => ctx.requestCamera('fit'),
  },
];

/** File menu: project lifecycle and the mesh exports it writes. */
export const FILE_COMMANDS: readonly Command[] = [
  {
    id: 'file.home',
    label: 'Home',
    group: 'file',
    shortcut: 'Ctrl+Shift+H',
    keywords: ['start', 'dashboard', 'recent', 'templates', 'welcome', 'projects'],
    adaptive: false,
    availability: () => alwaysEnabled,
    run: () => {
      const workspace = useWorkspaceStore.getState();
      workspace.setHomeOpen(!workspace.homeOpen);
    },
  },
  {
    id: 'file.new',
    label: 'New',
    group: 'file',
    shortcut: 'Ctrl+N',
    keywords: ['project', 'blank'],
    availability: () => alwaysEnabled,
    run: () => useProjectStore.getState().requestNew(),
  },
  {
    id: 'file.open',
    label: 'Open…',
    group: 'file',
    shortcut: 'Ctrl+O',
    keywords: ['project', 'load'],
    availability: () => alwaysEnabled,
    run: () => useProjectStore.getState().requestOpen(),
  },
  {
    id: 'file.save',
    label: 'Save',
    group: 'file',
    shortcut: 'Ctrl+S',
    keywords: ['project', 'persist'],
    availability: () => alwaysEnabled,
    run: () => void useProjectStore.getState().save(),
  },
  {
    id: 'file.saveAs',
    label: 'Save As…',
    group: 'file',
    // Ctrl+Shift+S is Select Through (Shapr3D mapping).
    shortcut: 'Ctrl+Shift+Alt+S',
    keywords: ['project', 'persist', 'copy'],
    availability: () => alwaysEnabled,
    run: () => void useProjectStore.getState().saveAs(),
  },
  {
    id: 'file.exportStlAll',
    label: 'Export STL (All Bodies)',
    group: 'file',
    keywords: ['export', 'print', 'stl'],
    availability: (ctx) =>
      ctx.evaluation.bodies.length > 0
        ? alwaysEnabled
        : { enabled: false, reason: 'No bodies to export.' },
    run: () => void useProjectStore.getState().runBusy('Exporting STL…', exportStlAll),
  },
  {
    id: 'file.exportStlBody',
    label: 'Export STL (Selected Body)',
    group: 'file',
    keywords: ['export', 'print', 'stl', 'body'],
    availability: (ctx) => {
      const bodies = selected(ctx, 'body');
      return bodies.length === 1 && ctx.selection.length === 1
        ? alwaysEnabled
        : { enabled: false, reason: 'Select exactly one body.' };
    },
    run: (ctx) => {
      const bodies = selected(ctx, 'body');
      const bodyId = bodies.length === 1 ? bodies[0]!.bodyId : null;
      if (bodyId)
        void useProjectStore.getState().runBusy('Exporting STL…', () => exportStlBody(bodyId));
    },
  },
  {
    id: 'file.export3mf',
    label: 'Export 3MF',
    group: 'file',
    keywords: ['export', 'print', '3mf'],
    availability: (ctx) =>
      ctx.evaluation.bodies.length > 0
        ? alwaysEnabled
        : { enabled: false, reason: 'No bodies to export.' },
    run: () => void useProjectStore.getState().runBusy('Exporting 3MF…', export3mf),
  },
];
