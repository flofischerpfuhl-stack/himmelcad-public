import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import '@himmelcad/theme/fonts.css';
import '@himmelcad/theme/tokens.css';
import '@himmelcad/theme/reset.css';

import { App } from './App.js';

const rootEl = document.getElementById('hc-root');
if (!rootEl) throw new Error('Missing #hc-root mount point');

document.documentElement.classList.add('hc-theme-dark');

createRoot(rootEl).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
