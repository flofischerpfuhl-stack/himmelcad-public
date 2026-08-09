import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
import { readFileSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const excalidrawFork = fileURLToPath(
  new URL('../../packages/excalidraw-plan/packages/excalidraw', import.meta.url),
);
const excalidrawUtilsFork = fileURLToPath(
  new URL('../../packages/excalidraw-plan/packages/utils', import.meta.url),
);
const excalidrawMathFork = fileURLToPath(
  new URL('../../packages/excalidraw-plan/packages/math', import.meta.url),
);
const installedExcalidraw = realpathSync(
  fileURLToPath(new URL('./node_modules/@excalidraw/excalidraw', import.meta.url)),
);
const installedExcalidrawModules = resolve(installedExcalidraw, '../..');
const forkManifest = JSON.parse(readFileSync(join(excalidrawFork, 'package.json'), 'utf8')) as {
  dependencies?: Record<string, string>;
};
// Dual CJS/ESM packages whose package.json "exports" must not be bypassed.
// Naive `pkg/subpath` → `node_modules/pkg/subpath` aliases resolve the CJS build;
// Vite/esbuild then prebundles an empty named-export facade (e.g. missing `atom`).
const dualPackageEsmRoot = new Map<string, string>([['jotai', 'esm']]);
const forkDependencyAliases = Object.keys(forkManifest.dependencies ?? {}).flatMap((dependency) => {
  const escaped = dependency.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const installed = join(installedExcalidrawModules, dependency);
  const esmRoot = dualPackageEsmRoot.get(dependency);
  if (esmRoot) {
    const esmDir = join(installed, esmRoot);
    return [
      { find: new RegExp(`^${escaped}$`), replacement: join(esmDir, 'index.mjs') },
      { find: new RegExp(`^${escaped}/(.*)$`), replacement: `${esmDir}/$1.mjs` },
    ];
  }
  return [
    { find: new RegExp(`^${escaped}$`), replacement: installed },
    { find: new RegExp(`^${escaped}/(.*)$`), replacement: `${installed}/$1` },
  ];
});

export default defineConfig({
  root: 'renderer',
  base: './',
  publicDir: fileURLToPath(new URL('../../.build/builder-viewer/public', import.meta.url)),
  plugins: [react()],
  resolve: {
    alias: [
      { find: /^@excalidraw\/excalidraw$/, replacement: `${excalidrawFork}/index.tsx` },
      {
        find: /^@excalidraw\/excalidraw\/(?!index\.css$)(.*)$/,
        replacement: `${excalidrawFork}/$1`,
      },
      { find: /^@excalidraw\/utils$/, replacement: `${excalidrawUtilsFork}/index.ts` },
      { find: /^@excalidraw\/utils\/(.*)$/, replacement: `${excalidrawUtilsFork}/$1` },
      { find: /^@excalidraw\/math$/, replacement: `${excalidrawMathFork}/index.ts` },
      { find: /^@excalidraw\/math\/(.*)$/, replacement: `${excalidrawMathFork}/$1` },
      // Source-fork files live outside pnpm's virtual-store package root. Point their
      // pinned runtime dependencies at the already installed 0.18 distribution graph.
      ...forkDependencyAliases,
    ],
  },
  optimizeDeps: {
    // Ensure jotai is re-prebundled from ESM entrypoints after alias changes.
    include: ['jotai', 'jotai/vanilla', 'jotai/react', 'jotai/react/utils', 'jotai-scope'],
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
