import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import '@himmelcad/theme/fonts.css';
import '@himmelcad/theme/tokens.css';
import '@himmelcad/theme/reset.css';
import './assembler.css';

import { App } from './App.js';
import { WorkerKernelAdapter } from './kernel/workerAdapter.js';
import { useAssemblerStore } from './model/store.js';

declare global {
  interface Window {
    /**
     * Dev-only automation hook for screen-recording orchestration. Never
     * present in production builds — guarded by `import.meta.env.DEV`.
     */
    __assembler?: { store: typeof useAssemblerStore };
  }
}

if (import.meta.env.DEV) {
  window.__assembler = { store: useAssemblerStore };
}

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
