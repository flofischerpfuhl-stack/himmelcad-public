/**
 * The modelling module (assembler/MODULES.md): solid features, their tools,
 * History cards, handles and API schemas. Its kinds register from
 * `model/modelingKinds.ts`, its evaluators from
 * `kernel/features/modelingKernel.ts`; phase B moves those files here.
 */
import { COMMAND_ORDER } from '../../foundation/commands/registry.js';
import { defineAssemblerModule } from '../../foundation/commands/module.js';
import { BLEND_RULE_COMMANDS } from '../../model/commands/blendCommands.js';
import { FEATURE_COMMANDS } from '../../model/commands/featureCommands.js';
import {
  BOOLEAN_COMMANDS,
  MODELING_TOOL_COMMANDS,
  TRANSFORM_COMMANDS,
} from '../../model/commands/modelingCommands.js';
import '../../model/modelingKinds.js';

export const modelingModule = defineAssemblerModule({
  id: 'modeling',
  commands: [
    { order: COMMAND_ORDER.modelingTools, commands: MODELING_TOOL_COMMANDS },
    { order: COMMAND_ORDER.blendRules, commands: BLEND_RULE_COMMANDS },
    { order: COMMAND_ORDER.modelingFeatures, commands: FEATURE_COMMANDS },
    { order: COMMAND_ORDER.booleans, commands: BOOLEAN_COMMANDS },
    { order: COMMAND_ORDER.transform, commands: TRANSFORM_COMMANDS },
  ],
});
