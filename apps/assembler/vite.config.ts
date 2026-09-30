import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

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

// OCCT module selection (same variable as `headless/occtModule.ts`):
// `HIMMELCAD_OCCT=himmelcad` swaps `replicad-opencascadejs` (glue + wasm) for
// the HimmelCAD build in `vendor/occt-wasm/dist` — same loader contract, more
// OCCT classes. Default: the npm package.
function occtModuleAliases(): { find: RegExp; replacement: string }[] {
  const selected = (process.env.HIMMELCAD_OCCT ?? '').trim().toLowerCase();
  if (selected === '' || selected === 'replicad') return [];
  if (selected !== 'himmelcad') {
    throw new Error(`HIMMELCAD_OCCT must be "replicad" or "himmelcad", not "${selected}"`);
  }
  const dir = path.resolve(
    process.env.HIMMELCAD_OCCT_DIR ??
      fileURLToPath(new URL('../../vendor/occt-wasm/dist', import.meta.url)),
  );
  for (const file of ['himmelcad_occt.js', 'himmelcad_occt.wasm']) {
    if (!existsSync(path.join(dir, file))) {
      throw new Error(
        `HIMMELCAD_OCCT=himmelcad but ${path.join(dir, file)} is missing; run vendor/occt-wasm/build.sh`,
      );
    }
  }
  const posix = dir.split(path.sep).join('/');
  return [
    {
      find: /^replicad-opencascadejs\/wasm(\?url)?$/,
      replacement: `${posix}/himmelcad_occt.wasm$1`,
    },
    { find: /^replicad-opencascadejs$/, replacement: `${posix}/himmelcad_occt.js` },
  ];
}

export default defineConfig({
  root: 'renderer',
  base: './',
  plugins: [react(), kernelWorkerCsp()],
  resolve: { alias: occtModuleAliases() },
  server: {
    port: 5175,
    strictPort: true,
    host: true,
    // The HimmelCAD OCCT build (vendor/occt-wasm/dist) lives outside the workspace package.
    ...(occtModuleAliases().length > 0
      ? { fs: { allow: [fileURLToPath(new URL('../..', import.meta.url))] } }
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
