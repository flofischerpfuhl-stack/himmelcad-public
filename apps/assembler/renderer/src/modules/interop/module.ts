/**
 * The interop module (assembler/MODULES.md): import/export UI and parsers,
 * reference meshes, mesh to solid, interop API. Phase B moves its files
 * from `interop/`, `model/referenceMesh.ts`, `kernel/` and `api/` here.
 */
import { COMMAND_ORDER } from '../../foundation/commands/registry.js';
import { defineAssemblerModule } from '../../foundation/commands/module.js';
import { FILE_INTEROP_COMMANDS, INTEROP_COMMANDS } from '../../interop/interopCommands.js';

export const interopModule = defineAssemblerModule({
  id: 'interop',
  commands: [
    { order: COMMAND_ORDER.fileInterop, commands: FILE_INTEROP_COMMANDS },
    { order: COMMAND_ORDER.interop, commands: INTEROP_COMMANDS },
  ],
});
