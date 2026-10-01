/**
 * The printers module (assembler/MODULES.md): the slicers — the renderer's
 * view of registered slicers (`slicerStore.ts`), the 3MF hand-off
 * (`handoff.ts`), the Slicers… dialog (`module.ui.ts`) and the File
 * commands; the desktop side is `electron/slicerIpc.ts` and
 * `electron/slicerPaths.ts`. Later: printer profiles, build volumes, direct
 * send (with their own safety rules).
 */
import { COMMAND_ORDER } from '../../foundation/commands/registry.js';
import { defineAssemblerModule } from '../../foundation/commands/module.js';
import { SLICER_COMMANDS } from './commands.js';

export const printersModule = defineAssemblerModule({
  id: 'printers',
  commands: [{ order: COMMAND_ORDER.printers, commands: SLICER_COMMANDS }],
});
