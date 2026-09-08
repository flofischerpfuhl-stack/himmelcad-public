#!/usr/bin/env node

import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const REPO = resolve(import.meta.dirname, '..');
const BUILDER = resolve(REPO, 'apps/builder');
const requireFromBuilder = createRequire(resolve(BUILDER, 'package.json'));

export async function buildBuilderElectronMain({
  outDir = resolve(BUILDER, 'dist/electron'),
  emptyOutDir = false,
} = {}) {
  const viteEntry = resolve(requireFromBuilder.resolve('vite/package.json'), '../dist/node/index.js');
  const { build } = await import(pathToFileURL(viteEntry).href);
  await build({
    root: BUILDER,
    configFile: false,
    logLevel: 'info',
    build: {
      ssr: resolve(BUILDER, 'electron/main.ts'),
      outDir,
      emptyOutDir,
      target: 'node22',
      sourcemap: true,
      rollupOptions: {
        // These packages already provide an Electron/Node runtime entry. The
        // source-only @himmelcad/app package deliberately remains in the bundle.
        external: [
          'electron',
          'electron-updater',
          '@himmelcad/automation-host/electron',
          '@himmelcad/automation-host/provider-credentials',
        ],
        output: {
          format: 'cjs',
          entryFileNames: 'main.js',
        },
      },
    },
    ssr: {
      noExternal: ['@himmelcad/app'],
    },
  });
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  await buildBuilderElectronMain();
}
