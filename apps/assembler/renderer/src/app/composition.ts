/**
 * The module composition of HimmelCAD Assembler (assembler/MODULES.md §3):
 * everything a module registers that runs without a UI — feature kinds,
 * commands, agent-API methods, store slices. Imported first by the desktop
 * renderer (`main.tsx`), the headless CLI (`headless/cli.ts`) and the test
 * setup (`test/setup.ts`).
 */
import '../foundation/sketch-solver/sketchFeature.js';
import '../model/modelingKinds.js';
