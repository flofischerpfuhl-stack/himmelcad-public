/**
 * The sketching module (assembler/MODULES.md): sketch mode (`session.ts`),
 * drawing tools and inference, sketch commands (`sketchCommands.ts`), the
 * sketch agent API (`api.ts`); its UI part (chrome, overlay, History card,
 * viewport mode) is `module.ui.tsx`. The sketch kind and the solver are
 * foundation (`foundation/sketch-solver`).
 */
import { COMMAND_ORDER, setModalSessionProbe } from '../../foundation/commands/registry.js';
import { defineAssemblerModule } from '../../foundation/commands/module.js';
import { SKETCH_COMMANDS } from './sketchCommands.js';
import { useSketchStore } from './session.js';

export const sketchingModule = defineAssemblerModule({
  id: 'sketching',
  commands: [{ order: COMMAND_ORDER.sketch, commands: SKETCH_COMMANDS }],
  // An open sketch owns the keyboard and the selection: no pick sessions meanwhile.
  onInstall: () => setModalSessionProbe(() => useSketchStore.getState().session !== null),
});
