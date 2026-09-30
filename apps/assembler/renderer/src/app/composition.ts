/**
 * The module composition of HimmelCAD Assembler (assembler/MODULES.md §3):
 * every module and what it registers that runs without a UI — feature
 * kinds, commands, agent-API methods, store slices. Imported first by the
 * desktop renderer (`main.tsx`), the headless CLI (`headless/cli.ts`) and
 * the test setup (`test/setup.ts`). Order is irrelevant for registrations
 * that carry an `order`; it is the order `startModules` wires runtimes in.
 */
import '../foundation/sketch-solver/sketchFeature.js';
import { installModules, type AssemblerModule } from '../foundation/commands/module.js';
import { agentApiModule } from '../interface/agent-api/module.js';
import { shellUiModule } from '../interface/shell-ui/module.js';
import { constructionModule } from '../modules/construction/module.js';
import { directEditModule } from '../modules/direct-edit/module.js';
import { displayModule } from '../modules/display/module.js';
import { interopModule } from '../modules/interop/module.js';
import { measureModule } from '../modules/measure/module.js';
import { modelingModule } from '../modules/modeling/module.js';
import { printModule } from '../modules/print/module.js';
import { printersModule } from '../modules/printers/module.js';
import { sketchingModule } from '../modules/sketching/module.js';
import { templatesModule } from '../modules/templates/module.js';

/** The desktop product's modules (domain modules, then the interface modules). */
export const ASSEMBLER_MODULES: readonly AssemblerModule[] = [
  sketchingModule,
  modelingModule,
  directEditModule,
  constructionModule,
  measureModule,
  displayModule,
  interopModule,
  templatesModule,
  printModule,
  printersModule,
  agentApiModule,
  shellUiModule,
];

installModules(ASSEMBLER_MODULES);
