/**
 * Kernel part of the construction module: the kinds (`kinds.ts`) and the
 * evaluators of construction planes and axes (`evaluators.ts`), registered
 * with the evaluator's per-kind registry. Loaded by the kernel-worker
 * composition (`renderer/src/app/kernelModules.ts`).
 */
import { defineKernelModule } from '../../foundation/geometry-kernel/features/registry.js';
import './kinds.js';
import { applyConstructionAxis, applyConstructionPlane } from './evaluators.js';

export const constructionKernel = defineKernelModule({
  id: 'construction',
  featureEvaluators: {
    constructionPlane: applyConstructionPlane,
    constructionAxis: applyConstructionAxis,
  },
});
