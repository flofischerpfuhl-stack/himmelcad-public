/**
 * Cloudflare Worker in front of the static assets of HimmelCAD Assembler (web)
 * (`../wrangler.jsonc`; deploy/README.md "Cloudflare").
 *
 * Cloudflare serves every uploaded file itself, with the rules of the generated
 * `_headers`; this script only runs for requests no asset matches. Its one job:
 * the OCCT module. Cloudflare takes at most 25 MiB per asset and the module is
 * 25.3 MB (24.2 MiB) today, so it is not uploaded raw (`dist/.assetsignore`). A
 * request for it gets the precompressed sibling the build writes anyway:
 *
 * - `Accept-Encoding: br` → `<module>.wasm.br` (6.1 MB) with `Content-Encoding: br`;
 * - `gzip` → `<module>.wasm.gz` (7.8 MB) with `Content-Encoding: gzip`;
 * - neither → the gzip sibling, decompressed here.
 *
 * Always `Content-Type: application/wasm` (streaming compilation needs it) and the
 * build's headers for the file (`scripts/headers.mjs`: immutable caching, nosniff,
 * COOP/CORP, `X-Robots-Tag` in a preview build). The bytes are the build's: the
 * service worker checks the decoded module against its SHA-256. The body is passed
 * through as encoded (`encodeBody: 'manual'`), never re-compressed.
 */
import { headersFor } from '../scripts/headers.mjs';

/** Whether the deployed build is a preview (`build-info.json` `release`), read once per `env`. */
const previews = new WeakMap();

function noindex(env, url) {
  if (!previews.has(env)) {
    previews.set(
      env,
      env.ASSETS.fetch(new URL('/build-info.json', url))
        .then((response) => (response.ok ? response.json() : {}))
        .then(
          (info) => info.release !== 'public',
          () => true,
        ),
    );
  }
  return previews.get(env);
}

/** Reads an uploaded file exactly as stored (no content negotiation on the way). */
const storedAsset = (env, url, path) =>
  env.ASSETS.fetch(new Request(new URL(path, url), { method: 'GET' }));

export async function serveWasm(request, env) {
  const url = new URL(request.url);
  const path = decodeURIComponent(url.pathname);
  const accept = request.headers.get('Accept-Encoding') ?? '';
  const headers = new Headers(
    headersFor(path.replace(/^\//, ''), { noindex: await noindex(env, url) }),
  );
  headers.set('Vary', 'Accept-Encoding');
  const head = request.method === 'HEAD';
  for (const [encoding, suffix] of [
    ['br', '.br'],
    ['gzip', '.gz'],
  ]) {
    if (!new RegExp(`(^|[\\s,])${encoding}($|[\\s,;])`).test(accept)) continue;
    const asset = await storedAsset(env, url, `${path}${suffix}`);
    if (!asset.ok) continue;
    headers.set('Content-Encoding', encoding);
    const length = asset.headers.get('Content-Length');
    if (length) headers.set('Content-Length', length);
    return new Response(head ? null : asset.body, { status: 200, headers, encodeBody: 'manual' });
  }
  // A client that takes no compression (rare: scripts, old proxies) gets the module decoded.
  const gzip = await storedAsset(env, url, `${path}.gz`);
  if (!gzip.ok || !gzip.body) return null;
  return new Response(head ? null : gzip.body.pipeThrough(new DecompressionStream('gzip')), {
    status: 200,
    headers,
  });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if ((request.method === 'GET' || request.method === 'HEAD') && url.pathname.endsWith('.wasm')) {
      const response = await serveWasm(request, env);
      if (response) return response;
    }
    // Anything else no asset matched: Cloudflare's own 404 (the app is one page; the
    // service worker answers in-app navigations from its cache).
    return env.ASSETS.fetch(request);
  },
};
