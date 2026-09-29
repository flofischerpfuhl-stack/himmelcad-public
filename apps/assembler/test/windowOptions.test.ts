import assert from 'node:assert/strict';
import test from 'node:test';

import { ASSEMBLER_PRODUCT_NAME, createMainWindowOptions } from '../electron/windowOptions.js';

void test('main window keeps Electron secure defaults', () => {
  const options = createMainWindowOptions('/tmp/assembler-electron');

  assert.equal(options.webPreferences?.contextIsolation, true);
  assert.equal(options.webPreferences?.sandbox, true);
  assert.equal(options.webPreferences?.nodeIntegration, false);
  assert.equal(options.title, ASSEMBLER_PRODUCT_NAME);
  assert.equal(options.minWidth, 960);
  assert.equal(options.minHeight, 600);
});

void test('preload path is resolved from the given electron directory', () => {
  const options = createMainWindowOptions('/tmp/assembler-electron');

  assert.match(options.webPreferences?.preload ?? '', /assembler-electron[/\\]preload\.js$/);
});
