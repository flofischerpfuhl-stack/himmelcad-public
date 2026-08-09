import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  BrowserWindow,
  app,
  dialog,
  ipcMain,
  nativeImage,
  protocol,
  safeStorage,
  session,
} from 'electron';
import {
  defaultAutomationPaths,
  registerElectronAutomationHost,
} from '@himmelcad/automation-host/electron';
import { ProviderCredentialStore } from '@himmelcad/automation-host/provider-credentials';

import {
  callSidecar,
  isSidecarRunning,
  issueAutomationConfirmationGrant,
  onSidecarStderr,
  startSidecar,
  stopSidecar,
} from './sidecar';
import { startDesktopUpdater } from './updater';

const isDev = !app.isPackaged;
const CACHE_DIR = resolve(tmpdir(), 'himmelcad-cache');
const CANONICAL_PROJECTS_DIRECTORY = 'canonical-projects';
const DEFAULT_CANONICAL_PROJECT_DIRECTORY = 'builder-default.hcad';
const DEV_POINT_CLOUD = process.env.HCAD_DEV_POINT_CLOUD?.trim() ?? '';
const DEV_IFC = process.env.HCAD_DEV_IFC?.trim() ?? '';
const DEV_ORTHOPHOTO = process.env.HCAD_DEV_ORTHOPHOTO?.trim() ?? '';
const DEV_DEM = process.env.HCAD_DEV_DEM?.trim() ?? '';
const DEV_POTREE_DATASET = process.env.HCAD_DEV_POTREE_DATASET?.trim() ?? '';
const CODEX_PROVIDER_ORIGIN = 'https://api.openai.com';
const CODEX_PROVIDER_EGRESS = {
  provider: 'codex',
  origin: CODEX_PROVIDER_ORIGIN,
  requests: [{ method: 'POST', path: '/v1/responses' }],
  redirects: 'deny',
  websockets: 'deny',
} as const;
const RENDERER_URL = isDev
  ? 'http://localhost:5173/'
  : pathToFileURL(resolve(__dirname, '../renderer/index.html')).href;
const CACHE_CORS_HEADERS = {
  'access-control-allow-origin': '*',
  'access-control-expose-headers': 'accept-ranges, content-length, content-range',
} as const;
app.setName('HimmelCAD Builder');
if (process.platform === 'linux') app.setDesktopName('himmelcad-builder.desktop');

let mainWindow: BrowserWindow | null = null;
let automationHost: ReturnType<typeof registerElectronAutomationHost> | null = null;

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
): Promise<{
  readonly width: number;
  readonly height: number;
  readonly tiles: DevelopmentRasterTile[];
}> {
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
      await fs.writeFile(
        imageTarget,
        image.crop({ x, y, width: tileWidth, height: tileHeight }).toPNG(),
      );
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
  {
    scheme: 'hcad-project',
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      corsEnabled: true,
      bypassCSP: true,
    },
  },
  {
    scheme: 'hcad-staged',
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      corsEnabled: true,
      bypassCSP: true,
    },
  },
]);

interface CanonicalResidencyArtifactBinding {
  readonly objectHash: string;
  readonly mediaType: string;
  readonly byteLength: number;
}

interface SidecarResidencyResource {
  readonly objectHash: string;
  readonly mediaType: string;
  readonly byteLength: number | null;
}

interface SidecarResidencyDataset {
  readonly datasetId: string;
  readonly formatId: string;
  readonly entityId: string;
  readonly representationSlot: string;
  readonly rootMetadata: SidecarResidencyResource;
  readonly artifacts: readonly {
    readonly relativePath: string;
    readonly resource: SidecarResidencyResource;
  }[];
}

interface SidecarResidencyBootstrap {
  readonly schemaVersion: number;
  readonly generation: number;
  readonly entries: readonly {
    readonly providerId: string;
    readonly providerVersion: string;
    readonly admission: unknown;
    readonly dataset: SidecarResidencyDataset | null;
  }[];
}

interface StagedArtifactBinding extends CanonicalResidencyArtifactBinding {
  readonly sessionId: string;
  readonly capability: string;
  readonly resourceId: string;
}

interface SidecarStagedResourceDescriptor {
  readonly resourceId: string;
  readonly relativePath: string;
  readonly objectHash: string;
  readonly mediaType: string;
  readonly byteLength: number;
}

interface SidecarStagedResourceInventory {
  readonly schemaVersion: number;
  readonly sessionId: string;
  readonly capability: string;
  readonly maximumReadBytes: number;
  readonly datasets: readonly {
    readonly datasetId: string;
    readonly formatId: string;
    readonly entityId: string;
    readonly representationSlot: string;
    readonly rootResourceId: string;
    readonly artifacts: readonly SidecarStagedResourceDescriptor[];
  }[];
  readonly resourceSets: readonly {
    readonly resourceSetId: string;
    readonly resources: readonly SidecarStagedResourceDescriptor[];
  }[];
}

interface SidecarStagedResourceRead {
  readonly schemaVersion: number;
  readonly resourceId: string;
  readonly objectHash: string;
  readonly mediaType: string;
  readonly offset: number;
  readonly byteLength: number;
  readonly totalByteLength: number;
  readonly bytesBase64: string;
}

const canonicalResidencyArtifacts = new Map<string, CanonicalResidencyArtifactBinding>();
const stagedArtifacts = new Map<string, StagedArtifactBinding>();

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
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  const denyNavigation = (event: Electron.Event): void => {
    event.preventDefault();
    void automationHost?.invalidateAgentSessions();
  };
  win.webContents.on('will-navigate', denyNavigation);
  win.webContents.on('will-redirect', denyNavigation);

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
    await win.loadURL(RENDERER_URL);
  } else {
    await win.loadURL(RENDERER_URL);
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

  // Project objects are addressed only through descriptors reconstructed by
  // the canonical sidecar. The renderer never receives a host filesystem path.
  protocol.handle('hcad-project', async (request) => {
    let url: URL;
    try {
      url = new URL(request.url);
    } catch {
      return new Response('bad url', { status: 400 });
    }
    if (url.host !== 'canonical') return new Response('forbidden', { status: 403 });
    const binding = canonicalResidencyArtifacts.get(url.pathname);
    if (!binding) return new Response('unknown canonical artifact', { status: 404 });
    const projectRoot = defaultCanonicalProjectRoot();
    const objectPath = canonicalObjectPath(projectRoot, binding.objectHash);
    try {
      const stat = await fs.stat(objectPath);
      if (!stat.isFile() || stat.size !== binding.byteLength) {
        return new Response('canonical artifact length mismatch', { status: 409 });
      }
      const rangeHeader = request.headers.get('range');
      if (rangeHeader) {
        const parsed = parseRange(rangeHeader, stat.size);
        if (!parsed) {
          return new Response('invalid range', {
            status: 416,
            headers: { ...CACHE_CORS_HEADERS, 'content-range': `bytes */${stat.size}` },
          });
        }
        const length = parsed.end - parsed.start + 1;
        const handle = await fs.open(objectPath, 'r');
        try {
          const bytes = Buffer.alloc(length);
          await handle.read(bytes, 0, length, parsed.start);
          return new Response(new Uint8Array(bytes), {
            status: 206,
            headers: {
              ...CACHE_CORS_HEADERS,
              'content-type': binding.mediaType,
              'content-length': String(length),
              'content-range': `bytes ${parsed.start}-${parsed.end}/${stat.size}`,
              'accept-ranges': 'bytes',
            },
          });
        } finally {
          await handle.close();
        }
      }
      const bytes = await fs.readFile(objectPath);
      const observedHash = createHash('sha256').update(bytes).digest('hex');
      if (observedHash !== binding.objectHash) {
        return new Response('canonical artifact hash mismatch', { status: 409 });
      }
      return new Response(new Uint8Array(bytes), {
        headers: {
          ...CACHE_CORS_HEADERS,
          'content-type': binding.mediaType,
          'content-length': String(bytes.byteLength),
          'accept-ranges': 'bytes',
        },
      });
    } catch (error) {
      return new Response(`canonical artifact unavailable: ${(error as Error).message}`, {
        status: 404,
      });
    }
  });

  // Ephemeral registration artifacts are read through the sidecar-owned
  // capability. Electron retains only opaque IDs and exact immutable metadata.
  protocol.handle('hcad-staged', async (request) => {
    let url: URL;
    try {
      url = new URL(request.url);
    } catch {
      return new Response('bad url', { status: 400 });
    }
    if (url.host !== 'registration') return new Response('forbidden', { status: 403 });
    const binding = stagedArtifacts.get(url.pathname);
    if (!binding) return new Response('staged capability revoked', { status: 410 });
    const requested = request.headers.get('range');
    const range = requested ? parseRange(requested, binding.byteLength) : null;
    if (requested && !range) {
      return new Response('invalid range', {
        status: 416,
        headers: { ...CACHE_CORS_HEADERS, 'content-range': `bytes */${binding.byteLength}` },
      });
    }
    const offset = range?.start ?? 0;
    const byteLength = range ? range.end - range.start + 1 : binding.byteLength;
    if (byteLength > 4 * 1024 * 1024) {
      return new Response('staged request exceeds range bound', { status: 413 });
    }
    try {
      const result = await callSidecar<SidecarStagedResourceRead>({
        method: 'registration.resource.read',
        params: {
          sessionId: binding.sessionId,
          capability: binding.capability,
          resourceId: binding.resourceId,
          offset,
          byteLength,
        },
      });
      if (
        result.schemaVersion !== 1 ||
        result.resourceId !== binding.resourceId ||
        result.objectHash !== binding.objectHash ||
        result.mediaType !== binding.mediaType ||
        result.offset !== offset ||
        result.byteLength !== byteLength ||
        result.totalByteLength !== binding.byteLength
      ) {
        return new Response('staged read descriptor mismatch', { status: 409 });
      }
      const bytes = Buffer.from(result.bytesBase64, 'base64');
      if (bytes.byteLength !== byteLength) {
        return new Response('staged read byte length mismatch', { status: 409 });
      }
      return new Response(new Uint8Array(bytes), {
        status: range ? 206 : 200,
        headers: {
          ...CACHE_CORS_HEADERS,
          'content-type': binding.mediaType,
          'content-length': String(byteLength),
          ...(range
            ? {
                'content-range': `bytes ${offset}-${offset + byteLength - 1}/${binding.byteLength}`,
              }
            : {}),
          'accept-ranges': 'bytes',
        },
      });
    } catch {
      revokeStagedSession(binding.sessionId);
      return new Response('staged capability unavailable', { status: 410 });
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
  const repositoryRoot = resolve(__dirname, '..', '..', '..', '..');
  const automationPaths = app.isPackaged
    ? {
        runtimeRoot: resolve(
          process.resourcesPath,
          'automation-runtime',
          process.platform === 'win32' ? 'win32-x64' : 'linux-x64',
        ),
        workspaceRoot: resolve(app.getPath('userData'), 'automation-workspace'),
      }
    : defaultAutomationPaths(repositoryRoot, app.getPath('userData'));
  const providerCredentialStore = new ProviderCredentialStore({
    path: resolve(app.getPath('userData'), 'automation', 'provider-credentials.v1.json'),
    origin: CODEX_PROVIDER_ORIGIN,
    safeStorage,
  });
  automationHost = registerElectronAutomationHost({
    ipcMain,
    getWindow: () => mainWindow,
    sidecarCall: (method, params) => callSidecar({ method, params }),
    issueConfirmationGrant: issueAutomationConfirmationGrant,
    ...automationPaths,
    workspaceCapabilityId: 'himmelcad-project',
    rendererUrl: RENDERER_URL,
    providerEgressManifest: CODEX_PROVIDER_EGRESS,
    getAuthorization: (request) => providerCredentialStore.getAuthorization(request),
    authorizationAvailable: (request) => providerCredentialStore.authorizationAvailable(request),
    providerCredentialStore,
  });
  await automationHost.ready;
  await createWindow();
  startDesktopUpdater(() => mainWindow);
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
  ipcMain.handle('canonical-residency:bootstrap', async () => {
    const bootstrap = await callSidecar<SidecarResidencyBootstrap>({
      method: 'canonical.residency.bootstrap',
      params: {},
    });
    return materializeCanonicalResidency(bootstrap);
  });
  ipcMain.handle('canonical-project:default-root', async () => {
    const projectsDirectory = resolve(app.getPath('userData'), CANONICAL_PROJECTS_DIRECTORY);
    await fs.mkdir(projectsDirectory, { recursive: true });
    return defaultCanonicalProjectRoot();
  });
  ipcMain.handle('registration-staged:materialize', async (_event, sessionId: unknown) => {
    if (typeof sessionId !== 'string' || !/^[A-Za-z0-9_.-]{1,160}$/.test(sessionId)) {
      throw new Error('invalid registration session identity');
    }
    const inventory = await callSidecar<SidecarStagedResourceInventory>({
      method: 'registration.resources.describe',
      params: { sessionId },
    });
    return materializeStagedResources(inventory);
  });
  ipcMain.handle('registration-staged:revoke', (_event, sessionId: unknown) => {
    if (typeof sessionId !== 'string') return false;
    return revokeStagedSession(sessionId);
  });
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
      const worldFile = (await fs.readFile(worldFilePath, 'utf8')).trim().split(/\s+/).map(Number);
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

  ipcMain.handle('dialog:openImport', async (_event, requestedExtensions: unknown) => {
    if (!mainWindow) return [];
    const extensions = Array.isArray(requestedExtensions)
      ? [...new Set(requestedExtensions)]
          .filter(
            (value): value is string =>
              typeof value === 'string' && /^[A-Za-z0-9]{1,12}$/.test(value),
          )
          .slice(0, 128)
      : [];
    const result = await dialog.showOpenDialog(mainWindow, {
      title: 'Import into HimmelCAD',
      filters: [
        ...(extensions.length > 0 ? [{ name: 'Supported formats', extensions }] : []),
        { name: 'All files', extensions: ['*'] },
      ],
      properties: ['openFile', 'multiSelections'],
    });
    return result.canceled ? [] : result.filePaths;
  });
}

function defaultCanonicalProjectRoot(): string {
  return resolve(
    app.getPath('userData'),
    CANONICAL_PROJECTS_DIRECTORY,
    DEFAULT_CANONICAL_PROJECT_DIRECTORY,
  );
}

function canonicalObjectPath(projectRoot: string, objectHash: string): string {
  if (!/^[a-f0-9]{64}$/.test(objectHash)) throw new Error('invalid canonical object hash');
  return resolve(projectRoot, 'objects', objectHash.slice(0, 2), objectHash.slice(2));
}

function materializeCanonicalResidency(bootstrap: SidecarResidencyBootstrap): unknown {
  if (
    bootstrap.schemaVersion !== 1 ||
    !Number.isSafeInteger(bootstrap.generation) ||
    !Array.isArray(bootstrap.entries)
  ) {
    throw new Error('sidecar returned an invalid canonical residency bootstrap');
  }
  const nextArtifacts = new Map<string, CanonicalResidencyArtifactBinding>();
  const entries = bootstrap.entries.map((entry) => {
    if (
      typeof entry.providerId !== 'string' ||
      typeof entry.providerVersion !== 'string' ||
      entry.admission === null ||
      typeof entry.admission !== 'object'
    ) {
      throw new Error('sidecar returned an invalid canonical residency entry');
    }
    if (!entry.dataset) return { ...entry, dataset: null };
    const dataset = entry.dataset;
    if (!dataset.datasetId || !dataset.formatId || !Array.isArray(dataset.artifacts)) {
      throw new Error('sidecar returned an invalid canonical residency dataset');
    }
    const token = createHash('sha256')
      .update(`${dataset.datasetId}\0${dataset.rootMetadata.objectHash}`)
      .digest('hex');
    let metadataUrl: string | null = null;
    for (const artifact of dataset.artifacts) {
      const resource = artifact.resource;
      if (
        !/^[a-f0-9]{64}$/.test(resource.objectHash) ||
        typeof resource.mediaType !== 'string' ||
        resource.mediaType.length === 0 ||
        !Number.isSafeInteger(resource.byteLength) ||
        (resource.byteLength ?? 0) <= 0
      ) {
        throw new Error('sidecar returned an invalid canonical artifact resource');
      }
      const segments = safeArtifactSegments(artifact.relativePath);
      const artifactUrl = `hcad-project://canonical/dataset/${token}/${segments
        .map(encodeURIComponent)
        .join('/')}`;
      const pathname = new URL(artifactUrl).pathname;
      const binding = {
        objectHash: resource.objectHash,
        mediaType: resource.mediaType,
        byteLength: resource.byteLength!,
      };
      const existing = nextArtifacts.get(pathname);
      if (existing && JSON.stringify(existing) !== JSON.stringify(binding)) {
        throw new Error('canonical artifact URL collision');
      }
      nextArtifacts.set(pathname, binding);
      if (resource.objectHash === dataset.rootMetadata.objectHash) metadataUrl = artifactUrl;
    }
    if (!metadataUrl) throw new Error('canonical dataset root metadata is absent');
    return {
      ...entry,
      dataset: {
        datasetId: dataset.datasetId,
        formatId: dataset.formatId,
        metadataUrl,
      },
    };
  });
  canonicalResidencyArtifacts.clear();
  for (const [pathname, binding] of nextArtifacts) {
    canonicalResidencyArtifacts.set(pathname, binding);
  }
  return { schemaVersion: 1, generation: bootstrap.generation, entries };
}

function materializeStagedResources(inventory: SidecarStagedResourceInventory): unknown {
  if (
    inventory.schemaVersion !== 1 ||
    !/^[A-Za-z0-9_.-]{1,160}$/.test(inventory.sessionId) ||
    !/^[a-f0-9]{64}$/.test(inventory.capability) ||
    inventory.maximumReadBytes !== 4 * 1024 * 1024 ||
    !Array.isArray(inventory.datasets as unknown) ||
    !Array.isArray(inventory.resourceSets as unknown)
  ) {
    throw new Error('sidecar returned an invalid staged-resource inventory');
  }
  revokeStagedSession(inventory.sessionId);
  const register = (resource: SidecarStagedResourceDescriptor): string => {
    if (
      !/^[a-f0-9]{64}$/.test(resource.resourceId) ||
      !/^[a-f0-9]{64}$/.test(resource.objectHash) ||
      typeof resource.mediaType !== 'string' ||
      resource.mediaType.length === 0 ||
      !Number.isSafeInteger(resource.byteLength) ||
      resource.byteLength <= 0
    ) {
      throw new Error('sidecar returned an invalid staged-resource descriptor');
    }
    const segments = safeArtifactSegments(resource.relativePath);
    const resourceUrl = `hcad-staged://registration/${encodeURIComponent(
      inventory.sessionId,
    )}/${resource.resourceId}/${segments.map(encodeURIComponent).join('/')}`;
    const pathname = new URL(resourceUrl).pathname;
    if (stagedArtifacts.has(pathname)) throw new Error('staged-resource URL collision');
    stagedArtifacts.set(pathname, {
      sessionId: inventory.sessionId,
      capability: inventory.capability,
      resourceId: resource.resourceId,
      objectHash: resource.objectHash,
      mediaType: resource.mediaType,
      byteLength: resource.byteLength,
    });
    return resourceUrl;
  };
  const datasets = inventory.datasets.map((dataset) => {
    const urls = new Map<string, string>();
    for (const artifact of dataset.artifacts) urls.set(artifact.resourceId, register(artifact));
    const metadataUrl = urls.get(dataset.rootResourceId);
    if (!metadataUrl) throw new Error('staged dataset root metadata is absent');
    return {
      datasetId: dataset.datasetId,
      formatId: dataset.formatId,
      entityId: dataset.entityId,
      representationSlot: dataset.representationSlot,
      metadataUrl,
      artifacts: dataset.artifacts.map((artifact) => {
        const url = urls.get(artifact.resourceId);
        if (!url) throw new Error('staged dataset artifact URL is absent');
        return {
          relativePath: artifact.relativePath,
          resourceId: artifact.resourceId,
          url,
        };
      }),
    };
  });
  const resourceSets = inventory.resourceSets.map((resourceSet) => ({
    resourceSetId: resourceSet.resourceSetId,
    resources: resourceSet.resources.map((resource) => ({
      relativePath: resource.relativePath,
      resourceId: resource.resourceId,
      url: register(resource),
    })),
  }));
  return { schemaVersion: 1, sessionId: inventory.sessionId, datasets, resourceSets };
}

function revokeStagedSession(sessionId: string): boolean {
  let revoked = false;
  for (const [pathname, binding] of stagedArtifacts) {
    if (binding.sessionId !== sessionId) continue;
    stagedArtifacts.delete(pathname);
    revoked = true;
  }
  return revoked;
}

function safeArtifactSegments(relativePath: string): string[] {
  if (
    typeof relativePath !== 'string' ||
    relativePath.length === 0 ||
    /^[\\/]/.test(relativePath) ||
    relativePath.includes(':')
  ) {
    throw new Error('canonical artifact path is not relative');
  }
  const segments = relativePath.split(/[\\/]/);
  if (segments.some((segment) => segment.length === 0 || segment === '.' || segment === '..')) {
    throw new Error('canonical artifact path contains unsafe segments');
  }
  return segments;
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
  void automationHost?.dispose();
  automationHost = null;
  stopSidecar();
});
