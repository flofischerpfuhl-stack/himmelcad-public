/**
 * The Cloudflare Worker (`worker.mjs`) against a fake `ASSETS` binding holding what
 * `.assetsignore` lets through: the OCCT module only as `.br`/`.gz` siblings.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { brotliCompressSync, gzipSync } from 'node:zlib';

import worker from './worker.mjs';

const MODULE = '/assets/himmelcad_occt-AbC.wasm';
const RAW = Buffer.from(Array.from({ length: 5000 }, (_, i) => (i * 7) % 251));

function fakeEnv(release = 'preview') {
  const files = new Map([
    [`${MODULE}.br`, brotliCompressSync(RAW)],
    [`${MODULE}.gz`, gzipSync(RAW)],
    ['/build-info.json', Buffer.from(JSON.stringify({ release }))],
    ['/index.html', Buffer.from('<!doctype html>')],
  ]);
  const seen = [];
  return {
    seen,
    ASSETS: {
      fetch: async (input) => {
        const request = input instanceof Request ? input : new Request(input);
        const path = new URL(request.url).pathname;
        seen.push({ path, acceptEncoding: request.headers.get('Accept-Encoding') });
        const body = files.get(path);
        return body
          ? new Response(body, { headers: { 'Content-Length': String(body.length) } })
          : new Response('Not found', { status: 404 });
      },
    },
  };
}

const get = (env, path, acceptEncoding, method = 'GET') =>
  worker.fetch(
    new Request(`https://assembler.example${path}`, {
      method,
      headers: acceptEncoding === null ? {} : { 'Accept-Encoding': acceptEncoding },
    }),
    env,
  );

test('the OCCT module: brotli sibling with Content-Encoding br and application/wasm', async () => {
  const env = fakeEnv();
  const response = await get(env, MODULE, 'gzip, deflate, br, zstd');
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('Content-Type'), 'application/wasm');
  assert.equal(response.headers.get('Content-Encoding'), 'br');
  assert.match(response.headers.get('Cache-Control'), /immutable/);
  assert.equal(response.headers.get('X-Content-Type-Options'), 'nosniff');
  assert.equal(response.headers.get('X-Robots-Tag'), 'noindex, nofollow');
  assert.equal(response.headers.get('Vary'), 'Accept-Encoding');
  assert.equal(response.headers.get('Content-Security-Policy'), null);
  const body = Buffer.from(await response.arrayBuffer());
  assert.deepEqual(body, brotliCompressSync(RAW), 'passed through as stored');
  // The stored sibling is read without content negotiation.
  assert.equal(env.seen.find((s) => s.path.endsWith('.br')).acceptEncoding, null);
});

test('gzip-only clients get the gzip sibling; clients without compression the decoded module', async () => {
  const gz = await get(fakeEnv(), MODULE, 'gzip');
  assert.equal(gz.headers.get('Content-Encoding'), 'gzip');
  assert.deepEqual(Buffer.from(await gz.arrayBuffer()), gzipSync(RAW));
  const identity = await get(fakeEnv(), MODULE, null);
  assert.equal(identity.headers.get('Content-Encoding'), null);
  assert.equal(identity.headers.get('Content-Type'), 'application/wasm');
  assert.deepEqual(Buffer.from(await identity.arrayBuffer()), RAW);
  const head = await get(fakeEnv(), MODULE, 'br', 'HEAD');
  assert.equal(head.headers.get('Content-Encoding'), 'br');
  assert.equal(await head.text(), '');
});

test('a public build drops X-Robots-Tag; other misses fall through to the assets (404)', async () => {
  const response = await get(fakeEnv('public'), MODULE, 'br');
  assert.equal(response.headers.get('X-Robots-Tag'), null);
  assert.equal((await get(fakeEnv(), '/assets/missing.js', 'br')).status, 404);
  assert.equal((await get(fakeEnv(), '/assets/other-1.wasm', 'br')).status, 404);
});
