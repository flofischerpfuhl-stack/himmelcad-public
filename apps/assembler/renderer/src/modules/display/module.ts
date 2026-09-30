/**
 * The display module (assembler/MODULES.md): appearance, display modes,
 * section and visibility commands, analysis legend, image export. Phase B
 * moves its files from `model/`, `chrome/` and `viewport/` here.
 */
import { COMMAND_ORDER } from '../../foundation/commands/registry.js';
import { defineAssemblerModule } from '../../foundation/commands/module.js';
import {
  DISPLAY_COMMANDS,
  SECTION_COMMANDS,
  VISIBILITY_COMMANDS,
} from '../../model/commands/displayCommands.js';

export const displayModule = defineAssemblerModule({
  id: 'display',
  commands: [
    { order: COMMAND_ORDER.display, commands: DISPLAY_COMMANDS },
    { order: COMMAND_ORDER.section, commands: SECTION_COMMANDS },
    { order: COMMAND_ORDER.visibility, commands: VISIBILITY_COMMANDS },
  ],
});
