#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const workspace = resolve(import.meta.dirname, '..');
const output = mkdtempSync(join(tmpdir(), 'himmelcad-preferences-test-'));
const require = createRequire(import.meta.url);
const typescriptCompiler = require.resolve('typescript/bin/tsc');

try {
  execFileSync(
    process.execPath,
    [
      typescriptCompiler,
      'apps/photolab/electron/preferences.ts',
      'apps/photolab/electron/preferences.test.ts',
      'apps/photolab/electron/projectLifecycle.ts',
      'apps/photolab/electron/projectLifecycle.test.ts',
      'apps/photolab/electron/sidecarPath.ts',
      'apps/photolab/electron/sidecarPath.test.ts',
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
  execFileSync(
    'node',
    [
      '--test',
      join(output, 'preferences.test.js'),
      join(output, 'projectLifecycle.test.js'),
      join(output, 'sidecarPath.test.js'),
    ],
    {
      cwd: workspace,
      env: process.env,
      stdio: 'inherit',
    },
  );
} finally {
  rmSync(output, { force: true, recursive: true });
}
