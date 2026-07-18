import { createRoot } from 'react-dom/client';

import '@himmelcad/theme/fonts.css';
import '@himmelcad/theme/tokens.css';
import '@himmelcad/theme/reset.css';

import { App } from './App.js';

const rootEl = document.getElementById('hc-root');
if (!rootEl) throw new Error('Missing #hc-root mount point');

// The viewport owns a native GPU device. React's development-only StrictMode
// effect replay would create two devices concurrently before the first async
// initialization can observe its abort signal.
createRoot(rootEl).render(<App />);
