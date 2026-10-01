/**
 * The parameters module (assembler/MODULES.md): document parameters
 * ("variables") edited as one undo step each — the store slice with the
 * planner (`slice.ts`, `parameterEdits.ts`) and the agent-API methods
 * (`api.ts`). The Parameters panel is its UI part (`module.ui.ts`). The
 * parameter list and the expression rules are document foundation
 * (`foundation/document/parameters.ts`).
 */
import { defineAssemblerModule } from '../../foundation/commands/module.js';
import { PARAMETERS_API } from './api.js';
import { createParametersSlice } from './slice.js';

export const parametersModule = defineAssemblerModule({
  id: 'parameters',
  api: PARAMETERS_API,
  storeSlice: createParametersSlice,
});
