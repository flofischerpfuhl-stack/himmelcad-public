import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  root: 'renderer',
  base: './',
  publicDir: fileURLToPath(new URL('../../.build/builder-viewer/public', import.meta.url)),
  plugins: [react()],
  resolve: {
    alias: {
      '@himmelcad/app': fileURLToPath(
        new URL('../../packages/@himmelcad/app/src/index.ts', import.meta.url),
      ),
    },
  },
  server: {
    port: 5174,
    strictPort: true,
  },
  build: {
    outDir: '../dist/renderer',
    emptyOutDir: true,
    sourcemap: true,
  },
});
