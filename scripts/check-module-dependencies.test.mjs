import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { evaluateFixture } from './check-module-dependencies.mjs';

const fixtureRoot = join(dirname(fileURLToPath(import.meta.url)), 'fixtures/module-dependencies');

for (const [name, expectedKind] of [
  ['upward-edge.json', 'upward'],
  ['domain-to-domain.json', 'domain-to-domain'],
  ['undeclared-import.json', 'undeclared-workspace-import'],
  ['stale-allowlist.json', 'stale-allowlist'],
  ['cross-crate-include.json', 'cross-crate-source-include'],
  ['domain-macro-export.json', 'domain-macro-export'],
  ['crate-self-alias.json', 'crate-self-alias'],
  ['workspace-crate-rename.json', 'workspace-crate-rename'],
]) {
  test(`${name} fails with ${expectedKind}`, () => {
    const fixture = JSON.parse(readFileSync(join(fixtureRoot, name), 'utf8'));
    assert.ok(evaluateFixture(fixture).some(({ kind }) => kind === expectedKind));
  });
}
