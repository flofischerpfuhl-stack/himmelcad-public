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
import { setSketchSolverFactory } from './sketch/solverProvider.js';
import { setFontLoader } from './sketch/text/fonts.js';
import { WorkerSketchSolver } from './sketch/workerSolver.js';
// Sketch text font (Inter, SIL OFL 1.1 — LICENSES/THIRD_PARTY.md), bundled as an asset.
import interWoffUrl from '@fontsource/inter/files/inter-latin-400-normal.woff?url';

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
// The sketch solver (planeGCS, WebAssembly) gets its own worker, started on first use.
setSketchSolverFactory(
  () =>
    new WorkerSketchSolver(
      () => new Worker(new URL('./sketch/solver.worker.ts', import.meta.url), { type: 'module' }),
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
