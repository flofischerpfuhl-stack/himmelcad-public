import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import test from 'node:test';

import { buildBuilderElectronMain } from './build-builder-electron.mjs';

test('Builder Electron main bundles source-only workspace runtime dependencies', async () => {
  const outDir = await mkdtemp(resolve(tmpdir(), 'hcad-builder-electron-'));
  try {
    await buildBuilderElectronMain({ outDir, emptyOutDir: true });
    const output = await readFile(resolve(outDir, 'main.js'), 'utf8');
    assert.doesNotMatch(output, /require\(["']@himmelcad\/app["']\)/);
    assert.match(output, /class JobRegistry/);
    assert.match(output, /require\(["']electron["']\)/);
  } finally {
    await rm(outDir, { recursive: true, force: true });
  }
});
