import { promises as fs } from 'node:fs';
import { extname, join, normalize, resolve } from 'node:path';

import { BrowserWindow, app, ipcMain, nativeImage, protocol } from 'electron';

import { registerAutomation, stopAutomation } from './automationIpc';
import { attachCloseGuard, readHcasmFile, registerFileApi } from './fileApi';
import { registerSlicerIpc } from './slicerIpc';
import { ASSEMBLER_APP_NAME, createMainWindowOptions } from './windowOptions';

/**
 * Picks the `.hcasm` path out of a process's `argv`, if any — used both for
 * this instance's own launch args (double-click file association, or a
 * plain CLI path) and for a second instance's forwarded argv
 * (`requestSingleInstanceLock`/`second-instance` below). Skips flag-shaped
 * args (`--foo`) and, in dev, the `electron .` script path.
 */
function hcasmPathFromArgv(argv: readonly string[]): string | null {
  const match = argv.find((arg) => !arg.startsWith('-') && arg.toLowerCase().endsWith('.hcasm'));
  return match ? resolve(match) : null;
}

async function openPathInWindow(win: BrowserWindow, path: string): Promise<void> {
  const opened = await readHcasmFile(path);
  if (opened) win.webContents.send('assembler:project:open-requested', opened.path, opened.text);
}

// `app.isPackaged` is only `true` from an installed build (electron-builder,
// `pnpm package:win`, `electron-builder.win.yml`). `ASSEMBLER_FORCE_PRODUCTION=1` lets the production
// smoke test (`test/electron/production.test.ts`, playwright-core
// `_electron`) exercise the packaged code path — the `app://` protocol,
// strict CSP and `dist/renderer` loading — from a plain `electron dist/electron/main.js`
// launch, without needing a full installer for every verification run.
const isDev = !app.isPackaged && process.env.ASSEMBLER_FORCE_PRODUCTION !== '1';

/**
 * Privileged custom protocol serving the packaged renderer, worker and
 * kernel wasm from `dist/renderer` in production. A packaged `file://`
 * renderer cannot reliably `fetch()` a co-located `.wasm` or load a module
 * worker (Chromium restricts both from `file:`); `app://` is a standard,
 * secure, fetch-capable scheme instead (`assembler/KERNEL-SPIKE.md`,
 * "Packaged Electron is unverified").
 */
const APP_SCHEME = 'app';
protocol.registerSchemesAsPrivileged([
  {
    scheme: APP_SCHEME,
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      corsEnabled: true,
      stream: true,
      allowServiceWorkers: false,
    },
  },
]);

const RENDERER_URL = isDev ? 'http://localhost:5175/' : `${APP_SCHEME}://assembler/index.html`;

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.wasm': 'application/wasm',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.map': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
};

// The main document never calls `eval`/`new Function`, nor does it
// instantiate WebAssembly directly (the kernel and its wasm only ever load
// inside the dedicated worker below) — so the main document keeps a strict
// CSP with neither 'unsafe-eval' nor 'wasm-unsafe-eval'.
const DOCUMENT_CSP =
  "default-src 'self'; script-src 'self'; worker-src 'self'; " +
  "style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; " +
  "connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none';";

// 'unsafe-eval' is required by the Emscripten-generated OCCT glue
// (`replicad-opencascadejs`), which uses `eval`/`new Function` beyond plain
// `WebAssembly.instantiate` (found by the production smoke test: without
// it, the packaged app's kernel fails to load with a CSP violation). Scoped
// to only the kernel Web Worker script and the LGPL Emscripten glue chunk it
// dynamically imports (`renderer/src/app/kernel.worker.ts`) — a worker
// loaded from a URL takes the CSP of its own response, not the document's,
// so this does not weaken the main document's CSP above. Still `'self'`-only
// — no remote script origin is ever allowed, so this does not permit loading
// remote code, only evaluating strings that ship inside the already-`'self'`
// -scoped bundle.
const WORKER_CSP =
  "default-src 'self'; script-src 'self' 'unsafe-eval' 'wasm-unsafe-eval'; worker-src 'self'; " +
  "style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; " +
  "connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none';";

// Vite build output for the kernel worker (`kernel.worker-<hash>.js`) and
// the LGPL Emscripten glue chunk it dynamically imports
// (`replicad_single-<hash>.js`) — both need `WORKER_CSP`; every other file
// (the main document, the React app bundle, styles, fonts, the .wasm binary
// itself) gets the strict `DOCUMENT_CSP`. Matched by filename prefix so a
// content hash change across builds does not need this list updated.
// The sketch-solver worker (`renderer/src/foundation/sketch-solver/solver.worker.ts`) and the
// LGPL planeGCS glue chunk it imports (`planegcs-<hash>.js`) need the same
// policy: planeGCS's Emscripten embind glue builds its invokers with
// `new Function` (`Function.apply`), found when the worker failed to load
// under a 'wasm-unsafe-eval'-only policy.
const WORKER_CSP_FILE_PREFIXES = [
  'kernel.worker-',
  'replicad_single-',
  // The HimmelCAD OCCT build's glue chunk (`HIMMELCAD_OCCT=himmelcad`, vendor/occt-wasm).
  'himmelcad_occt-',
  'solver.worker-',
  'planegcs-',
];

function cspFor(filePath: string): string {
  const base = filePath.replace(/\\/g, '/').split('/').pop() ?? '';
  return WORKER_CSP_FILE_PREFIXES.some((prefix) => base.startsWith(prefix))
    ? WORKER_CSP
    : DOCUMENT_CSP;
}

function registerAppProtocol(rendererDir: string): void {
  protocol.handle(APP_SCHEME, async (request) => {
    const url = new URL(request.url);
    let pathname = decodeURIComponent(url.pathname);
    if (pathname === '' || pathname === '/') pathname = '/index.html';
    const filePath = normalize(join(rendererDir, pathname));
    // Containment: never serve a path that escaped `rendererDir` (e.g. via `..`).
    if (!filePath.startsWith(normalize(rendererDir))) {
      return new Response('Forbidden', { status: 403 });
    }
    try {
      const data = await fs.readFile(filePath);
      const type = MIME_TYPES[extname(filePath).toLowerCase()] ?? 'application/octet-stream';
      return new Response(new Uint8Array(data), {
        status: 200,
        headers: { 'Content-Type': type, 'Content-Security-Policy': cspFor(filePath) },
      });
    } catch {
      return new Response('Not found', { status: 404 });
    }
  });
}

app.setName(ASSEMBLER_APP_NAME);

// `build/icon.png` (see `apps/assembler/scripts/generate-icon.mjs`) — a
// documented placeholder mark; same file electron-builder derives the
// installer/taskbar `.ico` from (`electron-builder.win.yml`). `__dirname`
// is `dist/electron` at runtime, so `../../build` reaches `apps/assembler/build`.
const applicationIcon = nativeImage.createFromPath(resolve(__dirname, '../../build/icon.png'));

let mainWindow: BrowserWindow | null = null;

/**
 * Per-user NSIS install with no admin prompt (`electron-builder.win.yml`
 * `nsis.perMachine: false`) still allows more than one Explorer/CLI launch
 * to race for the lock — take it before any window/IPC state exists so a
 * losing instance never partially initializes.
 */
const gotSingleInstanceLock = app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) {
  app.quit();
} else {
  // A second instance (e.g. double-clicking another .hcasm while the app is
  // already running) forwards its argv here instead of opening its own
  // window — the existing window opens the file and comes to the front.
  app.on('second-instance', (_event, argv) => {
    const path = hcasmPathFromArgv(argv);
    const win = mainWindow;
    if (!win) return;
    if (win.isMinimized()) win.restore();
    win.focus();
    if (path) void openPathInWindow(win, path);
  });

  // The `.hcasm` this instance was launched with (double-click association or
  // a command-line path). The renderer asks for it once its open listener is
  // mounted (`preload.ts` `onOpenRequested`) — a push on `did-finish-load`
  // could arrive before React mounted that listener.
  let pendingOpenPath = hcasmPathFromArgv(process.argv);
  ipcMain.handle('assembler:project:takePendingOpen', async () => {
    const path = pendingOpenPath;
    pendingOpenPath = null;
    return path ? readHcasmFile(path) : null;
  });

  void app.whenReady().then(createWindow);
}

async function createWindow(): Promise<void> {
  if (!isDev) registerAppProtocol(resolve(__dirname, '../renderer'));

  const win = new BrowserWindow({
    ...createMainWindowOptions(__dirname),
    ...(applicationIcon.isEmpty() ? {} : { icon: applicationIcon }),
  });
  mainWindow = win;
  if (!applicationIcon.isEmpty()) win.setIcon(applicationIcon);

  // Secure defaults: no window.open()-spawned windows, no in-place navigation
  // away from the packaged renderer or the dev server.
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (event) => event.preventDefault());
  win.webContents.on('will-redirect', (event) => event.preventDefault());

  registerFileApi(() => mainWindow);
  // "Open in slicer": detection, registered slicers, temp 3MF handoff (spawn without a shell).
  registerSlicerIpc(() => mainWindow);
  // Agent access (loopback JSON-RPC endpoint): off until the user turns it on in the UI.
  registerAutomation(() => mainWindow);
  attachCloseGuard(win);
  win.on('closed', () => {
    void stopAutomation();
    if (mainWindow === win) mainWindow = null;
  });

  if (isDev) win.webContents.openDevTools({ mode: 'detach' });
  await win.loadURL(RENDERER_URL);
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (mainWindow === null) void createWindow();
});
