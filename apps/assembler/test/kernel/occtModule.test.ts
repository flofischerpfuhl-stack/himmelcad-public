/**
 * Resolution of the HimmelCAD OCCT module from the local artifact cache
 * (`headless/occtModule.ts`): `HIMMELCAD_OCCT_DIR` override, the default
 * `<cache root>/<version>` path, SHA-256 verification against
 * `artifacts.sha256`, and loud failures (never a silent fallback) for a
 * missing directory, a missing file or a wrong hash. Uses small stand-in
 * files and a stand-in recipe directory, so it runs on either module.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  DEFAULT_OCCT_MODULE,
  OcctModuleError,
  occtCacheRoot,
  readArtifactHashes,
  resolveHimmelcadOcct,
  selectedOcctModule,
} from '../../headless/occtModule.js';

const sha = (text: string) => createHash('sha256').update(text).digest('hex');

function fixture(): { root: string; vendor: string; good: string; cleanup: () => void } {
  const root = mkdtempSync(path.join(os.tmpdir(), 'hc-occt-'));
  const vendor = path.join(root, 'vendor', 'occt-wasm');
  mkdirSync(vendor, { recursive: true });
  writeFileSync(path.join(vendor, 'package.json'), JSON.stringify({ version: '9.9.9-hc.test' }));
  writeFileSync(
    path.join(vendor, 'artifacts.sha256'),
    [
      `${sha('glue')}  dist/himmelcad_occt.js`,
      `${sha('wasm')}  dist/himmelcad_occt.wasm`,
      `${sha('types')}  dist/himmelcad_occt.d.ts`,
      '',
    ].join('\n'),
  );
  const good = path.join(root, 'cache', '9.9.9-hc.test');
  mkdirSync(good, { recursive: true });
  writeFileSync(path.join(good, 'himmelcad_occt.js'), 'glue');
  writeFileSync(path.join(good, 'himmelcad_occt.wasm'), 'wasm');
  return { root, vendor, good, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

void test('selection: unset is the default module (HimmelCAD), replicad stays an explicit opt-out', () => {
  assert.equal(
    DEFAULT_OCCT_MODULE,
    'himmelcad',
    'default switched after the Block-6 A/B benchmark',
  );
  assert.equal(selectedOcctModule({}), DEFAULT_OCCT_MODULE);
  assert.equal(selectedOcctModule({ HIMMELCAD_OCCT: '' }), 'himmelcad');
  assert.equal(selectedOcctModule({ HIMMELCAD_OCCT: 'replicad' }), 'replicad');
  assert.equal(selectedOcctModule({ HIMMELCAD_OCCT: ' HimmelCAD ' }), 'himmelcad');
  assert.throws(
    () => selectedOcctModule({ HIMMELCAD_OCCT: 'occt' }),
    /must be "replicad" or "himmelcad"/,
  );
});

void test('artifacts.sha256 is read by file name', () => {
  const f = fixture();
  try {
    const hashes = readArtifactHashes(path.join(f.vendor, 'artifacts.sha256'));
    assert.equal(hashes.get('himmelcad_occt.wasm'), sha('wasm'));
    assert.equal(hashes.size, 3);
  } finally {
    f.cleanup();
  }
});

void test('default path: <cache root>/<version> from vendor/occt-wasm/package.json, hashes verified', () => {
  const f = fixture();
  try {
    const resolved = resolveHimmelcadOcct({
      env: { HIMMELCAD_OCCT_CACHE: path.join(f.root, 'cache') },
      vendorDir: f.vendor,
    });
    assert.equal(resolved.source, 'cache');
    assert.equal(resolved.version, '9.9.9-hc.test');
    assert.equal(resolved.dir, f.good);
    assert.equal(resolved.wasm, path.join(f.good, 'himmelcad_occt.wasm'));
    assert.equal(
      occtCacheRoot({}, 'win32'),
      'D:\\AgentWork\\HimmelCAD-Assembler\\occt-wasm',
      'Windows default cache root (owner decision)',
    );
    assert.equal(
      occtCacheRoot({}, 'linux'),
      path.join(os.homedir(), '.cache', 'himmelcad', 'occt-wasm'),
    );
  } finally {
    f.cleanup();
  }
});

void test('HIMMELCAD_OCCT_DIR overrides the cache path', () => {
  const f = fixture();
  try {
    const other = path.join(f.root, 'elsewhere');
    mkdirSync(other);
    writeFileSync(path.join(other, 'himmelcad_occt.js'), 'glue');
    writeFileSync(path.join(other, 'himmelcad_occt.wasm'), 'wasm');
    const resolved = resolveHimmelcadOcct({
      env: { HIMMELCAD_OCCT_DIR: other, HIMMELCAD_OCCT_CACHE: path.join(f.root, 'cache') },
      vendorDir: f.vendor,
    });
    assert.equal(resolved.source, 'HIMMELCAD_OCCT_DIR');
    assert.equal(resolved.dir, other);
  } finally {
    f.cleanup();
  }
});

void test('missing directory, missing file and wrong hash fail loudly with the fix', () => {
  const f = fixture();
  try {
    const hint =
      /custom OCCT module missing or wrong hash — run vendor\/occt-wasm\/build\.sh or set HIMMELCAD_OCCT_DIR/;
    assert.throws(
      () =>
        resolveHimmelcadOcct({
          env: { HIMMELCAD_OCCT_CACHE: path.join(f.root, 'no-cache') },
          vendorDir: f.vendor,
        }),
      (error: unknown) =>
        error instanceof OcctModuleError &&
        hint.test(error.message) &&
        /does not exist/.test(error.message),
    );
    assert.throws(
      () =>
        resolveHimmelcadOcct({
          env: { HIMMELCAD_OCCT_DIR: path.join(f.root, 'missing-dir') },
          vendorDir: f.vendor,
        }),
      hint,
    );
    writeFileSync(path.join(f.good, 'himmelcad_occt.wasm'), 'tampered');
    assert.throws(
      () =>
        resolveHimmelcadOcct({
          env: { HIMMELCAD_OCCT_CACHE: path.join(f.root, 'cache') },
          vendorDir: f.vendor,
        }),
      (error: unknown) =>
        error instanceof OcctModuleError &&
        hint.test(error.message) &&
        error.message.includes(sha('tampered')) &&
        error.message.includes(sha('wasm')),
    );
    rmSync(path.join(f.good, 'himmelcad_occt.js'));
    assert.throws(
      () =>
        resolveHimmelcadOcct({
          env: { HIMMELCAD_OCCT_CACHE: path.join(f.root, 'cache') },
          vendorDir: f.vendor,
        }),
      /himmelcad_occt\.js is missing/,
    );
  } finally {
    f.cleanup();
  }
});
