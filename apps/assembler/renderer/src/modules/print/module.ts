/**
 * The print module (assembler/MODULES.md): printability analysis,
 * orientation, placement, print exports, Print mode panel and overlays,
 * print API.
 */
import { COMMAND_ORDER } from '../../foundation/commands/registry.js';
import { defineAssemblerModule } from '../../foundation/commands/module.js';
import { PRINT_COMMANDS } from '../../print/printCommands.js';

export const printModule = defineAssemblerModule({
  id: 'print',
  commands: [{ order: COMMAND_ORDER.print, commands: PRINT_COMMANDS }],
});
