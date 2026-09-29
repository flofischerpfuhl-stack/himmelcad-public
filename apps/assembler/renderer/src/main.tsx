import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import '@himmelcad/theme/fonts.css';
import '@himmelcad/theme/tokens.css';
import '@himmelcad/theme/reset.css';
import './assembler.css';

import { App } from './App.js';
import { installAutomationHook } from './devtools/automationHook.js';
import { WorkerKernelAdapter } from './kernel/workerAdapter.js';
import { useAssemblerStore } from './model/store.js';

// Dev-only automation hook for screen recordings (`window.__assembler`, see
// `devtools/automationHook.ts`). Never present in production builds.
if (import.meta.env.DEV) installAutomationHook(useAssemblerStore);

// OCCT (WebAssembly) runs in its own worker; the UI stays responsive while it loads.
useAssemblerStore
  .getState()
  .attachKernel(
    new WorkerKernelAdapter(
      () => new Worker(new URL('./kernel/kernel.worker.ts', import.meta.url), { type: 'module' }),
    ),
  );

const rootEl = document.getElementById('hc-root');
if (!rootEl) throw new Error('Missing #hc-root mount point');

createRoot(rootEl).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
