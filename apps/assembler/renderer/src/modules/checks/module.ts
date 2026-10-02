/**
 * The checks module (assembler/CHECKS.md, MODULES.md): stored requirements
 * of the document — evaluated in the background after every rebuild — with
 * the Checks panel, a passive status badge, the `checks.*` API and the
 * `checks` file field. The check kinds come from the modules that own the
 * measurement (measure, print; `checkKinds`); this module owns only the
 * whole-document kind (body count) and runs whatever is registered.
 *
 * - commands: `commands.ts` (Checks panel, Add check…, Run checks now);
 * - agent API: `api.ts` (`checks.kinds/list/add/update/remove/run`);
 * - project file: `projectFile.ts` (`checks`, optional, additive);
 * - store slice: `checksStore.ts` (panel open);
 * - runtime: `runner.ts` (background evaluation, started by `install`);
 * - document-checks hook: `documentRunner.ts` (registered in `onInstall`; the parameter
 *   sweep runs the stored checks on each sample through it).
 */
import { registerDocumentCheckRunner } from '../../foundation/commands/documentChecks.js';
import { COMMAND_ORDER } from '../../foundation/commands/registry.js';
import { defineAssemblerModule } from '../../foundation/commands/module.js';
import { CHECKS_API } from './api.js';
import { createChecksSlice } from './checksStore.js';
import { CHECKS_COMMANDS } from './commands.js';
import { CHECKS_DOCUMENT_RUNNER } from './documentRunner.js';
import { CHECKS_CHECK_KINDS } from './kinds.js';
import { CHECKS_PROJECT_SECTION } from './projectFile.js';
import { startChecksRunner } from './runner.js';

export const checksModule = defineAssemblerModule({
  id: 'checks',
  commands: [{ order: COMMAND_ORDER.checks, commands: CHECKS_COMMANDS }],
  api: CHECKS_API,
  storeSlice: createChecksSlice,
  fileFormatFields: [CHECKS_PROJECT_SECTION],
  checkKinds: CHECKS_CHECK_KINDS,
  // Other modules (the parameter sweep) run the stored checks on their own states through the hook.
  onInstall: () => registerDocumentCheckRunner(CHECKS_DOCUMENT_RUNNER),
  install: (host) => {
    // Background evaluation after rebuilds (kernel checks in the kernel worker, print checks
    // in the print module's worker): never on the edit's critical path.
    startChecksRunner(host.kernel);
  },
});
