import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  computeStageKeys,
  decideStagePackages,
  parseStageArguments,
} from './stage-builder-viewer-wasm.mjs';

test('parses release defaults and explicit development controls', () => {
  assert.deepEqual(parseStageArguments([]), { force: false, profile: 'release' });
  assert.deepEqual(parseStageArguments(['--', '--force', '--profile', 'dev']), {
    force: true,
    profile: 'dev',
  });
  assert.deepEqual(parseStageArguments(['--profile=release']), {
    force: false,
    profile: 'release',
  });
  assert.throws(() => parseStageArguments(['--profile', 'fast']), /dev or release/);
  assert.throws(() => parseStageArguments(['--unexpected']), /Unknown argument/);
});

test('keys cover shared inputs and isolate crate source changes', async () => {
  const root = await createFixture();
  const options = { root, profile: 'dev', stagingScriptPath: 'scripts/stage.mjs' };
  const initial = await computeStageKeys(options);
  assert.deepEqual(await computeStageKeys(options), initial);

  await writeFile(path.join(root, 'crates/himmelcad-wasm/src/lib.rs'), 'changed viewer');
  const viewerChanged = await computeStageKeys(options);
  assert.notEqual(viewerChanged['himmelcad-wasm'], initial['himmelcad-wasm']);
  assert.equal(viewerChanged['himmelcad-decode-wasm'], initial['himmelcad-decode-wasm']);

  await writeFile(path.join(root, 'Cargo.lock'), 'changed lock');
  const lockChanged = await computeStageKeys(options);
  assert.notEqual(lockChanged['himmelcad-wasm'], viewerChanged['himmelcad-wasm']);
  assert.notEqual(lockChanged['himmelcad-decode-wasm'], viewerChanged['himmelcad-decode-wasm']);
  await writeFile(path.join(root, 'crates/himmelcad-core/src/lib.rs'), 'changed core');
  const coreChanged = await computeStageKeys(options);
  assert.notEqual(coreChanged['himmelcad-wasm'], lockChanged['himmelcad-wasm']);
  assert.notEqual(coreChanged['himmelcad-decode-wasm'], lockChanged['himmelcad-decode-wasm']);
  assert.notEqual(
    (await computeStageKeys({ ...options, profile: 'release' }))['himmelcad-wasm'],
    coreChanged['himmelcad-wasm'],
  );
});

test('matching keys skip while changes, missing artifacts, and force rebuild', () => {
  const keys = { 'himmelcad-wasm': 'viewer-key', 'himmelcad-decode-wasm': 'decode-key' };
  const record = { version: 1, profile: 'dev', keys };
  const artifactsPresent = { 'himmelcad-wasm': true, 'himmelcad-decode-wasm': true };
  assert.deepEqual(
    decideStagePackages({ force: false, profile: 'dev', keys, record, artifactsPresent }),
    [],
  );
  assert.deepEqual(
    decideStagePackages({
      force: false,
      profile: 'dev',
      keys: { ...keys, 'himmelcad-wasm': 'changed' },
      record,
      artifactsPresent,
    }),
    ['himmelcad-wasm'],
  );
  assert.deepEqual(
    decideStagePackages({
      force: false,
      profile: 'dev',
      keys,
      record,
      artifactsPresent: { ...artifactsPresent, 'himmelcad-decode-wasm': false },
    }),
    ['himmelcad-decode-wasm'],
  );
  assert.deepEqual(
    decideStagePackages({
      force: true,
      profile: 'dev',
      keys,
      record,
      artifactsPresent,
    }),
    ['himmelcad-wasm', 'himmelcad-decode-wasm'],
  );
});

async function createFixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'himmelcad-wasm-stage-'));
  await Promise.all([
    mkdir(path.join(root, 'scripts'), { recursive: true }),
    mkdir(path.join(root, 'crates/himmelcad-wasm/src'), { recursive: true }),
    mkdir(path.join(root, 'crates/himmelcad-decode-wasm/src'), { recursive: true }),
    mkdir(path.join(root, 'crates/himmelcad-core/src'), { recursive: true }),
    mkdir(path.join(root, 'crates/himmelcad-render/src'), { recursive: true }),
  ]);
  await Promise.all([
    writeFile(path.join(root, 'Cargo.toml'), 'workspace manifest'),
    writeFile(path.join(root, 'Cargo.lock'), 'lock'),
    writeFile(path.join(root, 'rust-toolchain.toml'), 'toolchain'),
    writeFile(path.join(root, 'scripts/stage.mjs'), 'script'),
    writeFile(path.join(root, 'crates/himmelcad-wasm/Cargo.toml'), 'viewer manifest'),
    writeFile(path.join(root, 'crates/himmelcad-wasm/src/lib.rs'), 'viewer source'),
    writeFile(path.join(root, 'crates/himmelcad-decode-wasm/Cargo.toml'), 'decode manifest'),
    writeFile(path.join(root, 'crates/himmelcad-decode-wasm/src/lib.rs'), 'decode source'),
    writeFile(path.join(root, 'crates/himmelcad-core/Cargo.toml'), 'core manifest'),
    writeFile(path.join(root, 'crates/himmelcad-core/src/lib.rs'), 'core source'),
    writeFile(path.join(root, 'crates/himmelcad-render/Cargo.toml'), 'render manifest'),
    writeFile(path.join(root, 'crates/himmelcad-render/src/lib.rs'), 'render source'),
  ]);
  return root;
}
