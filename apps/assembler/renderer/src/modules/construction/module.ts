/**
 * The construction module (assembler/MODULES.md): construction planes and
 * axes. Its kinds register from `kinds.ts`, its Construct tools from
 * `drafts.ts`, its evaluators from `kernel/features/constructionKernel.ts`.
 */
import { COMMAND_ORDER } from '../../foundation/commands/registry.js';
import { defineAssemblerModule } from '../../foundation/commands/module.js';
import { CONSTRUCT_COMMANDS } from '../../model/commands/constructCommands.js';
import './drafts.js';
import './kinds.js';

export const constructionModule = defineAssemblerModule({
  id: 'construction',
  commands: [{ order: COMMAND_ORDER.construct, commands: CONSTRUCT_COMMANDS }],
});
