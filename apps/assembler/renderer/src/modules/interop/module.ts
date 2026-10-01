/**
 * The interop module (assembler/MODULES.md): import/export of STEP, IGES,
 * DXF, STL, 3MF and OBJ, reference meshes, mesh to solid, the interop API.
 * Everything it adds is registered here and in `module.ui.ts`:
 *
 * - commands: `interopCommands.ts` (File › Import…/Export STEP…/IGES…/DXF…,
 *   Convert Mesh to Solid);
 * - agent API: `interopApi.ts` (the import/export handlers);
 * - runtime: file parsing in the import worker (jobs module's single-job
 *   worker, Cancel = terminate), STEP/IGES export on the kernel, and the
 *   Items folders of imported STEP assemblies.
 *
 * The mesh exports of the File menu (STL, 3MF) are `meshExports.ts`.
 */
import { COMMAND_ORDER } from '../../foundation/commands/registry.js';
import { defineAssemblerModule } from '../../foundation/commands/module.js';
import { useAssemblerStore } from '../../foundation/commands/store.js';
import { installAssemblyFolderSync } from './importFolders.js';
import { ImportRunner, setImportRunner } from './importRunner.js';
import { INTEROP_API } from './interopApi.js';
import { FILE_INTEROP_COMMANDS, INTEROP_COMMANDS } from './interopCommands.js';
import { setInteropKernel } from './interopStore.js';

export const interopModule = defineAssemblerModule({
  id: 'interop',
  commands: [
    { order: COMMAND_ORDER.fileInterop, commands: FILE_INTEROP_COMMANDS },
    { order: COMMAND_ORDER.interop, commands: INTEROP_COMMANDS },
  ],
  api: INTEROP_API,
  install: (host) => {
    // File parsing in its own worker (Cancel = terminate); STEP/IGES export on the kernel;
    // imported STEP assemblies are filed into Items folders when their parts appear.
    if (host.workers) {
      setImportRunner(
        new ImportRunner(
          () => new Worker(new URL('./import.worker.ts', import.meta.url), { type: 'module' }),
        ),
      );
    }
    setInteropKernel(host.kernel);
    installAssemblyFolderSync(useAssemblerStore);
  },
});
