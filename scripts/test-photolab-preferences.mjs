#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const workspace = resolve(import.meta.dirname, '..');
const output = mkdtempSync(join(tmpdir(), 'himmelcad-preferences-test-'));

try {
  execFileSync(
    'pnpm',
    [
      'exec',
      'tsc',
      'apps/photolab/electron/preferences.ts',
      'apps/photolab/electron/preferences.test.ts',
      '--module',
      'commonjs',
      '--moduleResolution',
      'node',
      '--target',
      'es2022',
      '--lib',
      'es2023',
      '--types',
      'node',
      '--strict',
      '--esModuleInterop',
      '--skipLibCheck',
      '--outDir',
      output,
    ],
    { cwd: workspace, env: process.env, stdio: 'inherit' },
  );
  execFileSync('node', ['--test', join(output, 'preferences.test.js')], {
    cwd: workspace,
    env: process.env,
    stdio: 'inherit',
  });
} finally {
  rmSync(output, { force: true, recursive: true });
}
