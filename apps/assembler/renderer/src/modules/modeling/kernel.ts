/**
 * Kernel part of the modelling module: the evaluators of the kinds declared
 * in `features.ts` and `printFeatures.ts` (`kernel/`), registered with the
 * evaluator's per-kind registry (`foundation/geometry-kernel/features/registry.ts`).
 * Loaded by the kernel-worker composition (`renderer/src/app/kernelModules.ts`).
 * OCCT only through `FeatureKit` and the kernel's exports (`occtApi.ts`).
 */
import { defineKernelModule } from '../../foundation/geometry-kernel/features/registry.js';
import './kinds.js';
import {
  applyAlign,
  applyMirror,
  applyPattern,
  applyRotateAxis,
  applySplit,
  applyTransform,
} from './kernel/bodyOps.js';
import { applyDraft } from './kernel/draft.js';
import { applyEmboss } from './kernel/emboss.js';
import { applyHole } from './kernel/holes.js';
import { applyLoft, applyRevolve, applySweep } from './kernel/profileSolids.js';
import { applyRib, applyThicken } from './kernel/ribThicken.js';

export const modelingKernel = defineKernelModule({
  id: 'modeling',
  featureEvaluators: {
    revolve: applyRevolve,
    sweep: applySweep,
    loft: applyLoft,
    mirror: applyMirror,
    pattern: applyPattern,
    split: applySplit,
    transform: applyTransform,
    rotateAxis: applyRotateAxis,
    align: applyAlign,
    hole: applyHole,
    emboss: applyEmboss,
    draft: applyDraft,
    rib: applyRib,
    thicken: applyThicken,
  },
});
