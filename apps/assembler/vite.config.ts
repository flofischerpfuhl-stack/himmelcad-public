import react from '@vitejs/plugin-react';
import { defineConfig, type Plugin } from 'vite';

// Dev mirror of `electron/main.ts`'s per-file CSP: the main document (its
// `<meta>` CSP in `index.html`) stays strict — no `unsafe-eval`, no
// `wasm-unsafe-eval`, since the main thread never evals or instantiates
// wasm. Only the CAD kernel Web Worker
// (`renderer/src/kernel/kernel.worker.ts`) and the LGPL Emscripten glue it
// dynamically imports (`replicad-opencascadejs`, package file
// `replicad_single.js`) need `'unsafe-eval'`, because that glue calls
// `eval`/`new Function` beyond plain `WebAssembly.instantiate`. A response
// header CSP on a worker script's own request overrides — is not
// intersected with — the owning document's `<meta>` CSP (same rule
// production relies on for `app://`-served workers), so setting this header
// only for those two requests keeps the document strict while letting the
// worker load.
const WORKER_CSP =
  "default-src 'self'; script-src 'self' 'unsafe-eval' 'wasm-unsafe-eval'; worker-src 'self'; " +
  "style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; " +
  "connect-src 'self' ws: http://localhost:5175;";

// The sketch solver worker (planeGCS) instantiates WebAssembly but never evals.
const SOLVER_CSP =
  "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; worker-src 'self'; " +
  "style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; " +
  "connect-src 'self' ws: http://localhost:5175;";

function kernelWorkerCsp(): Plugin {
  return {
    name: 'assembler-kernel-worker-csp',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const url = req.url ?? '';
        if (/kernel\.worker|replicad[-_]opencascadejs|replicad_single/i.test(url)) {
          res.setHeader('Content-Security-Policy', WORKER_CSP);
        } else if (/solver\.worker|planegcs/i.test(url)) {
          res.setHeader('Content-Security-Policy', SOLVER_CSP);
        }
        next();
      });
    },
  };
}

export default defineConfig({
  root: 'renderer',
  base: './',
  plugins: [react(), kernelWorkerCsp()],
  server: {
    port: 5175,
    strictPort: true,
    host: true,
  },
  // The CAD kernel worker is an ES module worker (see renderer/src/kernel/kernel.worker.ts).
  worker: {
    format: 'es',
    rollupOptions: {
      output: {
        // The LGPL planeGCS glue + wrapper stay one separately replaceable
        // chunk (`planegcs-<hash>.js`, next to `planegcs-<hash>.wasm`).
        manualChunks: (id: string) =>
          id.includes('@salusoft89/planegcs') ? 'planegcs' : undefined,
      },
    },
  },
  build: {
    outDir: '../dist/renderer',
    emptyOutDir: true,
    sourcemap: true,
    // replicad/OCCT glue is large by nature; the ~23 MB .wasm is a separate asset.
    chunkSizeWarningLimit: 2048,
  },
});
