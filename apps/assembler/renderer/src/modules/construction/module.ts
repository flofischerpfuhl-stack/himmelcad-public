/**
 * The construction module (assembler/MODULES.md): construction planes and
 * axes. Its kinds are still registered with the modelling kinds
 * (`model/modelingKinds.ts`), its evaluators from
 * `kernel/features/constructionKernel.ts`; phase B moves them here.
 */
import { COMMAND_ORDER } from '../../foundation/commands/registry.js';
import { defineAssemblerModule } from '../../foundation/commands/module.js';
import { CONSTRUCT_COMMANDS } from '../../model/commands/constructCommands.js';

export const constructionModule = defineAssemblerModule({
  id: 'construction',
  commands: [{ order: COMMAND_ORDER.construct, commands: CONSTRUCT_COMMANDS }],
});
