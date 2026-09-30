/**
 * Kernel-side composition of the desktop product (assembler/MODULES.md §3):
 * the kind registrations and evaluators of every module that owns feature
 * kinds. Loaded by the kernel worker (`kernel.worker.ts`), the headless CLI
 * and the tests, before the first evaluation.
 */
import '../foundation/sketch-solver/sketchFeature.js';
import '../kernel/features/modelingKernel.js';
import '../modules/construction/kernel.js';
