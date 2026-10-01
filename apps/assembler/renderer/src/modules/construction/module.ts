/**
 * The construction module (assembler/MODULES.md): construction planes and
 * axes. Everything it adds is registered here and in `module.ui.tsx`:
 *
 * - kinds: `kinds.ts` (`constructionPlane`, `constructionAxis`: type,
 *   label, `.hcasm` validator); evaluators in `kernel.ts`;
 * - the Construct tool: `constructionTools.ts` as a draft tool of the
 *   generic feature tool (`foundation/commands/draftTools.ts`);
 * - commands: the Construct menu and Section at Plane (`constructCommands.ts`);
 * - agent API: `datums.list` (`api.ts`).
 *
 * Other modules read construction planes/axes as document references
 * (`PlaneRef`/`AxisRef` `construction`) resolved by
 * `foundation/geometry-kernel/datums.ts`, never through this module.
 */
import { COMMAND_ORDER } from '../../foundation/commands/registry.js';
import { defineAssemblerModule } from '../../foundation/commands/module.js';
import './kinds.js';
import { CONSTRUCTION_API } from './api.js';
import { CONSTRUCT_COMMANDS } from './constructCommands.js';
import { CONSTRUCTION_DRAFT_TOOL } from './constructionTools.js';

export const constructionModule = defineAssemblerModule({
  id: 'construction',
  commands: [{ order: COMMAND_ORDER.construct, commands: CONSTRUCT_COMMANDS }],
  draftTools: [CONSTRUCTION_DRAFT_TOOL],
  api: CONSTRUCTION_API,
});
