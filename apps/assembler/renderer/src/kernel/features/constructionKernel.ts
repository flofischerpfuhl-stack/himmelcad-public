/**
 * Kernel part of the construction module: evaluators of the construction
 * planes and axes (`construction.ts` in this folder), registered with the
 * evaluator's per-kind registry. Loaded by the kernel-worker composition
 * (`renderer/src/app/kernelModules.ts`).
 */
import { defineKernelModule } from '../../foundation/geometry-kernel/features/registry.js';
import '../../modules/construction/kinds.js';
import { applyConstructionAxis, applyConstructionPlane } from './construction.js';

export const constructionKernel = defineKernelModule({
  id: 'construction',
  featureEvaluators: {
    constructionPlane: applyConstructionPlane,
    constructionAxis: applyConstructionAxis,
  },
});
