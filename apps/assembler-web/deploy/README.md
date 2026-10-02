# Hosting HimmelCAD Assembler (web)

The web build is a folder of static files: `pnpm --filter @himmelcad/assembler-web build`
writes it to `apps/assembler-web/dist/`. Nothing runs on the server; projects never leave
the user's device. This file lists what a host must do, then how it is done on Cloudflare.

**Deployed (2026-10-02):** a preview on Cloudflare Workers, project `himmelcad-assembler`
(account of flofischer.pfuhl@gmail.com), at
<https://himmelcad-assembler.flofischer-pfuhl.workers.dev>. The custom domain
`assembler.himmelcad.com` is not attached yet ([Attaching the domain](#attaching-assemblerhimmelcadcom)).
The build is a **preview**: not indexed, "Preview" badge ([Going public](#going-public)).

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
| all, in a preview build (default; `build-info.json` `"release": "preview"`)                                                             | `X-Robots-Tag: noindex, nofollow` (with `<meta name="robots">` in `index.html` and a `robots.txt` that disallows everything)                                                                                                                                                                |

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
- Cloudflare Workers (below): compress on their own; the OCCT module's siblings are
  served by `deploy/worker.mjs`.

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

## Cloudflare (`himmelcad-assembler`)

A Workers project of its own with static assets (`../wrangler.jsonc`), next to — and
independent of — the main site's project `himmelcad` (`website/wrangler.jsonc`).

- **Assets**: every file of `dist/`, served by Cloudflare with the rules of the generated
  `dist/_headers` (Workers static assets read it like Pages does), except what the
  generated `dist/.assetsignore` excludes: the `.br`/`.gz` siblings (Cloudflare compresses
  on its own) and the **raw OCCT module**.
- **25 MiB per asset**: the OCCT module is 25,350,953 bytes (hc.3; hc.4 is 25,360,485),
  0.85 MB under the limit. Instead of waiting for a bump to break the deployment, it is
  never uploaded raw: `deploy/worker.mjs` (runs only for requests no asset matches)
  answers its URL with the brotli sibling (6.06 MB) and `Content-Encoding: br`, or the
  gzip sibling (7.73 MB) for gzip-only clients, or decodes the gzip sibling for clients
  without compression — always `Content-Type: application/wasm` and the build's headers
  (`scripts/headers.mjs`). The body passes through as stored (`encodeBody: 'manual'`);
  the service worker checks the decoded module against its SHA-256. The postbuild fails if
  any uploaded file exceeds 25 MiB or a sibling is missing.
- **Deploy by hand** (wrangler logged in to the owner's account):

  ```bash
  pnpm --filter @himmelcad/assembler-web build
  cd apps/assembler-web && npx wrangler deploy
  ```

  52 assets are uploaded (13 MB), deploys take about 2 minutes here.

Verified on the preview URL (2026-10-02, `curl` and the e2e tests with `ASM_WEB_URL`):

| Check                            | Result                                                                                                                                                                                              |
| -------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/` (document)                   | strict CSP with `frame-ancestors 'none'`, `no-cache`, COOP/CORP, `nosniff`, `no-referrer`, `Permissions-Policy`, `X-Robots-Tag`                                                                     |
| kernel/solver workers, LGPL glue | worker CSP (`'unsafe-eval' 'wasm-unsafe-eval'`) only on those files, immutable caching                                                                                                              |
| other `assets/*`                 | immutable, no CSP of their own                                                                                                                                                                      |
| OCCT module                      | `application/wasm`, `Content-Encoding: br` (6,059,549 bytes on the wire), immutable, `Vary: Accept-Encoding`; decoded SHA-256 = the build's (`d28d42fa…5317`); gzip and identity fallbacks verified |
| planeGCS module                  | `application/wasm`, served by Cloudflare (br)                                                                                                                                                       |
| `robots.txt`, robots meta        | `Disallow: /`, `noindex, nofollow`                                                                                                                                                                  |
| source offer                     | `licenses/THIRD-PARTY-NOTICES.txt`, `licenses/SOURCE-OFFER.txt`, `licenses/source/occt-wasm/*` all 200; About links open them                                                                       |

Cloudflare's own behaviour, harmless but different from `scripts/serve.mjs`:
`/index.html` redirects (307) to `/` (default `html_handling`); files without a rule
(`manifest.webmanifest`, icons, licences) get `Cache-Control: public, max-age=0,
must-revalidate` (same effect as `no-cache`); `Content-Type` comes from Cloudflare
(`text/html`, `text/javascript` without charset; `.sh` files as `application/x-sh`, so the
browser downloads `build.sh` instead of showing it); the `planegcs-*` rule also puts the
worker CSP on `planegcs-*.wasm` (ignored for non-scripts).

### Attaching `assembler.himmelcad.com`

Owner step (the zone `himmelcad.com` is on the same account). Either the dashboard:
Workers & Pages → `himmelcad-assembler` → Settings → Domains & Routes → Add → Custom
domain → `assembler.himmelcad.com` (Cloudflare creates the DNS record and certificate);
or in `wrangler.jsonc`

```jsonc
"routes": [{ "pattern": "assembler.himmelcad.com", "custom_domain": true }],
```

and `npx wrangler deploy`. Afterwards `workers_dev` may be set to `false` to retire the
preview URL. Nothing of the main site's project changes. The installed app's identity is
its origin: an app installed from the workers.dev preview stays a separate app.

### Going public

The build is a preview unless `HIMMELCAD_WEB_PUBLIC=1` is set while building
(`pnpm --filter @himmelcad/assembler-web build`, or as a Workers Builds variable). The
public build has no robots meta, no `X-Robots-Tag`, a `robots.txt` that allows crawling,
no "Preview" badge on Home and in About, and `build-info.json` `"release": "public"`
(which the worker reads for its own responses). Rebuild and deploy; nothing else changes.

## Automatic deployment (Workers Builds)

`main` contains the Assembler since 2026-10-02. Workers Builds runs on Cloudflare's Linux
build machines and cannot reach the local OCCT cache (`D:\AgentWork\HimmelCAD-Assembler\occt-wasm`),
and the module is never committed (owner decision 2026-09-30; it is also too close to Git
hosting and asset limits). The build therefore fetches it from a **versioned release
asset** and checks it against `vendor/occt-wasm/artifacts.sha256`
(`scripts/fetch-occt-module.mjs`; a wrong or missing file fails the build).

1. **Publish the module once per version** (now `8.0.1-hc.3`; again for `hc.4` when
   `vendor/occt-wasm/package.json` moves) to the GitLab generic package registry of
   `florian-fischer-group/himmelcad` (a token with `api` scope, from the verified cache):

   ```bash
   V=8.0.1-hc.3; D=~/.cache/himmelcad/occt-wasm/$V   # Windows: D:\AgentWork\HimmelCAD-Assembler\occt-wasm\$V
   for F in himmelcad_occt.js himmelcad_occt.wasm; do
     curl --fail --header "PRIVATE-TOKEN: $GITLAB_TOKEN" --upload-file "$D/$F" \
       "https://gitlab.com/api/v4/projects/florian-fischer-group%2Fhimmelcad/packages/generic/himmelcad-occt-wasm/$V/$F"
   done
   ```

   The package is LGPL object code next to its published recipe (`vendor/occt-wasm`), like
   the copy on the site. Then create a **deploy token** (Settings → Repository → Deploy
   tokens) with the scope `read_package_registry` only.

2. **Connect the project** (after the first manual deploy, so the Worker exists): Workers &
   Pages → `himmelcad-assembler` → Settings → Builds → Connect → GitLab →
   `florian-fischer-group/himmelcad`.

   | Setting                 | Value                                                                                                                                                                                                                                                                                                                                                                                                                                 |
   | ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
   | Production branch       | `main`                                                                                                                                                                                                                                                                                                                                                                                                                                |
   | Root directory          | `apps/assembler-web`                                                                                                                                                                                                                                                                                                                                                                                                                  |
   | Build command           | `cd ../.. && pnpm install --frozen-lockfile --ignore-scripts --filter "@himmelcad/assembler-web..." && node apps/assembler-web/scripts/fetch-occt-module.mjs && pnpm --filter @himmelcad/assembler-web build`                                                                                                                                                                                                                         |
   | Deploy command          | `npx wrangler deploy` (default)                                                                                                                                                                                                                                                                                                                                                                                                       |
   | Non-production branches | off (`preview_urls` is off in `wrangler.jsonc`)                                                                                                                                                                                                                                                                                                                                                                                       |
   | Build watch paths       | include `apps/assembler-web/*`, `apps/assembler/*`, `packages/*`, `vendor/occt-wasm/*`, `branding/logos/source/*`, `pnpm-lock.yaml`, `package.json` (other products' pushes do not rebuild)                                                                                                                                                                                                                                           |
   | Build variables         | `HIMMELCAD_OCCT_URL` = `https://gitlab.com/api/v4/projects/florian-fischer-group%2Fhimmelcad/packages/generic/himmelcad-occt-wasm/{version}/{file}`; `HIMMELCAD_OCCT_TOKEN` (secret) = the deploy token; `HIMMELCAD_OCCT_TOKEN_HEADER` = `Deploy-Token`; `SKIP_DEPENDENCY_INSTALL` = `1` (the command installs, filtered and without lifecycle scripts: no Electron download, no PhotoLab models); later `HIMMELCAD_WEB_PUBLIC` = `1` |

   Node comes from `.nvmrc` (22), pnpm from `packageManager` (9.12.0). The Worker name in
   `wrangler.jsonc` must stay `himmelcad-assembler`. The main site's project and its
   settings are not touched.

3. Push to `main` (a path above) → build → deploy. Check the first build log for the
   install step and the line `occt-wasm 8.0.1-hc.3: himmelcad_occt.wasm 24.2 MB verified`.

Rehearsed here (not on Cloudflare): a fresh `--depth 1` clone, the build command above with
the module served by a local stand-in for the package registry (`Deploy-Token` header):
9 min 10 s on this PC, the same build version as the deployed one (`1dbe44e9cfef1010`), and
`wrangler deploy --dry-run` accepts the configuration.

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

Done on the workers.dev preview on 2026-10-02 (the same checks for the custom domain):

- [x] `https://…/` loads, the kernel loads ("Loading CAD kernel…" disappears).
- [x] Service worker activated; Cache storage `hc-assembler-<version>` with 47 entries.
- [x] Offline and reload: the app starts, kernel and sketch solver from the cache.
- [x] Response headers as in the table, the OCCT module with `application/wasm` and
      `Content-Encoding: br`.
- [x] Help › About › third-party notices and source offer open.
- [x] `ASM_WEB_URL=<url> node --test e2e/web.e2e.test.mjs e2e/pwa.e2e.test.mjs` and
      `e2e/otherBrowsers.e2e.test.mjs` (Firefox, WebKit) pass against the site.
- [ ] Custom domain attached; `ASM_WEB_URL=https://assembler.himmelcad.com/` re-run.
- [ ] Announcement: `HIMMELCAD_WEB_PUBLIC=1` ([Going public](#going-public)).
