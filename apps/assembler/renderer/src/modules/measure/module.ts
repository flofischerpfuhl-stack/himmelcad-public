/**
 * The measure module (assembler/MODULES.md): Measure mode, pinned
 * measurements, panel, overlay and measure API. Phase B moves its files
 * from `model/`, `chrome/`, `viewport/` and `api/` here.
 */
import { COMMAND_ORDER } from '../../foundation/commands/registry.js';
import { defineAssemblerModule } from '../../foundation/commands/module.js';
import { MEASURE_COMMANDS } from '../../model/commands/measureCommands.js';

export const measureModule = defineAssemblerModule({
  id: 'measure',
  commands: [{ order: COMMAND_ORDER.measure, commands: MEASURE_COMMANDS }],
});
