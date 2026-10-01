/**
 * The direct-edit module (assembler/MODULES.md): Offset Face (value modes),
 * Delete Face, and Move Face / Move Edge (started from Move/Rotate on a
 * face or an edge).
 *
 * - kinds: `kinds.ts` (types, `.hcasm` validation, labels);
 * - evaluators: `kernel.ts` / `faceEdits.ts` (kernel-worker composition);
 * - tools: `drafts.ts` (drafts of the generic feature tool);
 * - commands: `commands.ts`;
 * - agent API: `api.ts` (the kinds' `feature.create` parameter schemas);
 * - UI: `module.ui.tsx` (History card, icons).
 */
import { COMMAND_ORDER } from '../../foundation/commands/registry.js';
import { defineAssemblerModule } from '../../foundation/commands/module.js';
import { DIRECT_EDIT_API } from './api.js';
import { DIRECT_EDIT_COMMANDS } from './commands.js';
import {
  DELETE_FACE_DRAFT_TOOL,
  MOVE_EDGE_DRAFT_TOOL,
  MOVE_FACE_DRAFT_TOOL,
  OFFSET_FACE_DRAFT_TOOL,
} from './drafts.js';
import './kinds.js';

export const directEditModule = defineAssemblerModule({
  id: 'direct-edit',
  commands: [{ order: COMMAND_ORDER.directEdit, commands: DIRECT_EDIT_COMMANDS }],
  api: DIRECT_EDIT_API,
  draftTools: [
    OFFSET_FACE_DRAFT_TOOL,
    DELETE_FACE_DRAFT_TOOL,
    MOVE_EDGE_DRAFT_TOOL,
    MOVE_FACE_DRAFT_TOOL,
  ],
});
