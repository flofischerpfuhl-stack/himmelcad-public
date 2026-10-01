/**
 * The modelling module (assembler/MODULES.md): solid features, their tools,
 * History cards, handles and API schemas. Its kinds register from
 * `kinds.ts`, its evaluators from `kernel.ts` (kernel-worker composition).
 */
import { COMMAND_ORDER } from '../../foundation/commands/registry.js';
import { defineAssemblerModule } from '../../foundation/commands/module.js';
import { MODELING_API } from './api.js';
import { BLEND_RULE_COMMANDS } from './blendCommands.js';
import {
  MODELING_DRAFT_TOOL,
  PRIMITIVE_DRAFT_TOOL,
  PRINT_DRAFT_TOOL,
  SCALE_DRAFT_TOOL,
  TRANSLATE_DRAFT_TOOL,
} from './drafts.js';
import { FEATURE_COMMANDS, PROFILE_FEATURE_COMMANDS } from './featureCommands.js';
import {
  BOOLEAN_COMMANDS,
  MODELING_TOOL_COMMANDS,
  PRIMITIVE_COMMANDS,
  TRANSFORM_COMMANDS,
} from './modelingCommands.js';
import './kinds.js';
import { modelingToolsSlice } from './tools.js';

export const modelingModule = defineAssemblerModule({
  id: 'modeling',
  commands: [
    { order: COMMAND_ORDER.modelingTools, commands: MODELING_TOOL_COMMANDS },
    { order: COMMAND_ORDER.blendRules, commands: BLEND_RULE_COMMANDS },
    { order: COMMAND_ORDER.modelingFeatures, commands: PROFILE_FEATURE_COMMANDS },
    { order: COMMAND_ORDER.modelingFeaturesTail, commands: FEATURE_COMMANDS },
    { order: COMMAND_ORDER.primitives, commands: PRIMITIVE_COMMANDS },
    { order: COMMAND_ORDER.booleans, commands: BOOLEAN_COMMANDS },
    { order: COMMAND_ORDER.transform, commands: TRANSFORM_COMMANDS },
  ],
  api: MODELING_API,
  draftTools: [
    MODELING_DRAFT_TOOL,
    PRINT_DRAFT_TOOL,
    SCALE_DRAFT_TOOL,
    TRANSLATE_DRAFT_TOOL,
    PRIMITIVE_DRAFT_TOOL,
  ],
  storeSlice: modelingToolsSlice,
});
