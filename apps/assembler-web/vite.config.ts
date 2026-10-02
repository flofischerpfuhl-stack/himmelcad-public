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
const { drawIcon, encodePng, icoOf, faviconSvg } = (await import(
  /* @vite-ignore */ iconScript
)) as {
  drawIcon: (size: number, options?: { maskable?: boolean }) => Uint8Array;
  encodePng: (size: number, rgba: Uint8Array) => Uint8Array;
  icoOf: (sizes: number[]) => Uint8Array;
  faviconSvg: () => string;
};

/**
 * Preview release (default): not announced yet, so search engines are asked to stay away
 * (`<meta name="robots">`, `X-Robots-Tag`, `robots.txt`) and Home/About show a "Preview"
 * badge. `HIMMELCAD_WEB_PUBLIC=1` builds the public release (deploy/README.md "Going public").
 */
const PUBLIC_RELEASE = process.env.HIMMELCAD_WEB_PUBLIC === '1';

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
              `<meta http-equiv="Content-Security-Policy" content="${DOCUMENT_CSP}" />${
                PUBLIC_RELEASE ? '' : '\n    <meta name="robots" content="noindex, nofollow" />'
              }`,
            ),
    },
  };
}

/**
 * App icons, rendered from the Assembler mark (low-poly bolt,
 * `branding/logos/source/himmelcad-assembler*.svg`) by
 * `../assembler/scripts/generate-icon.mjs`, the same pipeline as the desktop
 * icons: manifest icons on the family's black card, maskable variants
 * (full-bleed, mark inside the 80 % safe circle), the iOS home-screen icon
 * (full-bleed: iOS rounds it), shortcut icons, and the favicons (SVG that
 * follows the light/dark scheme; ICO for `/favicon.ico` requests and browsers
 * without SVG favicons). Emitted into the build and served by the dev server.
 */
function appIcons(): Plugin {
  const png = (size: number, draw: (size: number) => Uint8Array) => () =>
    encodePng(size, draw(size));
  const icons: [string, string, () => Uint8Array | string][] = [
    ['icons/icon-192.png', 'image/png', png(192, (s) => drawIcon(s))],
    ['icons/icon-512.png', 'image/png', png(512, (s) => drawIcon(s))],
    ['icons/icon-maskable-192.png', 'image/png', png(192, (s) => drawIcon(s, { maskable: true }))],
    ['icons/icon-maskable-512.png', 'image/png', png(512, (s) => drawIcon(s, { maskable: true }))],
    ['icons/apple-touch-icon.png', 'image/png', png(180, (s) => drawIcon(s, { maskable: true }))],
    ['icons/shortcut-96.png', 'image/png', png(96, (s) => drawIcon(s))],
    ['icons/favicon.svg', 'image/svg+xml', faviconSvg],
    ['favicon.ico', 'image/x-icon', () => icoOf([16, 32, 48])],
  ];
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
        res.setHeader('Content-Type', icon[1]);
        res.end(icon[2]());
      });
    },
    generateBundle() {
      for (const [fileName, , render] of icons) {
        this.emitFile({ type: 'asset', fileName, source: render() });
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
  // Read by the shell's Home and About (`interface/shell-ui/releaseChannel.ts`); unset on desktop.
  define: { 'import.meta.env.VITE_HC_RELEASE': JSON.stringify(PUBLIC_RELEASE ? '' : 'preview') },
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
