/* global process */

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const readSource = (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8');
const [main, app, island, islandStyles, viewportStyles, visualAudit] = await Promise.all([
  readSource('apps/photolab/electron/main.ts'),
  readSource('apps/photolab/renderer/src/App.tsx'),
  readSource('apps/photolab/renderer/src/FloatingTaskIsland.tsx'),
  readSource('apps/photolab/renderer/src/FloatingTaskIsland.module.css'),
  readSource('packages/@himmelcad/viewer/src/Viewport.module.css'),
  readSource('scripts/photolab-visual-regression.mjs'),
]);
assert.doesNotMatch(main, /showMessageBox|showErrorBox|new Notification/);
assert.doesNotMatch(app, /\b(?:alert|confirm|prompt)\s*\(/);
assert.match(main, /products:export-confirm/);
assert.match(app, /<FloatingTaskIsland modal/);
assert.match(island, /FOCUSABLE/);
assert.match(island, /event\.key !== 'Tab'/);
assert.match(island, /previouslyFocused\?\.focus\(\)/);
assert.match(islandStyles, /\.modalLayer[\s\S]*pointer-events:\s*auto/);
assert.match(viewportStyles, /contain:\s*layout paint style/);
assert.match(viewportStyles, /clip-path:\s*inset\(0 round/);
assert.match(visualAudit, /chromium\.launch\(/);
assert.doesNotMatch(visualAudit, /connectOverCDP|9223/);
assert.match(visualAudit, /window\.alert=.*Native alert is forbidden/);

process.stdout.write('PhotoLab dialog policy tests passed.\n');
