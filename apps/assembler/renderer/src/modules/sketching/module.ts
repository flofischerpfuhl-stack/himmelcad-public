/**
 * The sketching module (assembler/MODULES.md): sketch mode, drawing tools,
 * sketch commands, overlay and chrome, sketch agent API. Phase B moves its
 * files from `renderer/src/sketch/` into this folder.
 */
import { COMMAND_ORDER, setModalSessionProbe } from '../../foundation/commands/registry.js';
import { defineAssemblerModule } from '../../foundation/commands/module.js';
import { SKETCH_COMMANDS } from '../../model/commands/sketchCommands.js';
import { useSketchStore } from '../../sketch/session.js';

export const sketchingModule = defineAssemblerModule({
  id: 'sketching',
  commands: [{ order: COMMAND_ORDER.sketch, commands: SKETCH_COMMANDS }],
  // An open sketch owns the keyboard and the selection: no pick sessions meanwhile.
  onInstall: () => setModalSessionProbe(() => useSketchStore.getState().session !== null),
});
