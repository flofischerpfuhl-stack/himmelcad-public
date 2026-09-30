/// <reference lib="webworker" />
/**
 * Entry of the CAD kernel Web Worker: the module kernel parts first, then
 * the worker runtime (`foundation/geometry-kernel/workerRuntime.ts`), which
 * loads OCCT and answers the main thread. The file name is load-bearing:
 * the production CSP (`electron/main.ts`) and the dev server
 * (`vite.config.ts`) recognise the worker by `kernel.worker`.
 */
import './kernelModules.js';
import '../foundation/geometry-kernel/workerRuntime.js';
