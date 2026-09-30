/**
 * Preload of the kernel-only entries (`bench:kernel`): the kernel-side
 * composition exactly as the kernel worker loads it (`app/kernel.worker.ts`),
 * without the main-thread modules, so the bench measures what the worker
 * runs. Everything else preloads `setup.ts`.
 */
import '../renderer/src/app/kernelModules.js';
