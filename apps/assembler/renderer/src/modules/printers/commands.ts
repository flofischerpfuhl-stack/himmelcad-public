/**
 * The slicer commands (File › Open in Slicer, Slicers…), registered by the
 * printers module right after the print commands (`COMMAND_ORDER.printers`).
 * Moved from the print module unchanged; the dialog's open state lives in the
 * slicer store now.
 */
import type { Command, CommandAvailability } from '../../foundation/commands/registry.js';
import { useSlicerStore } from './slicerStore.js';

const enabled: CommandAvailability = { enabled: true };

export const SLICER_COMMANDS: readonly Command[] = [
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
        else useSlicerStore.getState().setDialogOpen(true);
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
    run: () => useSlicerStore.getState().setDialogOpen(true),
  },
];
