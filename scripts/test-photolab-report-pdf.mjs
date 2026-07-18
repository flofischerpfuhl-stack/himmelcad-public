#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';

const workspace = resolve(import.meta.dirname, '..');
const electron = resolve(
  workspace,
  'apps/photolab/node_modules/.bin',
  process.platform === 'win32' ? 'electron.cmd' : 'electron',
);
const test = resolve(workspace, 'apps/photolab/test/report-pdf.cjs');

if (process.platform === 'linux') {
  execFileSync('xvfb-run', ['-a', electron, test], { stdio: 'inherit' });
} else {
  execFileSync(electron, [test], { stdio: 'inherit' });
}
