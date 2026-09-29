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
  build: {
    outDir: '../dist/renderer',
    emptyOutDir: true,
    sourcemap: true,
  },
});
