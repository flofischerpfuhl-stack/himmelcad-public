import { createReadStream, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import react from '@vitejs/plugin-react';
import { defineConfig, type Plugin } from 'vite';

import { resolveHimmelcadOcct, selectedOcctModule } from './headless/occtModule.ts';

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

function kernelWorkerCsp(): Plugin {
  return {
    name: 'assembler-kernel-worker-csp',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const url = req.url ?? '';
        // The sketch-solver worker and its planeGCS embind glue (`new Function`) need the same.
        if (
          /kernel\.worker|replicad[-_]opencascadejs|replicad_single|himmelcad_occt|solver\.worker|planegcs/i.test(
            url,
          )
        ) {
          res.setHeader('Content-Security-Policy', WORKER_CSP);
        }
        next();
      });
    },
  };
}

// OCCT module selection (`headless/occtModule.ts`, shared with the headless
// CLI and tests): `HIMMELCAD_OCCT=himmelcad` swaps `replicad-opencascadejs`
// (glue + wasm) for the HimmelCAD build from the local artifact cache
// (`HIMMELCAD_OCCT_DIR`, else `<cache>/<version>`), SHA-256-checked against
// `vendor/occt-wasm/artifacts.sha256`; missing or wrong files fail the build.
const occtSelection = (() => {
  if (selectedOcctModule() !== 'himmelcad') return null;
  const resolved = resolveHimmelcadOcct();
  const posix = resolved.dir.split(path.sep).join('/');
  return {
    dir: resolved.dir,
    aliases: [
      {
        find: /^replicad-opencascadejs\/wasm(\?url)?$/,
        replacement: `${posix}/himmelcad_occt.wasm$1`,
      },
      { find: /^replicad-opencascadejs$/, replacement: `${posix}/himmelcad_occt.js` },
    ],
  };
})();
// Dev only: Vite's raw `/@fs/` middleware serves from the root of the current
// drive on Windows, so the `.wasm` in a cache directory on another drive
// (fetched raw by the kernel worker) would fall through to `index.html`. Serve
// it from the verified cache directory directly.
function occtCacheFiles(): Plugin {
  return {
    name: 'assembler-occt-cache-files',
    configureServer(server) {
      if (!occtSelection) return;
      const root = path.resolve(occtSelection.dir);
      server.middlewares.use((req, res, next) => {
        // Plain requests only: `…wasm?import&url` is the JS module Vite generates for the import.
        const url = req.url ?? '';
        if (!url.startsWith('/@fs/') || url.includes('?')) {
          next();
          return;
        }
        const file = path.resolve(decodeURIComponent(url.slice('/@fs/'.length)));
        // Only the raw `.wasm`; the glue `.js` goes through Vite's transform as usual.
        if (path.dirname(file) !== root || !file.endsWith('.wasm') || !existsSync(file)) {
          next();
          return;
        }
        res.setHeader('Content-Type', 'application/wasm');
        createReadStream(file).pipe(res);
      });
    },
  };
}

export default defineConfig({
  root: 'renderer',
  base: './',
  plugins: [react(), kernelWorkerCsp(), occtCacheFiles()],
  resolve: { alias: occtSelection?.aliases ?? [] },
  server: {
    port: 5175,
    strictPort: true,
    host: true,
    // The HimmelCAD OCCT build lives in the artifact cache, outside the workspace.
    ...(occtSelection
      ? { fs: { allow: [fileURLToPath(new URL('../..', import.meta.url)), occtSelection.dir] } }
      : {}),
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
