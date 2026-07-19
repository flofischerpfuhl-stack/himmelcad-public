import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

import { BrowserWindow, app, dialog, ipcMain, nativeImage, protocol, session } from 'electron';

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
const DEV_POINT_CLOUD = process.env.HCAD_DEV_POINT_CLOUD?.trim() ?? '';
const DEV_IFC = process.env.HCAD_DEV_IFC?.trim() ?? '';
const DEV_ORTHOPHOTO = process.env.HCAD_DEV_ORTHOPHOTO?.trim() ?? '';
const DEV_DEM = process.env.HCAD_DEV_DEM?.trim() ?? '';
const DEV_POTREE_DATASET = process.env.HCAD_DEV_POTREE_DATASET?.trim() ?? '';
const CACHE_CORS_HEADERS = {
  'access-control-allow-origin': '*',
  'access-control-expose-headers': 'accept-ranges, content-length, content-range',
} as const;
app.setName('HimmelCAD Builder');
if (process.platform === 'linux') app.setDesktopName('himmelcad-builder.desktop');

let mainWindow: BrowserWindow | null = null;

interface DevelopmentRasterTile {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly imageUrl: string;
  readonly demUrl: string | null;
}

async function prepareDevelopmentRasterTiles(
  imagePath: string,
  demPath: string | null,
  targetDirectory: string,
): Promise<{ readonly width: number; readonly height: number; readonly tiles: DevelopmentRasterTile[] }> {
  const image = nativeImage.createFromPath(imagePath);
  if (image.isEmpty()) throw new Error(`unable to decode development orthophoto: ${imagePath}`);
  const { width, height } = image.getSize();
  const dem = demPath ? await fs.readFile(demPath) : null;
  if (dem && dem.byteLength !== width * height * Float32Array.BYTES_PER_ELEMENT) {
    throw new Error(
      `development DEM dimensions do not match orthophoto (${dem.byteLength} bytes for ${width}×${height})`,
    );
  }
  const tileDirectory = resolve(targetDirectory, 'raster-tiles');
  await fs.mkdir(tileDirectory, { recursive: true });
  const tileSize = 256;
  // Raster meshes sample pixel centers. Adjacent tiles therefore share one
  // border row/column so their generated topology closes without hairline gaps.
  const tileStride = tileSize - 1;
  const tiles: DevelopmentRasterTile[] = [];
  for (let y = 0; y < height; y += tileStride) {
    for (let x = 0; x < width; x += tileStride) {
      const tileWidth = Math.min(tileSize, width - x);
      const tileHeight = Math.min(tileSize, height - y);
      const stem = `tile-${x}-${y}`;
      const imageTarget = resolve(tileDirectory, `${stem}.png`);
      await fs.writeFile(imageTarget, image.crop({ x, y, width: tileWidth, height: tileHeight }).toPNG());
      let demUrl: string | null = null;
      if (dem) {
        const tileDem = Buffer.allocUnsafe(tileWidth * tileHeight * Float32Array.BYTES_PER_ELEMENT);
        for (let row = 0; row < tileHeight; row += 1) {
          const sourceStart = ((y + row) * width + x) * Float32Array.BYTES_PER_ELEMENT;
          const targetStart = row * tileWidth * Float32Array.BYTES_PER_ELEMENT;
          dem.copy(
            tileDem,
            targetStart,
            sourceStart,
            sourceStart + tileWidth * Float32Array.BYTES_PER_ELEMENT,
          );
        }
        const demTarget = resolve(tileDirectory, `${stem}.bil`);
        await fs.writeFile(demTarget, tileDem);
        demUrl = `hcad-cache://local/dev-alte-akademie/raster-tiles/${stem}.bil`;
      }
      tiles.push({
        x,
        y,
        width: tileWidth,
        height: tileHeight,
        imageUrl: `hcad-cache://local/dev-alte-akademie/raster-tiles/${stem}.png`,
        demUrl,
      });
    }
  }
  return { width, height, tiles };
}

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
if (isDev && process.platform === 'linux') {
  // Chromium keeps Linux WebGPU behind this development opt-in. Packaged
  // builds retain normal platform policy and the viewer's permanent WebGL2
  // fallback.
  app.commandLine.appendSwitch('enable-unsafe-webgpu');
}

protocol.registerSchemesAsPrivileged([
  {
    scheme: 'hcad-cache',
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      corsEnabled: true,
      bypassCSP: true,
    },
  },
]);

async function createWindow(): Promise<void> {
  const applicationIcon = nativeImage.createFromPath(resolve(__dirname, '../../build/icon.png'));
  const win = new BrowserWindow({
    title: 'HimmelCAD Builder',
    width: 1480,
    height: 920,
    minWidth: 980,
    minHeight: 620,
    backgroundColor: '#101114',
    icon: applicationIcon,
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

  // Some Linux window managers ignore the constructor hint until the native
  // window exists. Re-apply it here; setDesktopName above supplies the matching
  // WM_CLASS/desktop-file identity used by Linux launchers.
  if (!applicationIcon.isEmpty()) win.setIcon(applicationIcon);

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
            headers: {
              ...CACHE_CORS_HEADERS,
              'content-range': `bytes */${total}`,
            },
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
              ...CACHE_CORS_HEADERS,
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
          ...CACHE_CORS_HEADERS,
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
  ipcMain.handle('dev:initial-point-cloud-paths', () =>
    isDev && DEV_POINT_CLOUD.length > 0 ? [resolve(DEV_POINT_CLOUD)] : [],
  );
  ipcMain.handle('dev:initial-prepared-point-cloud', async () => {
    if (!isDev || DEV_POTREE_DATASET.length === 0) return null;
    if (!/^potree-[a-f0-9]{64}$/.test(DEV_POTREE_DATASET)) {
      throw new Error('HCAD_DEV_POTREE_DATASET is invalid');
    }
    const metadataPath = resolve(CACHE_DIR, DEV_POTREE_DATASET, 'metadata.json');
    const metadata = JSON.parse(await fs.readFile(metadataPath, 'utf8')) as {
      name?: string;
      points?: number;
      boundingBox?: { min?: number[]; max?: number[] };
    };
    return {
      entityId: `entity-${DEV_POTREE_DATASET.slice('potree-'.length)}`,
      datasetId: DEV_POTREE_DATASET,
      sourceName: metadata.name ?? 'Prepared point cloud',
      pointCount: metadata.points ?? 0,
      boundsMin: metadata.boundingBox?.min ?? [0, 0, 0],
      boundsMax: metadata.boundingBox?.max ?? [0, 0, 0],
      metadataUrl: `hcad-cache://local/${DEV_POTREE_DATASET}/metadata.json`,
    };
  });
  ipcMain.handle('dev:initial-mixed-scene', async () => {
    if (!isDev) return null;
    const ifcPath = DEV_IFC.length > 0 ? resolve(DEV_IFC) : null;
    const orthophotoPath = DEV_ORTHOPHOTO.length > 0 ? resolve(DEV_ORTHOPHOTO) : null;
    const demPath = DEV_DEM.length > 0 ? resolve(DEV_DEM) : null;
    let orthophoto: {
      url: string;
      worldFile: number[];
      width: number;
      height: number;
      tiles: DevelopmentRasterTile[];
    } | null = null;
    if (orthophotoPath) {
      const extension = orthophotoPath.slice(orthophotoPath.lastIndexOf('.'));
      const targetDirectory = resolve(CACHE_DIR, 'dev-alte-akademie');
      const target = resolve(targetDirectory, `orthophoto${extension}`);
      await fs.mkdir(targetDirectory, { recursive: true });
      await fs.copyFile(orthophotoPath, target);
      const worldFilePath = orthophotoPath.replace(/\.[^.]+$/, '.tfw');
      const worldFile = (await fs.readFile(worldFilePath, 'utf8'))
        .trim()
        .split(/\s+/)
        .map(Number);
      if (worldFile.length !== 6 || worldFile.some((value) => !Number.isFinite(value))) {
        throw new Error(`invalid orthophoto world file: ${worldFilePath}`);
      }
      const prepared = await prepareDevelopmentRasterTiles(
        orthophotoPath,
        demPath,
        targetDirectory,
      );
      orthophoto = {
        url: `hcad-cache://local/dev-alte-akademie/orthophoto${extension}`,
        worldFile,
        ...prepared,
      };
    }
    let demUrl: string | null = null;
    if (demPath) {
      const targetDirectory = resolve(CACHE_DIR, 'dev-alte-akademie');
      const target = resolve(targetDirectory, 'terrain.bil');
      await fs.mkdir(targetDirectory, { recursive: true });
      if (demPath !== target) await fs.copyFile(demPath, target);
      demUrl = 'hcad-cache://local/dev-alte-akademie/terrain.bil';
    }
    return { ifcPath, orthophoto, demUrl };
  });
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
          params: {
            paths,
            cache_dir: CACHE_DIR,
            progress_key: progressKey,
            operation_id: progressKey,
          },
        });
        // Sidecar returns independent semantic entity and immutable dataset
        // identities; only the dataset identity addresses prepared bytes.
        // synthesize the renderer-reachable URL so the renderer never has
        // to know about CACHE_DIR or the cache scheme.
        const imports = (result?.imports ?? []).map((s) => {
          const entityId = String(s.entity_id ?? '');
          if (!entityId) {
            throw new Error('sidecar import.las response missing entity_id');
          }
          const datasetId = String(s.dataset_id ?? entityId);
          return {
            ...s,
            metadata_url: `hcad-cache://local/${datasetId}/metadata.json`,
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
