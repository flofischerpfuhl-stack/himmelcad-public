import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  root: 'renderer',
  base: './',
  plugins: [react()],
  server: {
    port: 5175,
    strictPort: true,
    host: true,
  },
  // The CAD kernel worker is an ES module worker (see renderer/src/kernel/kernel.worker.ts).
  worker: {
    format: 'es',
  },
  build: {
    outDir: '../dist/renderer',
    emptyOutDir: true,
    sourcemap: true,
    // replicad/OCCT glue is large by nature; the ~23 MB .wasm is a separate asset.
    chunkSizeWarningLimit: 2048,
  },
});
