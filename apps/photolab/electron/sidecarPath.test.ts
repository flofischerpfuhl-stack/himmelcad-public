import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';

import { resolveDevelopmentSidecarPath } from './sidecarPath';

test('selects the Windows .exe development sidecar', () => {
  const repositoryRoot = mkdtempSync(join(tmpdir(), 'himmelcad-sidecar-path-'));
  try {
    const executable = resolve(repositoryRoot, 'target', 'debug', 'himmelcad-sidecar.exe');
    mkdirSync(resolve(repositoryRoot, 'target', 'debug'), { recursive: true });
    writeFileSync(executable, 'fixture');

    const selected = resolveDevelopmentSidecarPath(repositoryRoot, 'win32', {});

    assert.equal(selected, executable);
    assert.equal(existsSync(selected), true);
    assert.equal(existsSync(resolve(repositoryRoot, 'target', 'debug', 'himmelcad-sidecar')), false);
  } finally {
    rmSync(repositoryRoot, { force: true, recursive: true });
  }
});

test('accepts the explicit development sidecar override', () => {
  const repositoryRoot = resolve('repository');
  assert.equal(
    resolveDevelopmentSidecarPath(repositoryRoot, 'win32', {
      HIMMELCAD_SIDECAR_BIN: 'target/win/release/himmelcad-sidecar.exe',
    }),
    resolve(repositoryRoot, 'target', 'win', 'release', 'himmelcad-sidecar.exe'),
  );
});
