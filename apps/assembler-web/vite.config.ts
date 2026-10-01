/**
 * HimmelCAD Assembler for the browser (PWA): the same modules as the desktop
 * renderer (`../assembler/renderer/src`), composed by `src/main.tsx` with the
 * web host. Static output in `dist/`; `scripts/postbuild.mjs` adds the
 * service worker, the web app manifest and icons, precompressed `.br`/`.gz`
 * siblings and the LGPL source offer (assembler/WEB.md, deploy/README.md).
 *
 * Base path: relative (`./`) by default, so the same build works at any
 * sub-path of a host; `HIMMELCAD_WEB_BASE=/assembler/` pins an absolute one.
 *
 * OCCT module: the same selection as the desktop build
 * (`../assembler/headless/occtModule.ts`): the HimmelCAD module from the
 * local artifact cache, SHA-256-checked before it is copied into the
 * output; `HIMMELCAD_OCCT=replicad` opts out. Missing or wrong files fail the
 * build.
 */
import { createReadStream, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import react from '@vitejs/plugin-react';
import { defineConfig, type Plugin } from 'vite';

import { resolveHimmelcadOcct, selectedOcctModule } from '../assembler/headless/occtModule.ts';
import { DOCUMENT_CSP, WORKER_CSP, isWorkerCspFile } from './scripts/csp.mjs';

// Loaded at run time, not bundled into the config: the script starts with a shebang.
const iconScript = new URL('../assembler/scripts/generate-icon.mjs', import.meta.url).href;
const { drawIcon, encodePng } = (await import(/* @vite-ignore */ iconScript)) as {
  drawIcon: (size: number, options?: { maskable?: boolean }) => Uint8Array;
  encodePng: (size: number, rgba: Uint8Array) => Uint8Array;
};

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

/**
 * Dev server: the document gets the strict policy as a header too, the
 * kernel and solver workers (and the LGPL glue they import) the worker
 * policy — the same split `scripts/serve.mjs` and the service worker apply
 * to the built site, and `electron/main.ts` to the desktop app.
 */
function devCsp(): Plugin {
  return {
    name: 'assembler-web-dev-csp',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const url = (req.url ?? '').split('?')[0] ?? '';
        if (isWorkerCspFile(url) || /kernel\.worker|solver\.worker|planegcs/i.test(url)) {
          res.setHeader('Content-Security-Policy', WORKER_CSP);
        }
        next();
      });
    },
  };
}

/** Dev only: serve the verified OCCT `.wasm` from the cache directory (see the desktop config). */
function occtCacheFiles(): Plugin {
  return {
    name: 'assembler-web-occt-cache-files',
    configureServer(server) {
      if (!occtSelection) return;
      const root = path.resolve(occtSelection.dir);
      server.middlewares.use((req, res, next) => {
        const url = req.url ?? '';
        if (!url.startsWith('/@fs/') || url.includes('?')) {
          next();
          return;
        }
        const file = path.resolve(decodeURIComponent(url.slice('/@fs/'.length)));
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

/** The document's CSP as a `<meta>` (works on any static host); hosts add the same as a header. */
function documentCspMeta(): Plugin {
  return {
    name: 'assembler-web-document-csp',
    transformIndexHtml: {
      order: 'post',
      handler: (html, ctx) =>
        // Dev needs Vite's HMR client (inline preamble, websocket); the meta goes into builds only.
        ctx.server
          ? html
          : html.replace(
              '<!-- csp -->',
              `<meta http-equiv="Content-Security-Policy" content="${DOCUMENT_CSP}" />`,
            ),
    },
  };
}

/**
 * App icons, rendered from the desktop app's procedural mark
 * (`../assembler/scripts/generate-icon.mjs`, a documented placeholder until
 * an owner-approved mark exists): manifest icons, the maskable variant
 * (full-bleed, mark inside the safe circle), the iOS home-screen icon and the
 * favicon. Emitted into the build and served by the dev server.
 */
function appIcons(): Plugin {
  const icons: [string, number, boolean][] = [
    ['icons/icon-192.png', 192, false],
    ['icons/icon-512.png', 512, false],
    ['icons/icon-maskable-512.png', 512, true],
    ['icons/apple-touch-icon.png', 180, true],
    ['icons/favicon-32.png', 32, false],
  ];
  const render = (size: number, maskable: boolean): Uint8Array =>
    encodePng(size, drawIcon(size, { maskable }));
  return {
    name: 'assembler-web-icons',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const name = (req.url ?? '').replace(/^\//, '').split('?')[0];
        const icon = icons.find(([file]) => file === name);
        if (!icon) {
          next();
          return;
        }
        res.setHeader('Content-Type', 'image/png');
        res.end(render(icon[1], icon[2]));
      });
    },
    generateBundle() {
      for (const [fileName, size, maskable] of icons) {
        this.emitFile({ type: 'asset', fileName, source: render(size, maskable) });
      }
    },
  };
}

const appRoot = fileURLToPath(new URL('.', import.meta.url));
const assemblerRoot = fileURLToPath(new URL('../assembler/', import.meta.url));

export default defineConfig({
  root: appRoot,
  base: process.env.HIMMELCAD_WEB_BASE ?? './',
  publicDir: 'public',
  cacheDir: fileURLToPath(
    new URL(occtSelection ? 'node_modules/.vite-himmelcad' : 'node_modules/.vite', import.meta.url),
  ),
  plugins: [react(), devCsp(), occtCacheFiles(), documentCspMeta(), appIcons()],
  resolve: { alias: occtSelection?.aliases ?? [] },
  server: {
    port: 5176,
    strictPort: true,
    fs: {
      allow: [
        fileURLToPath(new URL('../..', import.meta.url)),
        assemblerRoot,
        ...(occtSelection ? [occtSelection.dir] : []),
      ],
    },
  },
  worker: {
    format: 'es',
    rollupOptions: {
      output: {
        // The LGPL planeGCS glue + wrapper stay one separately replaceable chunk (as on desktop).
        manualChunks: (id: string) =>
          id.includes('@salusoft89/planegcs') ? 'planegcs' : undefined,
      },
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    // No source maps in the deployable site: they would double the precache; the desktop build keeps them.
    sourcemap: false,
    chunkSizeWarningLimit: 2048,
    // Inline nothing as data: URLs (the CSP allows data: images only).
    assetsInlineLimit: 0,
  },
});
