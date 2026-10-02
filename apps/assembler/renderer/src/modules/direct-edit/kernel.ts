/**
 * Kernel part of the direct-edit module: the Offset Face and Delete Face
 * evaluators (`faceEdits.ts`) and Move Edge / Move Face (`moveEdits.ts`),
 * registered with the evaluator's per-kind registry
 * (`foundation/geometry-kernel/features/registry.ts`). Loaded by the
 * kernel-worker composition (`renderer/src/app/kernelModules.ts`).
 */
import { defineKernelModule } from '../../foundation/geometry-kernel/features/registry.js';
import { applyDeleteFace, applyOffsetFace } from './faceEdits.js';
import { applyMoveEdge, applyMoveFace } from './moveEdits.js';
import { applyReplaceFace } from './replaceFace.js';
// The kinds' definitions, as in the main thread (modeling and construction do the same).
import './kinds.js';

export const directEditKernel = defineKernelModule({
  id: 'direct-edit',
  featureEvaluators: {
    offsetFace: applyOffsetFace,
    deleteFace: applyDeleteFace,
    moveEdge: applyMoveEdge,
    moveFace: applyMoveFace,
    replaceFace: applyReplaceFace,
  },
});
