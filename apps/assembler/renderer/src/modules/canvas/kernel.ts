/**
 * Kernel part of the canvas module: a reference image is no geometry, so
 * its evaluator adds nothing (the step evaluates, can be suppressed and
 * reordered like any other). The kind (`kinds.ts`) is loaded with it so the
 * kernel validates the same documents as the main thread. Loaded by the
 * kernel composition (`renderer/src/app/kernelModules.ts`).
 */
import { defineKernelModule } from '../../foundation/geometry-kernel/features/registry.js';
import './kinds.js';

export const canvasKernel = defineKernelModule({
  id: 'canvas',
  featureEvaluators: {
    // A picture on a plane: shown by the viewport (module UI), nothing to build.
    referenceImage: () => undefined,
  },
});
