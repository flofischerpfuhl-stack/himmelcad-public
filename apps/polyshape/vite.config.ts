import { resolve } from 'node:path';

import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  root: 'renderer',
  base: './',
  plugins: [react()],
  resolve: {
    alias: {
      '@himmelcad/ui': resolve(__dirname, '../../packages/@himmelcad/ui/src/index.ts'),
      '@himmelcad/viewer': resolve(__dirname, '../../packages/@himmelcad/viewer/src/index.ts'),
      '@himmelcad/data': resolve(__dirname, '../../packages/@himmelcad/data/src/index.ts'),
      '@himmelcad/theme': resolve(__dirname, '../../packages/@himmelcad/theme/src/index.ts'),
      '@himmelcad/console': resolve(__dirname, '../../packages/@himmelcad/console/src/index.ts'),
    },
  },
  server: {
    port: 5173,
    strictPort: true,
  },
  build: {
    outDir: '../dist/renderer',
    emptyOutDir: true,
    sourcemap: true,
  },
});
