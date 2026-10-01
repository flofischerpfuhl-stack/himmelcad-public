# Hosting HimmelCAD Assembler (web)

The web build is a folder of static files: `pnpm --filter @himmelcad/assembler-web build`
writes it to `apps/assembler-web/dist/`. Nothing runs on the server; projects never leave
the user's device. This file lists what a host must do. Nothing has been deployed yet —
no hosting, DNS or certificate exists for it.

## Build inputs

- The OCCT module is copied from the local artifact cache after its SHA-256 check
  (`vendor/occt-wasm/artifacts.sha256`, as for the desktop build). A build machine
  without the cache fails; `HIMMELCAD_OCCT=replicad` builds with the npm module
  instead (the source offer then only lists unmodified libraries).
- Base path: the build is relative and works at any path (`https://assembler.himmelcad.com/`
  or `https://himmelcad.com/assembler/`). `HIMMELCAD_WEB_BASE=/assembler/` pins an
  absolute one if a host needs it (it also prefixes the generated `_headers`).
- Output: about 29 MB (25.3 MB of it the OCCT module), 44 files, plus `.br`/`.gz` siblings.
  `build-info.json` names the version (the service worker's cache name), the OCCT module and
  the wasm checksums.

## Requirements

1. **HTTPS** (or `http://localhost`). Service workers, the File System Access API and
   `crypto.subtle` need a secure context.
2. **MIME types**: `.wasm` → `application/wasm` (required: streaming compilation refuses
   anything else), `.webmanifest` → `application/manifest+json`, `.js` →
   `text/javascript`, `.woff` → `font/woff`.
3. **Trailing slash**: `/assembler` must redirect to `/assembler/` (relative URLs).
4. **No rewriting** of `.wasm` and `.js` files (no "auto minify", no script injection,
   no analytics snippet): the service worker checks the wasm checksums, and an injected
   script would be blocked by the CSP anyway.
5. **No third-party requests** are made by the app; do not add any (fonts, analytics,
   error reporting) — the CSP forbids them.

## Headers

`scripts/headers.mjs` is the reference (used by the local server `pnpm preview` and the
e2e tests); `dist/_headers` is the same for Netlify and Cloudflare Pages.

| Files                                                                                                                                   | Header                                                                                                                                                                                                                                                                                      |
| --------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| all                                                                                                                                     | `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`, `Cross-Origin-Opener-Policy: same-origin`, `Cross-Origin-Resource-Policy: same-origin`, `Permissions-Policy: camera=(), microphone=(), geolocation=(), payment=(), usb=(), serial=()`                                    |
| `index.html` (and the directory URL)                                                                                                    | `Content-Security-Policy: default-src 'self'; script-src 'self'; worker-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self'; connect-src 'self'; manifest-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'` |
| `assets/kernel.worker-*`, `assets/solver.worker-*`, `assets/himmelcad_occt-*.js`, `assets/replicad_single-*.js`, `assets/planegcs-*.js` | `Content-Security-Policy: default-src 'self'; script-src 'self' 'unsafe-eval' 'wasm-unsafe-eval'; worker-src 'self'; connect-src 'self'; img-src 'self' data:; font-src 'self'; object-src 'none'; base-uri 'none'`                                                                         |
| `assets/*`                                                                                                                              | `Cache-Control: public, max-age=31536000, immutable` (content-hashed names)                                                                                                                                                                                                                 |
| everything else (`index.html`, `sw.js`, `manifest.webmanifest`, `icons/*`, `licenses/*`, `build-info.json`)                             | `Cache-Control: no-cache`                                                                                                                                                                                                                                                                   |

Notes:

- **Never give a worker two CSP headers.** Hosts that merge rules (`_headers` files,
  nginx `add_header` in nested blocks) would intersect them to the strict policy and stop
  the CAD kernel ("CAD kernel failed to load"). The worker policy goes only on the files
  above; the strict one on `index.html`.
- The document also carries the strict policy as a `<meta>` tag, and the service worker
  attaches the right policy to every response it serves from its cache. A host that sends
  no CSP at all therefore still runs the document strictly; only the very first load's
  workers then run without a policy of their own (same-origin code only either way).
- **No COOP/COEP isolation** is needed: nothing uses `SharedArrayBuffer` (both wasm
  modules are single-threaded). `COOP: same-origin` above is hardening, not a requirement.
- `sw.js` must not be cached by the HTTP cache (`no-cache`), or updates are delayed.

## Compression

Serve the precompressed siblings when the client accepts them (`Content-Encoding: br`
or `gzip`, `Vary: Accept-Encoding`): the OCCT module is 25.3 MB raw, 6.1 MB brotli,
7.8 MB gzip. A first visit transfers about 6.9 MB with brotli.

- nginx: `brotli_static on; gzip_static on;` (brotli needs the ngx_brotli module).
- Caddy: `file_server { precompressed br gzip }`.
- Netlify / Cloudflare Pages: compress on their own (ignore the siblings).

## Example: nginx

```nginx
server {
  listen 443 ssl http2;
  server_name assembler.himmelcad.com;
  root /srv/assembler-web;           # the contents of dist/

  types { application/wasm wasm; application/manifest+json webmanifest; }
  brotli_static on;
  gzip_static on;

  add_header X-Content-Type-Options nosniff always;
  add_header Referrer-Policy no-referrer always;
  add_header Cross-Origin-Opener-Policy same-origin always;
  add_header Cross-Origin-Resource-Policy same-origin always;

  location = /index.html { add_header Cache-Control no-cache always; add_header Content-Security-Policy "<document policy>" always; }
  location = /sw.js      { add_header Cache-Control no-cache always; }
  location ~ ^/assets/(kernel\.worker|solver\.worker|himmelcad_occt|replicad_single|planegcs)-.*\.js$ {
    add_header Cache-Control "public, max-age=31536000, immutable" always;
    add_header Content-Security-Policy "<worker policy>" always;
  }
  location /assets/ { add_header Cache-Control "public, max-age=31536000, immutable" always; }
  location / { try_files $uri $uri/index.html =404; add_header Cache-Control no-cache always; }
}
```

(`add_header` inside a `location` replaces the server-level ones — repeat the common
headers there, or use an `include` snippet.)

## LGPL (OCCT, planeGCS)

The site itself offers the source: `licenses/THIRD-PARTY-NOTICES.txt`,
`licenses/SOURCE-OFFER.txt` and, for the HimmelCAD OCCT module, its build recipe in
`licenses/source/occt-wasm/` (linked from Help › About). Keep these files deployed for as
long as the version that ships the module is served, and keep each deployment's files
together (the recipe must match the shipped module). The libraries stay separate,
replaceable files (`assets/himmelcad_occt-*.{js,wasm}`, `assets/planegcs-*.{js,wasm}`);
the source offer explains how a user replaces them in a copy of the site.

## Updates

Deploy a new build by replacing the whole folder (atomically if possible: old hashed
assets may be removed once the new `index.html`/`sw.js` are live, but a page that is
already running loads lazy chunks from its own service-worker cache, so it does not need
the old files). Running apps notice the new `sw.js` on their next start or when they come
back to the foreground (hourly), download it in the background and offer
"A new version of Assembler is ready · Reload".

## Checklist before going live

- [ ] `https://…/` loads, the kernel loads ("Loading CAD kernel…" disappears).
- [ ] DevTools › Application › Service workers: activated; Cache storage
      `hc-assembler-<version>` with 44 entries.
- [ ] Offline (DevTools › Network › Offline) and reload: the app starts.
- [ ] Response headers as in the table (`curl -I`), `.wasm` with `application/wasm`
      and `Content-Encoding: br`.
- [ ] Help › About › third-party notices and source offer open.
- [ ] `pnpm --filter @himmelcad/assembler-web test:e2e` passed on the exact build.
