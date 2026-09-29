import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import '@himmelcad/theme/fonts.css';
import '@himmelcad/theme/tokens.css';
import '@himmelcad/theme/reset.css';
import './assembler.css';

import { App } from './App.js';
import { installPreferenceEffects } from './chrome/preferenceEffects.js';
import { installAutomationBridge } from './api/app/automationStore.js';
import { installAutomationHook } from './devtools/automationHook.js';
import { WorkerKernelAdapter } from './kernel/workerAdapter.js';
import { useProjectStore } from './model/project/projectStore.js';
import { useAssemblerStore } from './model/store.js';
import { setPrintKernel } from './print/exporting.js';
import { setAgentPrintRunner, setPrintRunner } from './print/printStore.js';
import { PrintabilityRunner } from './print/runner.js';
import { setSketchSolverFactory } from './sketch/solverProvider.js';
import { WorkerSketchSolver } from './sketch/workerSolver.js';

// Dev-only automation hook for screen recordings (`window.__assembler`, see
// `devtools/automationHook.ts`). Never present in production builds.
if (import.meta.env.DEV) installAutomationHook(useAssemblerStore);

// Theme and grid defaults from the user's preferences (Settings dialog).
installPreferenceEffects();

// OCCT (WebAssembly) runs in its own worker; the UI stays responsive while it loads.
const kernelAdapter = new WorkerKernelAdapter(
  () => new Worker(new URL('./kernel/kernel.worker.ts', import.meta.url), { type: 'module' }),
);
useAssemblerStore.getState().attachKernel(kernelAdapter);
// Project export (STEP) shares the same adapter instance, see `model/project/projectStore.ts`.
useProjectStore.getState().attachKernelAdapter(kernelAdapter);
// Agent access (desktop only, off until the user enables it): canonical command layer on this document.
installAutomationBridge(kernelAdapter);
// Print mode: printability analysis/orientation in their own worker; export re-tessellation on the kernel.
const printWorker = () =>
  new Worker(new URL('./print/printability.worker.ts', import.meta.url), { type: 'module' });
setPrintRunner(new PrintabilityRunner(printWorker));
setAgentPrintRunner(new PrintabilityRunner(printWorker));
setPrintKernel(kernelAdapter);
// The sketch solver (planeGCS, WebAssembly) gets its own worker, started on first use.
setSketchSolverFactory(
  () =>
    new WorkerSketchSolver(
      () => new Worker(new URL('./sketch/solver.worker.ts', import.meta.url), { type: 'module' }),
    ),
);

const rootEl = document.getElementById('hc-root');
if (!rootEl) throw new Error('Missing #hc-root mount point');

createRoot(rootEl).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
