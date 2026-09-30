/**
 * The print module (assembler/MODULES.md): printability analysis,
 * orientation and placement, print exports, Print mode panel and overlays,
 * print API. The reference for moving a module: everything it adds is
 * registered here and in `module.ui.ts`; no central file names it.
 *
 * - commands: `printCommands.ts` (Print mode, Place on Plate, Auto Orient,
 *   Export STL…);
 * - agent API: `api.ts` (`print.*`, `export.meshStats`, `PrintSettings`);
 * - runtime: the printability worker (jobs module's single-job worker) for
 *   the UI and for agent queries, and the kernel for re-tessellated exports.
 */
import { COMMAND_ORDER } from '../../foundation/commands/registry.js';
import { defineAssemblerModule } from '../../foundation/commands/module.js';
import { PRINT_API } from './api.js';
import { setPrintKernel } from './exporting.js';
import { PRINT_COMMANDS } from './printCommands.js';
import { setAgentPrintRunner, setPrintRunner } from './printStore.js';
import { PrintabilityRunner } from './runner.js';

export const printModule = defineAssemblerModule({
  id: 'print',
  commands: [{ order: COMMAND_ORDER.print, commands: PRINT_COMMANDS }],
  api: PRINT_API,
  install: (host) => {
    // Analysis and orientation in their own worker (one for the UI, one for agent queries);
    // export re-tessellation on the kernel.
    if (host.workers) {
      const printWorker = () =>
        new Worker(new URL('./printability.worker.ts', import.meta.url), { type: 'module' });
      setPrintRunner(new PrintabilityRunner(printWorker));
      setAgentPrintRunner(new PrintabilityRunner(printWorker));
    }
    setPrintKernel(host.kernel);
  },
});
