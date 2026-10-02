/**
 * The display module (assembler/MODULES.md): appearance and colour,
 * display modes, section and visibility commands, the analysis legend,
 * image export and the view display saved with a project. Registered here
 * and in `module.ui.ts`.
 */
import { COMMAND_ORDER } from '../../foundation/commands/registry.js';
import { defineAssemblerModule } from '../../foundation/commands/module.js';
import { DISPLAY_COMMANDS, SECTION_COMMANDS, VISIBILITY_COMMANDS } from './displayCommands.js';
import { DISPLAY_PROJECT_SECTION } from './projectFile.js';
import { VIEW_API } from './viewApi.js';

export const displayModule = defineAssemblerModule({
  id: 'display',
  // `view.render` / `view.inspect`: renders for agents (GPU in the app, software headless).
  api: VIEW_API,
  commands: [
    { order: COMMAND_ORDER.display, commands: DISPLAY_COMMANDS },
    { order: COMMAND_ORDER.section, commands: SECTION_COMMANDS },
    { order: COMMAND_ORDER.visibility, commands: VISIBILITY_COMMANDS },
  ],
  fileFormatFields: [DISPLAY_PROJECT_SECTION],
});
