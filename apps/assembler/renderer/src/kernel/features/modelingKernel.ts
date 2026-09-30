/**
 * Kernel part of the modelling module: the evaluators of the kinds declared
 * in `model/features.ts` and `model/printFeatures.ts`, registered with the
 * evaluator's per-kind registry (`foundation/geometry-kernel/features/registry.ts`).
 * Loaded by the kernel-worker composition (`renderer/src/app/kernelModules.ts`).
 *
 * Offset Face and Delete Face still evaluate in
 * `foundation/geometry-kernel/features/faceOps.ts` (shared with the core
 * shell/push-pull code) until the direct-edit module takes them over.
 */
import {
  applyDeleteFace,
  applyOffsetFace,
} from '../../foundation/geometry-kernel/features/faceOps.js';
import { defineKernelModule } from '../../foundation/geometry-kernel/features/registry.js';
import '../../model/modelingKinds.js';
import {
  applyAlign,
  applyMirror,
  applyPattern,
  applyRotateAxis,
  applySplit,
  applyTransform,
} from './bodyOps.js';
import { applyDraft } from './draft.js';
import { applyEmboss } from './emboss.js';
import { applyHole } from './holes.js';
import { applyLoft, applyRevolve, applySweep } from './profileSolids.js';
import { applyRib, applyThicken } from './ribThicken.js';

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
    offsetFace: applyOffsetFace,
    deleteFace: applyDeleteFace,
    hole: applyHole,
    emboss: applyEmboss,
    draft: applyDraft,
    rib: applyRib,
    thicken: applyThicken,
  },
});
