import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import '@himmelcad/theme/fonts.css';
import '@himmelcad/theme/tokens.css';
import '@himmelcad/theme/reset.css';
import './assembler.css';

import './app/composition.js';
import './app/uiComposition.js';
import { App } from './interface/shell-ui/App.js';
import { installPreferenceEffects } from './interface/shell-ui/preferenceEffects.js';
import { installAutomationBridge } from './interface/agent-api/automationStore.js';
import { installAutomationHook } from './app/devtools/automationHook.js';
import { installAssemblyFolderSync } from './interop/importFolders.js';
import { ImportRunner, setImportRunner } from './interop/importRunner.js';
import { setInteropKernel } from './interop/interopStore.js';
import { WorkerKernelAdapter } from './foundation/geometry-kernel/workerAdapter.js';
import { useMeasureStore } from './model/measureStore.js';
import { useProjectStore } from './interface/shell-ui/project/projectStore.js';
import { useAssemblerStore } from './foundation/commands/store.js';
import { setPrintKernel } from './print/exporting.js';
import { setAgentPrintRunner, setPrintRunner } from './print/printStore.js';
import { PrintabilityRunner } from './print/runner.js';
import { setSketchSolverFactory } from './foundation/sketch-solver/solverProvider.js';
import { setFontLoader } from './foundation/sketch-solver/text/fonts.js';
import { WorkerSketchSolver } from './foundation/sketch-solver/workerSolver.js';
// Sketch text font (Inter, SIL OFL 1.1 — LICENSES/THIRD_PARTY.md), bundled as an asset.
import interWoffUrl from '@fontsource/inter/files/inter-latin-400-normal.woff?url';

// Dev-only automation hook for screen recordings (`window.__assembler`, see
// `devtools/automationHook.ts`). Never present in production builds.
if (import.meta.env.DEV) installAutomationHook(useAssemblerStore);

// Theme and grid defaults from the user's preferences (Settings dialog).
installPreferenceEffects();

// OCCT (WebAssembly) runs in its own worker; the UI stays responsive while it loads.
const kernelAdapter = new WorkerKernelAdapter(
  () =>
    new Worker(new URL('./app/kernel.worker.ts', import.meta.url), {
      type: 'module',
    }),
);
useAssemblerStore.getState().attachKernel(kernelAdapter);
// Project export (STEP) shares the same adapter instance, see `model/project/projectStore.ts`.
useProjectStore.getState().attachKernelAdapter(kernelAdapter);
// Measure panel: exact minimum distances (`BRepExtrema`) from the same kernel.
useMeasureStore.getState().attachKernel(kernelAdapter);
// Agent access (desktop only, off until the user enables it): canonical command layer on this document.
installAutomationBridge(kernelAdapter);
// Print mode: printability analysis/orientation in their own worker; export re-tessellation on the kernel.
const printWorker = () =>
  new Worker(new URL('./print/printability.worker.ts', import.meta.url), { type: 'module' });
setPrintRunner(new PrintabilityRunner(printWorker));
setAgentPrintRunner(new PrintabilityRunner(printWorker));
setPrintKernel(kernelAdapter);
// Import/export: file parsing in its own worker (Cancel = terminate); STEP export on the kernel;
// imported STEP assemblies are filed into Items folders when their parts appear.
setImportRunner(
  new ImportRunner(
    () => new Worker(new URL('./interop/import.worker.ts', import.meta.url), { type: 'module' }),
  ),
);
setInteropKernel(kernelAdapter);
installAssemblyFolderSync(useAssemblerStore);
// The sketch solver (planeGCS, WebAssembly) gets its own worker, started on first use.
setSketchSolverFactory(
  () =>
    new WorkerSketchSolver(
      () =>
        new Worker(new URL('./foundation/sketch-solver/solver.worker.ts', import.meta.url), {
          type: 'module',
        }),
    ),
);

// Sketch text: the font is fetched and parsed when the Text tool is first used.
setFontLoader(async (font) => {
  if (font.file !== 'inter-latin-400-normal.woff')
    throw new Error(`Font ${font.id} is not bundled`);
  const response = await fetch(interWoffUrl);
  if (!response.ok) throw new Error(`Font ${font.label} could not be loaded (${response.status})`);
  return response.arrayBuffer();
});

const rootEl = document.getElementById('hc-root');
if (!rootEl) throw new Error('Missing #hc-root mount point');

createRoot(rootEl).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
