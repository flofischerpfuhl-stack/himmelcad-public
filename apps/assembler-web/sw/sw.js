/* HimmelCAD Assembler service worker (template; `scripts/postbuild.mjs`
 * replaces the three placeholders below and writes `dist/sw.js`).
 *
 * - Precache: every file of the build (app shell, JS, CSS, fonts, icons, the
 *   OCCT and planeGCS WebAssembly modules, license texts and the LGPL source
 *   offer) under one cache per build (`hc-assembler-<version>`). The
 *   `.wasm` files are checked against their SHA-256 from the build before
 *   the version is accepted.
 * - Fetch: cache first for everything precached; navigations get the cached
 *   `index.html` (the app works offline after the first load); anything else
 *   goes to the network.
 * - Headers: responses from the cache carry the build's CSP (strict for the
 *   document and ordinary scripts, the worker policy for the kernel and
 *   solver workers), so the policy holds even on hosts that send none.
 * - Updates: a new version installs in the background and waits until the
 *   page asks it to take over (`SKIP_WAITING`, the "Reload" button); the
 *   first install takes control at once.
 */
/* global self, caches, crypto, URL, Response, Headers */
'use strict';

const VERSION = '__HC_VERSION__';
/** @type {{ url: string, sha256?: string }[]} */
const PRECACHE = __HC_PRECACHE__;
/** @type {{ document: string, documentHeader: string, worker: string, workerPrefixes: string[] }} */
const CSP = __HC_CSP__;

const CACHE_PREFIX = 'hc-assembler-';
const CACHE = `${CACHE_PREFIX}${VERSION}`;
const SCOPE = new URL(self.registration.scope);
const INDEX_URL = new URL('index.html', SCOPE).href;
const PRECACHED = new Set(PRECACHE.map((entry) => new URL(entry.url, SCOPE).href));

const MIME = {
  html: 'text/html; charset=utf-8',
  js: 'text/javascript; charset=utf-8',
  css: 'text/css; charset=utf-8',
  json: 'application/json; charset=utf-8',
  webmanifest: 'application/manifest+json; charset=utf-8',
  wasm: 'application/wasm',
  png: 'image/png',
  svg: 'image/svg+xml',
  woff: 'font/woff',
  woff2: 'font/woff2',
  ttf: 'font/ttf',
  txt: 'text/plain; charset=utf-8',
  md: 'text/plain; charset=utf-8',
};

function extensionOf(pathname) {
  const name = pathname.split('/').pop() || '';
  const dot = name.lastIndexOf('.');
  return dot < 0 ? '' : name.slice(dot + 1).toLowerCase();
}

/** The CSP a cached response is served with (`scripts/csp.mjs`). */
function cspFor(pathname) {
  const name = pathname.split('/').pop() || '';
  const ext = extensionOf(pathname);
  if (ext === 'html') return CSP.documentHeader;
  if (ext === 'js') {
    return CSP.workerPrefixes.some((prefix) => name.startsWith(prefix)) ? CSP.worker : CSP.document;
  }
  return null;
}

async function sha256Hex(buffer) {
  const digest = await crypto.subtle.digest('SHA-256', buffer);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Stores a response with clean headers: the body is already decoded, so a
 * `Content-Encoding`/`Content-Length` of the transfer must not travel with it.
 */
async function cacheable(url, response, expectedSha256) {
  const body = await response.arrayBuffer();
  if (expectedSha256) {
    const actual = await sha256Hex(body);
    if (actual !== expectedSha256) {
      throw new Error(`${url}: SHA-256 ${actual}, expected ${expectedSha256}`);
    }
  }
  const pathname = new URL(url).pathname;
  const headers = new Headers();
  headers.set(
    'Content-Type',
    MIME[extensionOf(pathname)] ||
      response.headers.get('Content-Type') ||
      'application/octet-stream',
  );
  headers.set('Content-Length', String(body.byteLength));
  headers.set('X-Content-Type-Options', 'nosniff');
  const csp = cspFor(pathname);
  if (csp) headers.set('Content-Security-Policy', csp);
  return new Response(body, { status: 200, statusText: 'OK', headers });
}

async function precache() {
  const cache = await caches.open(CACHE);
  // A few files at a time: the 25 MB kernel must not starve the small ones of bandwidth.
  const queue = PRECACHE.slice();
  const workers = Array.from({ length: 4 }, async () => {
    for (let entry = queue.shift(); entry; entry = queue.shift()) {
      const url = new URL(entry.url, SCOPE).href;
      // Content-hashed assets may come from the HTTP cache (the page just loaded them);
      // the rest revalidates so a new deployment never pairs with a stale index.html.
      const mode = entry.url.startsWith('assets/') ? 'default' : 'no-cache';
      const response = await fetch(url, { cache: mode, credentials: 'same-origin' });
      if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
      await cache.put(url, await cacheable(url, response, entry.sha256));
    }
  });
  await Promise.all(workers);
}

self.addEventListener('install', (event) => {
  event.waitUntil(
    precache().then(() => {
      // First install: take over at once. An update waits for the page's "Reload".
      if (!self.registration.active) return self.skipWaiting();
      return undefined;
    }),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      for (const name of await caches.keys()) {
        if (name.startsWith(CACHE_PREFIX) && name !== CACHE) await caches.delete(name);
      }
      await self.clients.claim();
    })(),
  );
});

self.addEventListener('message', (event) => {
  const type = event.data && event.data.type;
  if (type === 'SKIP_WAITING') void self.skipWaiting();
  else if (type === 'VERSION' && event.ports[0]) event.ports[0].postMessage({ version: VERSION });
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== SCOPE.origin || !url.href.startsWith(SCOPE.href)) return;
  const key = url.origin + url.pathname;
  // A precached file (also when opened as a page, e.g. a license text); else, for a
  // navigation, the app shell: the app has one page, so every other path inside the scope is it.
  const target = PRECACHED.has(key) ? key : request.mode === 'navigate' ? INDEX_URL : null;
  if (!target) return;
  event.respondWith(
    caches
      .open(CACHE)
      .then((cache) => cache.match(target))
      .then((cached) => cached || fetch(request)),
  );
});
