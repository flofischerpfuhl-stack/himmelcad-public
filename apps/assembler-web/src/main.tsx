/**
 * HimmelCAD Assembler for the browser: the web product's composition root.
 * Same modules, shell and workers as the desktop renderer
 * (`apps/assembler/renderer/src/main.tsx`); what differs is the platform
 * host (`host/webHost.ts`), the service worker (offline, updates), the
 * `beforeunload` guard and the web chrome. See assembler/WEB.md.
 */
// Must stay the first import: the host is read when the stores are created.
import './installHost.js';

import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import '@himmelcad/theme/fonts.css';
import '@himmelcad/theme/tokens.css';
import '@himmelcad/theme/reset.css';
import '../../assembler/renderer/src/assembler.css';
import './web.css';

import { ASSEMBLER_MODULES } from '../../assembler/renderer/src/app/composition.js';
import '../../assembler/renderer/src/app/uiComposition.js';
import { startModules } from '../../assembler/renderer/src/foundation/commands/module.js';
import { useAssemblerStore } from '../../assembler/renderer/src/foundation/commands/store.js';
import { projectPersistence } from '../../assembler/renderer/src/foundation/document/projectPersistence.js';
import { WorkerKernelAdapter } from '../../assembler/renderer/src/foundation/geometry-kernel/workerAdapter.js';
import { setSketchSolverFactory } from '../../assembler/renderer/src/foundation/sketch-solver/solverProvider.js';
import { setFontLoader } from '../../assembler/renderer/src/foundation/sketch-solver/text/fonts.js';
import { WorkerSketchSolver } from '../../assembler/renderer/src/foundation/sketch-solver/workerSolver.js';
import { installAutomationBridge } from '../../assembler/renderer/src/interface/agent-api/automationStore.js';
import { App } from '../../assembler/renderer/src/interface/shell-ui/App.js';
import { installPreferenceEffects } from '../../assembler/renderer/src/interface/shell-ui/preferenceEffects.js';
import {
  startWithBlankDocument,
  useProjectStore,
} from '../../assembler/renderer/src/interface/shell-ui/project/projectStore.js';
// Sketch text font (Inter, SIL OFL 1.1 — LICENSES/THIRD_PARTY.md), bundled as an asset.
import interWoffUrl from '@fontsource/inter/files/inter-latin-400-normal.woff?url';

import { WebChrome } from './pwa/WebChrome.js';
import { registerServiceWorker, requestPersistentStorage } from './pwa/serviceWorker.js';

installPreferenceEffects();

// A blank project until the user opens or creates one (Home, a launched file, recovery).
startWithBlankDocument();

// Phone-sized windows: the floating Items and History panels would cover the whole model, so
// they start closed there (the docks reopen them). The shell has no phone layout yet.
if (window.matchMedia('(max-width: 699px)').matches) {
  const store = useAssemblerStore.getState();
  store.setPanelVisible('items', false);
  store.setPanelVisible('history', false);
}

// OCCT (WebAssembly) in its own worker. The worker file keeps its desktop
// name: `kernel.worker-<hash>.js` is what the worker CSP is scoped to.
const kernelAdapter = new WorkerKernelAdapter(
  () =>
    new Worker(new URL('../../assembler/renderer/src/app/kernel.worker.ts', import.meta.url), {
      type: 'module',
    }),
);
useAssemblerStore.getState().attachKernel(kernelAdapter);
useProjectStore.getState().attachKernelAdapter(kernelAdapter);
// Agent access: the in-page API (`host/inPageAgent.ts`), off until the user turns it on.
installAutomationBridge(kernelAdapter);
startModules(ASSEMBLER_MODULES, { kernel: kernelAdapter, workers: true });
setSketchSolverFactory(
  () =>
    new WorkerSketchSolver(
      () =>
        new Worker(
          new URL(
            '../../assembler/renderer/src/foundation/sketch-solver/solver.worker.ts',
            import.meta.url,
          ),
          { type: 'module' },
        ),
    ),
);
setFontLoader(async (font) => {
  if (font.file !== 'inter-latin-400-normal.woff')
    throw new Error(`Font ${font.id} is not bundled`);
  const response = await fetch(interWoffUrl);
  if (!response.ok) throw new Error(`Font ${font.label} could not be loaded (${response.status})`);
  return response.arrayBuffer();
});

// Leaving the page with unsaved work: the browser's own prompt (it cannot be
// replaced by an in-app dialog). The recovery copy is kept regardless.
window.addEventListener('beforeunload', (event) => {
  if (!projectPersistence()?.hasUnsavedChanges()) return;
  event.preventDefault();
  event.returnValue = '';
});

// The service worker is registered once the kernel has loaded: its precache then finds the
// 25 MB OCCT module (content-hashed, immutable) in the HTTP cache instead of downloading it a
// second time while the page's own download is still running.
if (import.meta.env.PROD) {
  let registered = false;
  const register = () => {
    if (registered) return;
    registered = true;
    unsubscribe();
    registerServiceWorker();
  };
  const unsubscribe = useAssemblerStore.subscribe((state) => {
    if (state.kernelStatus !== 'loading') register();
  });
  if (useAssemblerStore.getState().kernelStatus !== 'loading') register();
  // A kernel that never settles must not keep the app from installing.
  setTimeout(register, 60_000);
}
requestPersistentStorage();

const rootEl = document.getElementById('hc-root');
if (!rootEl) throw new Error('Missing #hc-root mount point');

createRoot(rootEl).render(
  <StrictMode>
    <App />
    <WebChrome />
  </StrictMode>,
);
