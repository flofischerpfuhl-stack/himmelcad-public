import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

import { BrowserWindow, app, dialog, ipcMain, protocol, session } from 'electron';

import {
  callSidecar,
  getRecentStderr,
  isSidecarRunning,
  onSidecarStderr,
  startSidecar,
  stopSidecar,
} from './sidecar';

const isDev = !app.isPackaged;
const CACHE_DIR = resolve(tmpdir(), 'himmelcad-cache');
app.setName('HimmelCAD Builder');

let mainWindow: BrowserWindow | null = null;

// Disable Chromium's MMB (middle-mouse-button) auto-scroll so we can use
// MMB-drag for camera pan, like every other CAD/3D tool. Renderer-side
// `event.preventDefault()` on `mousedown` is *unreliable* on Linux X11 —
// the autoscroll state machine can fire before the page handler runs and
// captures the pointer for itself, eating our pointermove events. Killing
// the feature at the Chromium level is the only fully robust escape.
//
// Must be called BEFORE `app.whenReady()` (Chromium reads the switch
// during browser-process init).
app.commandLine.appendSwitch('disable-features', 'MiddleClickAutoscroll');

protocol.registerSchemesAsPrivileged([
  {
    scheme: 'hcad-cache',
    privileges: { standard: true, secure: true, supportFetchAPI: true, bypassCSP: true },
  },
]);

async function createWindow(): Promise<void> {
  const win = new BrowserWindow({
    title: 'HimmelCAD Builder',
    width: 1480,
    height: 920,
    minWidth: 980,
    minHeight: 620,
    backgroundColor: '#101114',
    icon: resolve(__dirname, '../../build/icon.png'),
    frame: false,
    titleBarStyle: 'hidden',
    autoHideMenuBar: true,
    show: true,
    webPreferences: {
      preload: resolve(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webgl: true,
    },
  });

  mainWindow = win;

  win.on('maximize', () => win.webContents.send('window:maximize-changed', true));
  win.on('unmaximize', () => win.webContents.send('window:maximize-changed', false));

  // Forward sidecar stderr lines to the renderer console as soon as the
  // window has loaded. This lets the user copy them out from the in-app
  // console without inspecting the OS terminal.
  const offStderr = onSidecarStderr((line) => {
    win.webContents.send('sidecar:stderr', line);
  });
  win.on('closed', offStderr);

  if (isDev) {
    win.webContents.openDevTools({ mode: 'detach' });
    await win.loadURL('http://localhost:5173/');
  } else {
    await win.loadFile(resolve(__dirname, '../renderer/index.html'));
  }
}

void app.whenReady().then(async () => {
  await fs.mkdir(CACHE_DIR, { recursive: true });

  // Custom file-like protocol for the project cache.
  //
  // Layout under CACHE_DIR after Phase 2 (ADR 0003):
  //
  //   <CACHE_DIR>/
  //     <entityId>/
  //       metadata.json    (Potree 2.0 metadata)
  //       hierarchy.bin    (octree topology)
  //       octree.bin       (point payloads, large — ranged fetches)
  //
  // URL convention: `hcad-cache://local/<entityId>/<file>`. `local` is a
  // fixed host so Chromium's URL parser doesn't fold the path into the
  // authority (`hcad-cache:///x` → host="x", path="/", which we cannot
  // recover deterministically).
  //
  // Range support is mandatory because three-loader fetches sub-ranges of
  // `octree.bin` per visible node — without it the renderer would have to
  // download hundreds of MB before painting the first frame.
  protocol.handle('hcad-cache', async (request) => {
    let host = '';
    let pathname = '';
    try {
      const u = new URL(request.url);
      host = u.host;
      pathname = u.pathname;
    } catch (err) {
      console.warn('[hcad-cache] invalid URL', request.url, err);
      return new Response('bad url', { status: 400 });
    }

    if (host !== 'local') {
      console.warn(`[hcad-cache] unexpected host="${host}" url=${request.url}`);
      return new Response(`forbidden host: ${host}`, { status: 403 });
    }

    // Allow nested paths but block traversal. `..` is rejected anywhere in
    // the path; absolute paths (leading `/` after strip) and empty paths
    // are also rejected.
    const relPath = pathname.replace(/^\/+/, '');
    if (
      !relPath ||
      relPath.split('/').some((seg) => seg === '..' || seg === '' || seg.startsWith('.'))
    ) {
      console.warn(`[hcad-cache] forbidden path="${relPath}" url=${request.url}`);
      return new Response('forbidden', { status: 403 });
    }

    const fullPath = resolve(CACHE_DIR, relPath);
    if (!fullPath.startsWith(CACHE_DIR + '/') && fullPath !== CACHE_DIR) {
      // Defensive: resolve() could produce a path outside CACHE_DIR if
      // relPath sneaks in absolute components on some platforms. Reject.
      console.warn(`[hcad-cache] escaped CACHE_DIR: ${fullPath}`);
      return new Response('forbidden', { status: 403 });
    }

    try {
      const stat = await fs.stat(fullPath);
      const total = stat.size;
      const rangeHeader = request.headers.get('range');

      if (rangeHeader) {
        const parsed = parseRange(rangeHeader, total);
        if (!parsed) {
          return new Response('invalid range', {
            status: 416,
            headers: { 'content-range': `bytes */${total}` },
          });
        }
        const { start, end } = parsed;
        const length = end - start + 1;
        const handle = await fs.open(fullPath, 'r');
        try {
          const buf = Buffer.alloc(length);
          await handle.read(buf, 0, length, start);
          return new Response(new Uint8Array(buf), {
            status: 206,
            headers: {
              'content-type': contentTypeFor(relPath),
              'content-length': String(length),
              'content-range': `bytes ${start}-${end}/${total}`,
              'accept-ranges': 'bytes',
            },
          });
        } finally {
          await handle.close();
        }
      }

      const data = await fs.readFile(fullPath);
      return new Response(new Uint8Array(data), {
        headers: {
          'content-type': contentTypeFor(relPath),
          'content-length': String(total),
          'accept-ranges': 'bytes',
        },
      });
    } catch (err) {
      return new Response(`not found: ${(err as Error).message}`, { status: 404 });
    }
  });

  if (!isDev) {
    // RATIONALE: COOP/COEP enable SharedArrayBuffer for future WASM-threaded
    // workloads (Potree decoder, Gaussian-splat sorting). Disabled in dev
    // because Vite's HMR assets are not served with CORP headers.
    session.defaultSession.webRequest.onHeadersReceived((details, cb) => {
      cb({
        responseHeaders: {
          ...details.responseHeaders,
          'Cross-Origin-Opener-Policy': ['same-origin'],
          'Cross-Origin-Embedder-Policy': ['require-corp'],
        },
      });
    });
  }

  registerIpc();
  await startSidecar();
  await createWindow();
});

function registerIpc(): void {
  ipcMain.handle('window:minimize', () => {
    mainWindow?.minimize();
  });
  ipcMain.handle('window:maximize-toggle', () => {
    if (!mainWindow) return false;
    if (mainWindow.isMaximized()) {
      mainWindow.unmaximize();
    } else {
      mainWindow.maximize();
    }
    return mainWindow.isMaximized();
  });
  ipcMain.handle('window:close', () => {
    mainWindow?.close();
  });
  ipcMain.handle('window:is-maximized', () => mainWindow?.isMaximized() ?? false);

  ipcMain.handle('sidecar:status', () => isSidecarRunning());
  ipcMain.handle('sidecar:call', async (_e, method: string, params: unknown) => {
    return callSidecar({ method, params });
  });

  ipcMain.handle('dialog:openLas', async () => {
    if (!mainWindow) return [];
    const r = await dialog.showOpenDialog(mainWindow, {
      title: 'Import LAS / LAZ',
      filters: [
        { name: 'Point clouds (LAS/LAZ)', extensions: ['las', 'laz', 'LAS', 'LAZ'] },
        { name: 'All files', extensions: ['*'] },
      ],
      properties: ['openFile', 'multiSelections'],
    });
    return r.canceled ? [] : r.filePaths;
  });

  ipcMain.handle(
    'import:las',
    async (
      _e,
      payload: string[] | { paths?: string[]; progressKey?: string },
    ): Promise<unknown> => {
      try {
        const paths = Array.isArray(payload) ? payload : (payload.paths ?? []);
        const progressKey = Array.isArray(payload) ? undefined : payload.progressKey;
        const result = await callSidecar<{ imports: Array<Record<string, unknown>> }>({
          method: 'import.las',
          params: { paths, cache_dir: CACHE_DIR, progress_key: progressKey },
        });
        // Sidecar already returns `entity_id` and `potree_dir`; we only
        // synthesize the renderer-reachable URL so the renderer never has
        // to know about CACHE_DIR or the cache scheme.
        const imports = (result?.imports ?? []).map((s) => {
          const entityId = String(s.entity_id ?? '');
          if (!entityId) {
            throw new Error('sidecar import.las response missing entity_id');
          }
          return {
            ...s,
            metadata_url: `hcad-cache://local/${entityId}/metadata.json`,
          };
        });
        return { imports };
      } catch (err) {
        // Re-throw with the recent sidecar stderr appended so the renderer
        // shows actionable output instead of a bare RPC error string.
        const tail = getRecentStderr().slice(-12).join('\n');
        const msg = err instanceof Error ? err.message : String(err);
        const composed = tail ? `${msg}\n--- sidecar stderr (tail) ---\n${tail}` : msg;
        throw new Error(composed);
      }
    },
  );
}

/**
 * Parse an HTTP Range header. Only single-byte-range requests are
 * supported (which is all three-loader emits); multi-range requests
 * return null and are translated to 416 by the caller.
 */
function parseRange(header: string, total: number): { start: number; end: number } | null {
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m) return null;
  const startStr = m[1];
  const endStr = m[2];
  let start: number;
  let end: number;
  if (startStr === '' && endStr !== '') {
    // suffix range: bytes=-N → last N bytes
    const n = Number(endStr);
    if (!Number.isFinite(n) || n <= 0) return null;
    start = Math.max(0, total - n);
    end = total - 1;
  } else if (startStr !== '' && endStr === '') {
    start = Number(startStr);
    end = total - 1;
  } else if (startStr !== '' && endStr !== '') {
    start = Number(startStr);
    end = Number(endStr);
  } else {
    return null;
  }
  if (
    !Number.isFinite(start) ||
    !Number.isFinite(end) ||
    start < 0 ||
    end < start ||
    start >= total
  ) {
    return null;
  }
  if (end >= total) end = total - 1;
  return { start, end };
}

function contentTypeFor(relPath: string): string {
  if (relPath.endsWith('.json')) return 'application/json';
  return 'application/octet-stream';
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) void createWindow();
});

app.on('before-quit', () => {
  stopSidecar();
});
