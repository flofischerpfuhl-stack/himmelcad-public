// Marks `dist/electron/` as CommonJS. The package root's `package.json` has
// `"type": "module"` (the renderer is ESM), but `tsconfig.electron.json`
// compiles the Electron main/preload process to CommonJS (`module:
// "CommonJS"`, needed for `require('electron')`/`contextBridge` and to keep
// the main-process build simple). Without this file, Node/Electron treats
// `dist/electron/*.js` as ES modules (inheriting the parent's `"type"`) and
// refuses to load them ("exports is not defined in ES module scope") —
// found by the production smoke test (`test/electron/production.test.ts`),
// `assembler/KERNEL-SPIKE.md`'s "Packaged Electron is unverified" risk.
// A nested `package.json` with its own `"type"` is the standard Node
// mechanism for mixed CJS/ESM within one package; cheaper than converting
// the small main-process surface to ESM with explicit `.js` extensions.
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const target = resolve(import.meta.dirname, '../dist/electron/package.json');
writeFileSync(target, JSON.stringify({ type: 'commonjs' }) + '\n');
