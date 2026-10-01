/**
 * Unit tests of the web build's pure parts: what is precached and compressed,
 * the precache manifest/version, the header and CSP rules (`pnpm test`; no
 * build needed — the manifest test writes a tiny site to a temp folder).
 */
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { DOCUMENT_CSP, DOCUMENT_CSP_HEADER, WORKER_CSP, isWorkerCspFile } from './csp.mjs';
import { headersFor, netlifyHeaders } from './headers.mjs';
import { isCompressible, isPrecached, listFiles, precacheManifest } from './postbuild.mjs';

test('the document policy never allows eval; the worker policy only adds eval for scripts', () => {
  for (const policy of [DOCUMENT_CSP, DOCUMENT_CSP_HEADER]) {
    assert.doesNotMatch(policy, /unsafe-eval/);
    assert.match(policy, /script-src 'self'(;|$)/);
    assert.doesNotMatch(policy, /https?:/, 'no third-party origin');
  }
  assert.match(DOCUMENT_CSP_HEADER, /frame-ancestors 'none'/);
  assert.match(WORKER_CSP, /script-src 'self' 'unsafe-eval' 'wasm-unsafe-eval'/);
  assert.doesNotMatch(WORKER_CSP, /https?:/);
});

test('worker policy files: kernel/solver workers and the LGPL glue, by prefix', () => {
  for (const name of [
    'assets/kernel.worker-AbC123.js',
    'assets/solver.worker-x.js',
    'assets/himmelcad_occt-DYYnjo-2.js',
    'assets/replicad_single-1.js',
    'assets/planegcs-BIeFK5cG.js',
  ]) {
    assert.equal(isWorkerCspFile(name), true, name);
  }
  for (const name of [
    'assets/index-BNq84tqb.js',
    'assets/import.worker-1.js',
    'assets/himmelcad_occt-CEOG2Mhb.wasm',
    'index.html',
  ]) {
    assert.equal(isWorkerCspFile(name), false, name);
  }
});

test('headers: wasm MIME, immutable hashed assets, revalidated entry points, CSP split', () => {
  const wasm = headersFor('assets/himmelcad_occt-CEOG2Mhb.wasm');
  assert.equal(wasm['Content-Type'], 'application/wasm');
  assert.match(wasm['Cache-Control'], /immutable/);
  assert.equal(wasm['Content-Security-Policy'], undefined);
  const html = headersFor('index.html');
  assert.equal(html['Cache-Control'], 'no-cache');
  assert.equal(html['Content-Security-Policy'], DOCUMENT_CSP_HEADER);
  assert.equal(headersFor('sw.js')['Cache-Control'], 'no-cache');
  assert.equal(headersFor('assets/kernel.worker-1.js')['Content-Security-Policy'], WORKER_CSP);
  assert.equal(headersFor('assets/index-1.js')['Content-Security-Policy'], DOCUMENT_CSP);
  assert.equal(
    headersFor('manifest.webmanifest')['Content-Type'],
    'application/manifest+json; charset=utf-8',
  );
  // `_headers` hosts join every matching rule: no rule may give a worker two policies.
  const file = netlifyHeaders('/');
  assert.doesNotMatch(file, /\/assets\/\*\n(?: {2}[^\n]*\n)* {2}Content-Security-Policy/);
  assert.match(file, /\/assets\/kernel\.worker-\*\n {2}Content-Security-Policy: /);
});

test('precache list and version', () => {
  const dir = mkdtempSync(join(tmpdir(), 'assembler-web-postbuild-'));
  try {
    mkdirSync(join(dir, 'assets'));
    writeFileSync(join(dir, 'index.html'), '<!doctype html>');
    writeFileSync(join(dir, 'sw.js'), 'worker');
    writeFileSync(join(dir, '_headers'), '/*');
    writeFileSync(join(dir, 'assets/a-1.js'), 'x'.repeat(2000));
    writeFileSync(join(dir, 'assets/a-1.js.br'), 'br');
    writeFileSync(join(dir, 'assets/m-1.wasm'), Buffer.from([0, 97, 115, 109]));
    const files = listFiles(dir);
    const { entries, version } = precacheManifest(dir, files);
    assert.deepEqual(
      entries.map((e) => e.url),
      ['assets/a-1.js', 'assets/m-1.wasm', 'index.html'],
    );
    assert.match(entries[1].sha256, /^[0-9a-f]{64}$/, 'wasm entries carry their SHA-256');
    assert.equal(entries[0].sha256, undefined);
    assert.match(version, /^[0-9a-f]{16}$/);
    writeFileSync(join(dir, 'index.html'), '<!doctype html><title>changed</title>');
    assert.notEqual(precacheManifest(dir, listFiles(dir)).version, version, 'content → version');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  assert.equal(isPrecached('sw.js'), false);
  assert.equal(isPrecached('assets/x.wasm.br'), false);
  assert.equal(isPrecached('licenses/LGPL-2.1.txt'), true);
  assert.equal(isCompressible('assets/x.wasm'), true);
  assert.equal(isCompressible('icons/icon-192.png'), false);
});
