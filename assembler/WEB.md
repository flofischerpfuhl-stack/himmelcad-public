# HimmelCAD Assembler in the browser (PWA)

Status: Block 8 web stream, branch `asm/b8-web-20261001` (2026-10-01). The web
version exists, passes its e2e tests in Chromium and a smoke test in Firefox and
WebKit, and is ready for static hosting on a himmelcad.com subdomain
([ROADMAP-LATER.md](ROADMAP-LATER.md) §1). **Nothing is deployed**; hosting
requirements: [`apps/assembler-web/deploy/README.md`](../apps/assembler-web/deploy/README.md).

## 1. What it is

`apps/assembler-web` is a second product composed from the same modules as the
desktop app ([MODULES.md](MODULES.md)): the same module list
(`app/composition.ts`), UI parts (`app/uiComposition.ts`), kernel worker
(`app/kernel.worker.ts`), sketch-solver worker, shell and agent API. It adds only
what differs in a browser:

| Part             | Where                                                         | Does                                                                                                                                                 |
| ---------------- | ------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| Composition root | `src/main.tsx`, `src/installHost.ts`                          | Installs the web host first, then the desktop's wiring (kernel/solver workers, fonts, module runtime), `beforeunload` guard, service worker, chrome. |
| Web host         | `src/host/*`                                                  | The platform host contract (below) for the browser.                                                                                                  |
| PWA              | `src/pwa/*`, `sw/sw.js`, `public/manifest.webmanifest`        | Service worker registration, update prompt, offline badge; manifest with file handler for `.hcasm`.                                                  |
| Build            | `vite.config.ts`, `scripts/postbuild.mjs`                     | Vite build (OCCT module from the verified cache), icons, CSP meta; then licences, source offer, `sw.js`, `_headers`, `build-info.json`, `.br`/`.gz`. |
| Reference server | `scripts/serve.mjs`, `scripts/headers.mjs`, `scripts/csp.mjs` | Headers and compression a host must provide; used by `pnpm preview` and the e2e tests.                                                               |

The module check covers the web product: `modules.json` lists its source root
(`../assembler-web/src`) and module `web` (product layer); products may not
import Electron. `pnpm check:assembler-modules`: 26 modules, 0 violations.

## 2. Platform host contract

Everything Electron-specific went behind one interface,
`renderer/src/foundation/host/host.ts` (`AssemblerHost`, new foundation module
`host`, the lowest one): `files` (open project, open binary, save, export),
`recovery`, `window` (close request, files opened from outside),
`recentFiles | null`, `slicers | null`, `automation | null`, and
`unavailableReason(capability)` for disabled entries. Consumers read
`host()` — `document/persistence.ts` (unchanged API for its callers), the
printers module (slicers), the agent-api (`automationStore.ts`), the Home screen
(recent list text), Help › About (licence links on the web).

| Implementation                           | Used by                                               | Notes                                                                                                      |
| ---------------------------------------- | ----------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `desktopHost.ts`                         | Electron app (default when `window.assembler` exists) | Adapter over the preload bridge; the former `isElectron()` branches, unchanged.                            |
| `browserHost.ts`                         | `pnpm dev:web`, tests under Node, web fallback        | File input, downloads, `localStorage` recovery; the former browser branches (plus `cancel` on the picker). |
| `apps/assembler-web/src/host/webHost.ts` | the web product (installed explicitly)                | See §3.                                                                                                    |

## 3. Desktop vs. web

| Capability                             | Desktop (Electron)                             | Web                                                                                                                                                                                                              |
| -------------------------------------- | ---------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Open project                           | Native dialog                                  | Chromium: File System Access picker (handle kept → Save writes in place). Safari/Firefox: file upload.                                                                                                           |
| Save / Save As                         | Atomic write + `.bak1..3`                      | Chromium: save picker, then in place through the handle (the browser writes a swap file and replaces on close; no backups). Safari/Firefox: download each time.                                                  |
| Recent projects (Home, File menu)      | Paths in `userData`, missing files, Locate…    | Chromium: up to 8 file handles in IndexedDB, thumbnail from the file, "On this device"; permission asked on click; Locate… relinks. Elsewhere: hidden, the Home screen says why.                                 |
| Recovery / autosave                    | `userData` file                                | IndexedDB (`localStorage` fallback); written only while there are unsaved changes.                                                                                                                               |
| Leaving with unsaved changes           | In-app dialog on window close                  | Browser's own "Leave site?" prompt (`beforeunload`); the recovery copy stays.                                                                                                                                    |
| Open `.hcasm` from the OS              | File association, single instance              | Installed PWA in Chromium: manifest `file_handlers` + `launchQueue` ("Open with").                                                                                                                               |
| Import STEP/IGES/STL/3MF/DXF/OBJ       | Browser picker                                 | Same (file input).                                                                                                                                                                                               |
| Export STL/3MF/STEP/IGES/DXF/PNG       | Native save dialog                             | Chromium: save picker (a picker refused because the click is >5 s ago falls back to a download). Elsewhere: download.                                                                                            |
| Open in Slicer                         | Detected/registered slicers, temp 3MF, `spawn` | Downloads the 3MF with a notice; the Slicers… dialog explains. Protocol links (`bambustudio://`, `orcaslicer://open?file=`) need an http(s) URL the slicer downloads from — a local model has none, so not used. |
| Agent access                           | Loopback HTTP endpoint + token (Python SDK)    | In-page API `window.himmelcadAssembler.agent.request(body)` while Agent Access is on (§6).                                                                                                                       |
| Settings, print settings, build volume | `localStorage` of the Electron profile         | `localStorage` of the origin; the app asks for persistent storage (`navigator.storage.persist()`).                                                                                                               |
| Fonts                                  | Bundled Inter (sketch text), theme fonts       | Same files, precached.                                                                                                                                                                                           |
| Phone-sized windows                    | —                                              | Items and History start closed below 700 px width (the shell has no phone layout).                                                                                                                               |

Nothing is a dead button: unavailable recent projects are hidden with a reason,
"Open in Slicer" downloads (and says so), Agent Access works in-page.

## 4. Offline, caching, updates

- `sw/sw.js` (hand-written, no Workbox) is completed by the postbuild with the
  precache list (every file of the build, 44 files / 27.7 MB) and a version
  derived from the content hashes; cache `hc-assembler-<version>`.
- Precached `.wasm` files are checked against their SHA-256 from the build
  before a version is accepted.
- Cache first for everything precached; navigations inside the scope get the
  cached `index.html`. Works offline after the first load (e2e: server stopped,
  browser offline, reload → app, kernel and sketch solver start).
- The worker is registered once the kernel has loaded, and fetches
  content-hashed assets with the default cache mode: the 25 MB module comes from
  the HTTP cache instead of being downloaded twice (first visit 6.9 MB instead
  of 13.5 MB).
- Updates install in the background; the running app keeps its version until
  the user presses **Reload** on "A new version of Assembler is ready". A
  version activated in another tab also offers the reload. Checks: on start and
  when the app returns to the foreground (at most hourly).
- First install: "Assembler now works offline. Projects stay on this device."
  Offline: a small "Offline" badge (bottom right, the corner the shell leaves
  free).

## 5. WebAssembly loading

- The kernel worker now streams the OCCT module through a byte counter into
  `WebAssembly.instantiateStreaming` (Emscripten `instantiateWasm` hook):
  compilation overlaps the download, no second 25 MB buffer, progress stays in
  the status strip ("Loading CAD kernel… 12.3 of 24.2 MB"). With
  `Content-Encoding` the total is unknown (indeterminate progress, MB counter).
  Shared with the desktop app (`geometry-kernel/workerRuntime.ts`).
- Precompressed siblings: OCCT 25.3 MB → 6.1 MB brotli (quality 9) / 7.8 MB
  gzip; the whole first visit transfers 6.9 MB.
- No `SharedArrayBuffer`, no threads: no COOP/COEP requirement.

## 6. Security

- Document: strict CSP as `<meta>` (any host) and as header
  (`frame-ancestors 'none'` only works there): `script-src 'self'`, no
  `unsafe-eval`, no `wasm-unsafe-eval`, every source `'self'` — no third-party
  request is possible. e2e checks the header, the meta and that string eval is
  actually blocked in the page.
- Workers: the kernel and solver workers (and the LGPL glue they import) need
  `'unsafe-eval' 'wasm-unsafe-eval'` (Emscripten embind builds invokers with
  `new Function`), exactly as on desktop. A dedicated worker takes the policy of
  its own script response (CSP 3), so the relaxation is scoped to those files
  by response headers. Verified in Chromium, Firefox and WebKit: the kernel
  needs eval and loads under the strict document policy in all three, so none
  of them hands the document's policy to the worker. Where a host
  sends no headers, the service worker attaches them to every cached response;
  only the very first load's workers then run without their own policy. There
  is no way to scope a policy per worker from the page itself — documented
  trade-off, no weakening of the document's policy.
- Other workers (print, import) get the strict policy.
- `COOP: same-origin`, `CORP: same-origin`, `nosniff`, `no-referrer`, a
  restrictive `Permissions-Policy`.

### Agent API in the browser

A web page cannot listen on a socket, so the desktop's loopback endpoint and the
Python SDK do not apply. Instead "Agent Access" (same command, same indicator,
off on every start) defines `window.himmelcadAssembler.agent`:

```js
const res = await window.himmelcadAssembler.agent.request({
  jsonrpc: '2.0',
  id: 1,
  method: 'bodies.list',
  params: {},
});
```

It is the same `hcasm.agent-api@1` session (`AgentSession` on the app's store
and kernel, unsaved-work guard, project open/new/save) that the desktop endpoint
uses. Reachable only by code running in the page: Playwright/automation, the
devtools console, a browser extension the user installed. No token (nothing
outside the page can call it; the CSP admits no foreign script). The dev-only
`window.__assembler` hook is not in production builds.

## 7. Tests and measurements

- `pnpm --filter @himmelcad/assembler-web test` — postbuild/CSP/header unit tests.
- `pnpm --filter @himmelcad/assembler-web test:e2e` — builds, then against the
  static site in Chromium: first/warm load with CSP and service worker; offline
  reload incl. sketch solver; sketch → extrude in the UI, Save/Open through
  download/upload, STL export; File System Access save in place + recent project
  after reload (pickers replaced by origin-private-file-system handles); update
  flow; tablet/phone layouts with touch.
- `test:e2e:browsers` — Firefox and WebKit smoke with the local Playwright
  builds (skipped where none is installed; nothing is downloaded).
- Chromium: `ASM_CHROME`, else local Playwright revision 1234 (Chromium 151).
  playwright-core 1.61 is built for 149; with revision 1243 (Chromium 153) the
  page object closes as soon as a file handle is stored in IndexedDB — a driver
  mismatch, the same steps pass with 151.

Measured 2026-10-01 on this PC (Ryzen 3 PRO 3200G, localhost, no throttling,
brotli, Chromium 151 headless with SwiftShader):

| Load                  | Time to the model on screen | Transferred                                               |
| --------------------- | --------------------------: | --------------------------------------------------------- |
| First (empty cache)   |                   1.8–2.1 s | 6.9 MB in 16 files (+0.08 MB for the precache afterwards) |
| Warm (service worker) |                   1.0–1.1 s | 0 bytes                                                   |

On a real connection the first load adds the transfer time of ~6.9 MB
(≈1.1 s at 50 Mbit/s). Screenshots: `D:\AgentWork\HimmelCAD-Assembler\shots\block8-web\`
(`w1-*` first load, `w2-*` offline, `w3-*` sketch/extrude, `w4-*` recent
projects, `w5-*` tablet/phone, `w6-*` Firefox/WebKit, `w7-*` update;
`web-load.json`).

## 8. LGPL

The web build ships the same separately replaceable files as the desktop build
(`assets/himmelcad_occt-*.{js,wasm}`, `assets/planegcs-*.{js,wasm}`), plus
`licenses/THIRD-PARTY-NOTICES.txt`, `licenses/SOURCE-OFFER.txt` and — for the
modified HimmelCAD OCCT module — its complete build recipe under
`licenses/source/occt-wasm/`, offered from the same place as the application
(LGPL-2.1 §6(d)); Help › About links both. A user can copy the static site,
replace a library and serve it (the offer says how, incl. the service worker's
checksum entry).

## 9. Other platforms

- **Linux desktop (AppImage/deb)**: not built in this block — the only WSL
  distribution on this PC (`Fernwork-PDF-Build`) belongs to Fernwork, and a new
  one needs a rootfs download, a full Linux `pnpm install` and the OCCT cache.
  Steps: Ubuntu 24.04 (WSL or a Linux host), Node 22 + pnpm 9, `pnpm install`,
  copy the verified module to `~/.cache/himmelcad/occt-wasm/8.0.1-hc.2/`, an
  `electron-builder.linux.yml` mirroring the Windows file (`files`,
  `asarUnpack` for the LGPL pairs and `licenses/**`, `extraResources`,
  `linux.target: [AppImage, deb]`, `linux.category: Graphics`,
  `fileAssociations` for `.hcasm`, `deb.depends` default), then
  `pnpm build && electron-builder --linux --x64 --publish never`; smoke with
  `ASSEMBLER_FORCE_PRODUCTION=1` and `test:electron` under Xvfb. Unsigned;
  AppImage needs `libfuse2` on the target.
- **macOS**: needs a Mac (no Mac host here): `electron-builder --mac` (dmg/zip,
  universal or arm64), `.hcasm` association; without a paid Apple Developer ID
  the app is unsigned and not notarized, so Gatekeeper requires
  right-click › Open or `xattr -dr com.apple.quarantine` — acceptable for testers,
  not for a release (owner decision: no purchased licences). Until then the web
  version is the macOS (and iPad) route.

## 10. Open items

- Not tried on a real iPad/Safari; WebKit on Windows passes the smoke test, but
  its view cube renders as a skewed single face (`w6-webkit-extrude.png`,
  viewport module).
- No phone layout in the shell (top bar runs under the view cube at 390 px);
  tablet layout, pen and touch parity are the touch stream's (§12 TP-\*, ROADMAP
  §1b).
- Recent projects and save in place only in Chromium (no File System Access in
  Safari/Firefox); no backups for in-place saves.
- The Python SDK cannot reach a browser tab (by design).
- Hosting: subdomain, TLS, headers per the deploy README, source offer kept with
  each deployed version.
