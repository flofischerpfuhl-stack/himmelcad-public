import { createRoot } from 'react-dom/client';

import '@himmelcad/theme/fonts.css';
import '@himmelcad/theme/tokens.css';
import '@himmelcad/theme/reset.css';

import { Gallery } from './Gallery.js';
import './gallery.css';

const root = document.getElementById('hc-root');
if (!root) throw new Error('Missing #hc-root mount point');

createRoot(root).render(<Gallery />);
