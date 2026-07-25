import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { constants as fsConstants, createReadStream } from 'node:fs';
import {
  copyFile,
  mkdir,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from 'node:path';
import { Readable } from 'node:stream';

import { BrowserWindow, app, dialog, ipcMain, nativeImage, protocol } from 'electron';

import {
  callSidecar,
  isSidecarRunning,
  onSidecarStderr,
  startSidecar,
  stopSidecar,
} from './sidecar';
import { PhotolabPreferencesService, type DirectoryPreference } from './preferences';

const isDev = !app.isPackaged;
app.setName('HimmelCAD PhotoLab');
let mainWindow: BrowserWindow | null = null;
let currentWorkingPath: string | null = null;
let currentProjectSourcePath: string | null = null;
let preferences: PhotolabPreferencesService;
const pendingProductExports = new Map<
  string,
  { entityId: string; destinationPath: string; createdAt: number }
>();
const previewGenerationTasks = new Map<string, Promise<void>>();
const previewGenerationWaiters: Array<() => void> = [];
let activePreviewGenerations = 0;
const MAX_PARALLEL_PREVIEW_GENERATIONS = 2;

interface ProjectArchiveOperationRequest {
  archiveOperationId: string;
  progressKey: string;
}

interface CurrentProjectSessionSnapshot {
  session: {
    sourcePath: string;
    usesLocalWorkingCopy: boolean;
  };
}

protocol.registerSchemesAsPrivileged([
  {
    scheme: 'hcad-image',
    privileges: { standard: true, secure: true, supportFetchAPI: true },
  },
  {
    scheme: 'hcad-product',
    // Product viewers use fetch() for JSON manifests, byte ranges and binary tiles.
    // Electron treats the renderer's http(s) origin and this custom scheme as
    // different origins, so the scheme must participate in CORS explicitly.
    privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true },
  },
]);

const RENDERER_SIDECAR_METHODS = new Set([
  'photolab.alignment.resolve',
  'photolab.project.snapshot',
  'photolab.project.journal.start',
  'photolab.project.journal.finish',
  'photolab.project.autosave',
  'photolab.project.archive.cancel',
  'photolab.project.entity.rename',
  'photolab.project.entity.visibility',
  'photolab.project.entity.move',
  'photolab.project.images.remove',
  'photolab.project.imageMask.list',
  'photolab.project.imageMask.edit',
  'photolab.project.imageMask.cancel',
  'photolab.project.processingSet.list',
  'photolab.project.processingSet.create',
  'photolab.project.captureGroup.list',
  'photolab.project.captureGroup.create',
  'photolab.project.captureGroup.confirm',
  'photolab.project.calibrationGroup.list',
  'photolab.project.alignmentMerge.list',
  'photolab.project.alignmentMerge.candidates',
  'photolab.project.alignmentMerge.create',
  'photolab.crs.discover',
  'photolab.crs.freeze',
  'photolab.crs.cancel',
  'photolab.images.commit',
  'photolab.images.commit.cancel',
  'photolab.images.inspect',
  'photolab.images.inspect.cancel',
  'photolab.himmelcap.inspect',
  'photolab.himmelcap.cancel',
  'photolab.himmelcap.release',
  'photolab.images.list',
  'photolab.images.quality.list',
  'photolab.gcp.preview',
  'photolab.gcp.commit',
  'photolab.gcp.list',
  'photolab.gcp.observation.upsert',
  'photolab.gcp.observation.edit',
  'photolab.gcp.observation.upsertAssisted',
  'photolab.gcp.optimization.snapshot',
  'photolab.gcp.optimization.latest',
  'photolab.gcp.optimization.list',
  'photolab.gcp.alignedCameras',
  'photolab.gcp.cancel',
  'photolab.jobs.startAlignment',
  'photolab.jobs.startImageQuality',
  'photolab.jobs.startAlignmentMerge',
  'photolab.jobs.startGcpOptimization',
  'photolab.jobs.startProduct',
  'photolab.jobs.startBatch',
  'photolab.jobs.list',
  'photolab.jobs.status',
  'photolab.jobs.cancel',
  'photolab.products.list',
  'photolab.hardware.probe',
]);
const EXPORTABLE_PRODUCT_KINDS = new Set([
  'depth',
  'dense',
  'dem',
  'orthomosaic',
  'mesh',
  'gaussianSplat',
]);

app.commandLine.appendSwitch('disable-features', 'MiddleClickAutoscroll');

async function createWindow(): Promise<void> {
  const capturePath = process.env.HIMMELCAD_UI_CAPTURE_PATH?.trim() ?? null;
  const releaseSmokeReport = process.env.HIMMELCAD_RELEASE_SMOKE_REPORT?.trim() ?? null;
  const window = new BrowserWindow({
    title: 'HimmelCAD PhotoLab',
    icon: resolve(__dirname, '../../build/icon.png'),
    width: 1480,
    height: 920,
    minWidth: 980,
    minHeight: 620,
    backgroundColor: '#101114',
    frame: false,
    show: capturePath == null && releaseSmokeReport == null,
    titleBarStyle: 'hidden',
    autoHideMenuBar: true,
    webPreferences: {
      preload: resolve(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webgl: true,
    },
  });
  mainWindow = window;
  window.on('maximize', () => window.webContents.send('window:maximize-changed', true));
  window.on('unmaximize', () => window.webContents.send('window:maximize-changed', false));
  const unsubscribe = onSidecarStderr((line) => window.webContents.send('sidecar:stderr', line));
  window.on('closed', unsubscribe);

  const captureBuiltRenderer = capturePath && process.env.HIMMELCAD_UI_CAPTURE_BUILT === '1';
  if (isDev && !captureBuiltRenderer) await window.loadURL('http://localhost:5174/');
  else await window.loadFile(resolve(__dirname, '../renderer/index.html'));
  if (capturePath) {
    const requestedDelay = Number(process.env.HIMMELCAD_UI_CAPTURE_DELAY_MS ?? 8_000);
    const delay = Number.isFinite(requestedDelay)
      ? Math.max(1_000, Math.min(60_000, requestedDelay))
      : 8_000;
    setTimeout(() => {
      void captureWindow(window, capturePath);
    }, delay);
  }
}

async function runReleaseStartSmoke(destination: string): Promise<void> {
  let timeoutId: NodeJS.Timeout | null = null;
  const timeout = new Promise<never>((_resolve, reject) => {
    timeoutId = setTimeout(
      () => reject(new Error('packaged sidecar did not answer within 30 seconds')),
      30_000,
    );
  });
  try {
    if (!app.isPackaged) throw new Error('release start smoke requires a packaged application');
    const hardware = await Promise.race([
      callSidecar({ method: 'photolab.hardware.probe' }),
      timeout,
    ]);
    await atomicWriteExport(
      destination,
      `${JSON.stringify(
        {
          schemaVersion: 1,
          product: 'HimmelCAD PhotoLab',
          applicationVersion: app.getVersion(),
          platform: `${process.platform}-${process.arch}`,
          packaged: app.isPackaged,
          rendererLoaded: mainWindow != null && !mainWindow.isDestroyed(),
          sidecarRunning: isSidecarRunning(),
          hardware,
        },
        null,
        2,
      )}\n`,
    );
    console.info(`[release-smoke] passed · ${destination}`);
  } catch (error) {
    process.exitCode = 1;
    await atomicWriteExport(
      destination,
      `${JSON.stringify(
        {
          schemaVersion: 1,
          product: 'HimmelCAD PhotoLab',
          platform: `${process.platform}-${process.arch}`,
          packaged: app.isPackaged,
          error: error instanceof Error ? error.message : String(error),
        },
        null,
        2,
      )}\n`,
    ).catch(() => undefined);
    console.error('[release-smoke] failed', error);
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
    app.quit();
  }
}

async function captureWindow(window: BrowserWindow, destination: string): Promise<void> {
  try {
    await mkdir(dirname(destination), { recursive: true });
    const image = await window.webContents.capturePage();
    await writeFile(destination, image.toPNG());
    console.info(`[ui-capture] wrote ${destination}`);
  } catch (error) {
    console.error('[ui-capture] failed', error);
  } finally {
    if (process.env.HIMMELCAD_UI_CAPTURE_EXIT === '1') app.quit();
  }
}

function safeExportName(name: string, kind: string): string {
  const cleaned = name
    .normalize('NFC')
    .replaceAll(/[^\p{L}\p{N} _-]+/gu, '_')
    .trim()
    .slice(0, 80);
  const base = cleaned || 'PhotoLab-Product';
  if (kind === 'depth') return `${base}-Depth-Maps`;
  if (kind === 'mesh') return `${base}-Mesh`;
  return base;
}

function exportExtension(kind: string): string {
  if (kind === 'dem' || kind === 'orthomosaic') return 'tif';
  if (kind === 'dense' || kind === 'gaussianSplat') return 'ply';
  throw new Error(`Product kind “${kind}” is exported as a package`);
}

function exportFilterName(kind: string): string {
  if (kind === 'dem') return 'Cloud Optimized GeoTIFF (DEM)';
  if (kind === 'orthomosaic') return 'Cloud Optimized GeoTIFF (Orthomosaic)';
  if (kind === 'gaussianSplat') return 'Gaussian-Splat PLY';
  return 'Point Cloud (PLY)';
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function atomicWriteExport(path: string, data: string | Uint8Array): Promise<void> {
  const temporaryPath = join(dirname(path), `.${basename(path)}.${randomUUID()}.tmp`);
  try {
    await writeFile(temporaryPath, data, { mode: 0o600 });
    await rename(temporaryPath, path);
  } finally {
    await rm(temporaryPath, { force: true }).catch(() => undefined);
  }
}

function startProductExport(entityId: string, destinationPath: string): Promise<unknown> {
  return callSidecar({
    method: 'photolab.jobs.startProductExport',
    params: {
      operationId: `export-${randomUUID()}`,
      entityId,
      destinationPath,
    },
  });
}

function requireProductExportConfirmation(
  entityId: string,
  destinationPath: string,
  displayName: string,
): { confirmation: { token: string; displayName: string } } {
  const token = randomUUID();
  const cutoff = Date.now() - 15 * 60_000;
  for (const [candidate, pending] of pendingProductExports) {
    if (pending.createdAt < cutoff) pendingProductExports.delete(candidate);
  }
  pendingProductExports.set(token, {
    entityId,
    destinationPath,
    createdAt: Date.now(),
  });
  return { confirmation: { token, displayName } };
}

function registerIpc(): void {
  ipcMain.handle('window:minimize', () => mainWindow?.minimize());
  ipcMain.handle('window:maximize-toggle', () => {
    if (!mainWindow) return false;
    if (mainWindow.isMaximized()) mainWindow.unmaximize();
    else mainWindow.maximize();
    return mainWindow.isMaximized();
  });
  ipcMain.handle('window:close', () => mainWindow?.close());
  ipcMain.handle('window:is-maximized', () => mainWindow?.isMaximized() ?? false);
  ipcMain.handle('sidecar:status', () => isSidecarRunning());
  ipcMain.handle('preferences:gcp-csv:get', () => preferences.gcpCsvImportDefaults());
  ipcMain.handle('preferences:gcp-csv:save', (_event, value: unknown) =>
    preferences.rememberGcpCsvImportDefaults(value),
  );
  ipcMain.handle('sidecar:call', (_event, method: string, params: unknown) => {
    if (!RENDERER_SIDECAR_METHODS.has(method)) {
      throw new Error(`Renderer is not allowed to call sidecar method: ${method}`);
    }
    return callSidecar({ method, params });
  });
  ipcMain.handle(
    'products:export',
    async (_event, request: { entityId: string; kind: string; name: string }): Promise<unknown> => {
      if (
        !request ||
        typeof request.entityId !== 'string' ||
        request.entityId.length > 512 ||
        typeof request.kind !== 'string' ||
        !EXPORTABLE_PRODUCT_KINDS.has(request.kind) ||
        typeof request.name !== 'string'
      ) {
        throw new Error('Invalid product export request');
      }
      const packageExport = request.kind === 'depth' || request.kind === 'mesh';
      const safeName = safeExportName(request.name, request.kind);
      let destinationPath: string;
      if (packageExport) {
        const defaultPath = await preferredDirectory('export');
        const selection = mainWindow
          ? await dialog.showOpenDialog(mainWindow, {
              title: `Export ${request.name}`,
              buttonLabel: 'Export here',
              defaultPath,
              properties: ['openDirectory', 'createDirectory'],
            })
          : await dialog.showOpenDialog({
              title: `Export ${request.name}`,
              buttonLabel: 'Export here',
              defaultPath,
              properties: ['openDirectory', 'createDirectory'],
            });
        const parent = selection.filePaths[0];
        if (selection.canceled || !parent) return null;
        await preferences.rememberDirectory('export', parent);
        destinationPath = join(parent, safeName);
      } else {
        const extension = exportExtension(request.kind);
        const defaultPath = join(await preferredDirectory('export'), `${safeName}.${extension}`);
        const selection = mainWindow
          ? await dialog.showSaveDialog(mainWindow, {
              title: `Export ${request.name}`,
              defaultPath,
              properties: ['createDirectory'],
              filters: [{ name: exportFilterName(request.kind), extensions: [extension] }],
            })
          : await dialog.showSaveDialog({
              title: `Export ${request.name}`,
              defaultPath,
              properties: ['createDirectory'],
              filters: [{ name: exportFilterName(request.kind), extensions: [extension] }],
            });
        if (selection.canceled || !selection.filePath) return null;
        destinationPath = selection.filePath;
        await preferences.rememberDirectory('export', dirname(destinationPath));
      }
      if (await pathExists(destinationPath)) {
        return requireProductExportConfirmation(request.entityId, destinationPath, safeName);
      }
      return startProductExport(request.entityId, destinationPath);
    },
  );
  ipcMain.handle('products:export-confirm', (_event, token: string) => {
    if (typeof token !== 'string' || token.length > 128) {
      throw new Error('Invalid product export confirmation');
    }
    const pending = pendingProductExports.get(token);
    if (!pending || Date.now() - pending.createdAt > 15 * 60_000) {
      pendingProductExports.delete(token);
      throw new Error('The product export confirmation expired. Choose the destination again.');
    }
    pendingProductExports.delete(token);
    return startProductExport(pending.entityId, pending.destinationPath);
  });
  ipcMain.handle('products:export-cancel', (_event, token: string) => {
    if (typeof token === 'string') pendingProductExports.delete(token);
  });
  ipcMain.handle(
    'reports:save',
    async (
      _event,
      request: { format: 'html' | 'pdf'; suggestedName: string; html: string },
    ): Promise<boolean> => {
      if (
        !request ||
        !['html', 'pdf'].includes(request.format) ||
        typeof request.suggestedName !== 'string' ||
        typeof request.html !== 'string' ||
        request.html.length === 0 ||
        request.html.length > 5 * 1024 * 1024 ||
        !request.html.startsWith('<!doctype html>') ||
        /<(script|iframe|object|embed|link)\b/i.test(request.html)
      ) {
        throw new Error('Invalid processing report');
      }
      const suggestedName =
        request.suggestedName
          .normalize('NFKD')
          .replace(/[^a-zA-Z0-9._-]+/g, '-')
          .replace(/^-+|-+$/g, '')
          .slice(0, 96) || 'himmelcad-photolab-report';
      const defaultPath = join(
        await preferredDirectory('export'),
        `${suggestedName}.${request.format}`,
      );
      const selection = mainWindow
        ? await dialog.showSaveDialog(mainWindow, {
            title: `Export processing report as ${request.format.toUpperCase()}`,
            defaultPath,
            properties: ['createDirectory', 'showOverwriteConfirmation'],
            filters: [
              {
                name: request.format === 'pdf' ? 'PDF report' : 'HTML report',
                extensions: [request.format],
              },
            ],
          })
        : await dialog.showSaveDialog({
            title: `Export processing report as ${request.format.toUpperCase()}`,
            defaultPath,
            properties: ['createDirectory', 'showOverwriteConfirmation'],
            filters: [
              {
                name: request.format === 'pdf' ? 'PDF report' : 'HTML report',
                extensions: [request.format],
              },
            ],
          });
      if (selection.canceled || !selection.filePath) return false;
      if (request.format === 'html') {
        await atomicWriteExport(selection.filePath, request.html);
        await preferences.rememberDirectory('export', dirname(selection.filePath));
        return true;
      }
      const reportWindow = new BrowserWindow({
        show: false,
        webPreferences: {
          contextIsolation: true,
          nodeIntegration: false,
          sandbox: true,
          javascript: false,
        },
      });
      reportWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
      try {
        await reportWindow.loadURL(
          `data:text/html;charset=utf-8,${encodeURIComponent(request.html)}`,
        );
        reportWindow.webContents.on('will-navigate', (event) => event.preventDefault());
        const pdf = await reportWindow.webContents.printToPDF({
          pageSize: 'A4',
          printBackground: true,
          margins: { top: 0.4, bottom: 0.4, left: 0.4, right: 0.4 },
        });
        await atomicWriteExport(selection.filePath, pdf);
        await preferences.rememberDirectory('export', dirname(selection.filePath));
        return true;
      } finally {
        reportWindow.destroy();
      }
    },
  );
  ipcMain.handle('batch:load', async () => {
    const defaultPath = await preferredDirectory('batch');
    const selection = mainWindow
      ? await dialog.showOpenDialog(mainWindow, {
          title: 'Load PhotoLab Batch',
          defaultPath,
          properties: ['openFile'],
          filters: [{ name: 'PhotoLab Batch', extensions: ['hcbatch', 'json'] }],
        })
      : await dialog.showOpenDialog({
          title: 'Load PhotoLab Batch',
          defaultPath,
          properties: ['openFile'],
          filters: [{ name: 'PhotoLab Batch', extensions: ['hcbatch', 'json'] }],
        });
    const path = selection.filePaths[0];
    if (selection.canceled || !path) return null;
    await preferences.rememberDirectory('batch', dirname(path));
    const bytes = await readFile(path);
    if (bytes.byteLength > 4 * 1024 * 1024) throw new Error('Batch file exceeds 4 MiB');
    return JSON.parse(bytes.toString('utf8')) as unknown;
  });
  ipcMain.handle('batch:save', async (_event, value: unknown) => {
    const encoded = JSON.stringify(value, null, 2);
    if (encoded.length > 4 * 1024 * 1024) throw new Error('Batch file exceeds 4 MiB');
    JSON.parse(encoded);
    const defaultPath = join(await preferredDirectory('batch'), 'PhotoLab-Pipeline.hcbatch');
    const selection = mainWindow
      ? await dialog.showSaveDialog(mainWindow, {
          title: 'Save PhotoLab Batch',
          defaultPath,
          properties: ['createDirectory', 'showOverwriteConfirmation'],
          filters: [{ name: 'PhotoLab Batch', extensions: ['hcbatch'] }],
        })
      : await dialog.showSaveDialog({
          title: 'Save PhotoLab Batch',
          defaultPath,
          properties: ['createDirectory', 'showOverwriteConfirmation'],
          filters: [{ name: 'PhotoLab Batch', extensions: ['hcbatch'] }],
        });
    if (selection.canceled || !selection.filePath) return false;
    await preferences.rememberDirectory('batch', dirname(selection.filePath));
    await writeFile(selection.filePath, encoded, { encoding: 'utf8', mode: 0o600 });
    return true;
  });

  // Import transform workflows (JSON body, extension `.hcimport`).
  ipcMain.handle('workflows:default-dir', async () => {
    const dir = await preferredDirectory('importWorkflow');
    await mkdir(dir, { recursive: true });
    return dir;
  });
  ipcMain.handle('workflows:list', async () => {
    const dir = await preferredDirectory('importWorkflow');
    await mkdir(dir, { recursive: true });
    try {
      const names = await readdir(dir);
      const items: Array<{
        name: string;
        path: string;
        savedAt: string;
        kind?: string;
        description?: string;
      }> = [];
      for (const name of names) {
        const lower = name.toLowerCase();
        if (!lower.endsWith('.hcimport') && !lower.endsWith('.json')) continue;
        const path = join(dir, name);
        try {
          const bytes = await readFile(path, 'utf8');
          if (bytes.length > 2 * 1024 * 1024) continue;
          const parsed = JSON.parse(bytes) as {
            name?: string;
            kind?: string;
            description?: string;
            savedAt?: string;
          };
          const st = await stat(path);
          const item: {
            name: string;
            path: string;
            savedAt: string;
            kind?: string;
            description?: string;
          } = {
            name:
              typeof parsed.name === 'string' && parsed.name.trim()
                ? parsed.name
                : name.replace(/\.(hcimport|json)$/i, ''),
            path,
            savedAt: typeof parsed.savedAt === 'string' ? parsed.savedAt : st.mtime.toISOString(),
          };
          if (typeof parsed.kind === 'string') item.kind = parsed.kind;
          if (typeof parsed.description === 'string') item.description = parsed.description;
          items.push(item);
        } catch {
          /* skip unreadable */
        }
      }
      items.sort((a, b) => (a.savedAt < b.savedAt ? 1 : -1));
      return items;
    } catch {
      return [];
    }
  });
  ipcMain.handle('workflows:load-path', async (_event, filePath: unknown) => {
    if (typeof filePath !== 'string' || !filePath.trim()) {
      throw new Error('Invalid workflow path');
    }
    const path = resolve(filePath);
    const bytes = await readFile(path, 'utf8');
    if (bytes.length > 2 * 1024 * 1024) throw new Error('Workflow file exceeds 2 MiB');
    return { path, workflow: JSON.parse(bytes) as unknown };
  });
  ipcMain.handle('workflows:open', async () => {
    const defaultPath = await preferredDirectory('importWorkflow');
    await mkdir(defaultPath, { recursive: true });
    const filters = [
      { name: 'Import coordinate workflow', extensions: ['hcimport'] },
      { name: 'Legacy JSON', extensions: ['json'] },
    ];
    const selection = mainWindow
      ? await dialog.showOpenDialog(mainWindow, {
          title: 'Open import workflow',
          defaultPath,
          properties: ['openFile'],
          filters,
        })
      : await dialog.showOpenDialog({
          title: 'Open import workflow',
          defaultPath,
          properties: ['openFile'],
          filters,
        });
    const path = selection.filePaths[0];
    if (selection.canceled || !path) return null;
    await preferences.rememberDirectory('importWorkflow', dirname(path));
    const bytes = await readFile(path, 'utf8');
    if (bytes.length > 2 * 1024 * 1024) throw new Error('Workflow file exceeds 2 MiB');
    return { path, workflow: JSON.parse(bytes) as unknown };
  });
  ipcMain.handle(
    'workflows:save',
    async (_event, request: { suggestedName?: string; workflow: unknown }) => {
      if (!request || typeof request.workflow !== 'object' || request.workflow == null) {
        throw new Error('Invalid workflow save request');
      }
      const encoded = JSON.stringify(request.workflow, null, 2);
      if (encoded.length > 2 * 1024 * 1024) throw new Error('Workflow file exceeds 2 MiB');
      JSON.parse(encoded);
      const stem =
        typeof request.suggestedName === 'string' && request.suggestedName.trim()
          ? request.suggestedName
              .trim()
              .replace(/[<>:"/\\|?*\u0000-\u001f]+/g, '_')
              .replace(/\.(hcimport|json)$/i, '')
          : 'import-workflow';
      const defaultPath = join(await preferredDirectory('importWorkflow'), `${stem}.hcimport`);
      await mkdir(dirname(defaultPath), { recursive: true });
      const selection = mainWindow
        ? await dialog.showSaveDialog(mainWindow, {
            title: 'Save import workflow',
            defaultPath,
            properties: ['createDirectory', 'showOverwriteConfirmation'],
            filters: [{ name: 'Import coordinate workflow', extensions: ['hcimport'] }],
          })
        : await dialog.showSaveDialog({
            title: 'Save import workflow',
            defaultPath,
            properties: ['createDirectory', 'showOverwriteConfirmation'],
            filters: [{ name: 'Import coordinate workflow', extensions: ['hcimport'] }],
          });
      if (selection.canceled || !selection.filePath) return null;
      let filePath = selection.filePath;
      if (!filePath.toLowerCase().endsWith('.hcimport')) {
        filePath = filePath.replace(/\.json$/i, '');
        if (!filePath.toLowerCase().endsWith('.hcimport')) filePath = `${filePath}.hcimport`;
      }
      await preferences.rememberDirectory('importWorkflow', dirname(filePath));
      await writeFile(filePath, encoded, { encoding: 'utf8', mode: 0o600 });
      return { path: filePath, name: basename(filePath).replace(/\.hcimport$/i, '') };
    },
  );

  // Alignment presets (JSON body, extension `.hcalign`).
  ipcMain.handle('alignment-presets:default-dir', async () => {
    const dir = await preferredDirectory('alignmentPreset');
    await mkdir(dir, { recursive: true });
    return dir;
  });
  ipcMain.handle('alignment-presets:list', async () => {
    const dir = await preferredDirectory('alignmentPreset');
    await mkdir(dir, { recursive: true });
    try {
      const names = await readdir(dir);
      const items: Array<{
        name: string;
        path: string;
        savedAt: string;
        profile?: string;
        description?: string;
      }> = [];
      for (const name of names) {
        if (!name.toLowerCase().endsWith('.hcalign')) continue;
        const path = join(dir, name);
        try {
          const bytes = await readFile(path, 'utf8');
          if (bytes.length > 2 * 1024 * 1024) continue;
          const parsed = JSON.parse(bytes) as {
            name?: string;
            profile?: string;
            description?: string;
            savedAt?: string;
            kind?: string;
          };
          if (parsed.kind && parsed.kind !== 'alignmentPreset') continue;
          const st = await stat(path);
          const item: {
            name: string;
            path: string;
            savedAt: string;
            profile?: string;
            description?: string;
          } = {
            name:
              typeof parsed.name === 'string' && parsed.name.trim()
                ? parsed.name
                : name.replace(/\.hcalign$/i, ''),
            path,
            savedAt: typeof parsed.savedAt === 'string' ? parsed.savedAt : st.mtime.toISOString(),
          };
          if (typeof parsed.profile === 'string') item.profile = parsed.profile;
          if (typeof parsed.description === 'string') item.description = parsed.description;
          items.push(item);
        } catch {
          /* skip */
        }
      }
      items.sort((a, b) => (a.savedAt < b.savedAt ? 1 : -1));
      return items;
    } catch {
      return [];
    }
  });
  ipcMain.handle('alignment-presets:load-path', async (_event, filePath: unknown) => {
    if (typeof filePath !== 'string' || !filePath.trim()) {
      throw new Error('Invalid alignment preset path');
    }
    const path = resolve(filePath);
    const bytes = await readFile(path, 'utf8');
    if (bytes.length > 2 * 1024 * 1024) throw new Error('Alignment preset exceeds 2 MiB');
    let parsed: unknown;
    try {
      parsed = JSON.parse(bytes);
    } catch {
      throw new Error('Alignment preset is not valid JSON');
    }
    return { path, preset: parsed };
  });
  ipcMain.handle('alignment-presets:open', async () => {
    const defaultPath = await preferredDirectory('alignmentPreset');
    await mkdir(defaultPath, { recursive: true });
    const filters = [{ name: 'PhotoLab alignment preset', extensions: ['hcalign'] }];
    const selection = mainWindow
      ? await dialog.showOpenDialog(mainWindow, {
          title: 'Open alignment preset',
          defaultPath,
          properties: ['openFile'],
          filters,
        })
      : await dialog.showOpenDialog({
          title: 'Open alignment preset',
          defaultPath,
          properties: ['openFile'],
          filters,
        });
    const path = selection.filePaths[0];
    if (selection.canceled || !path) return null;
    await preferences.rememberDirectory('alignmentPreset', dirname(path));
    const bytes = await readFile(path, 'utf8');
    if (bytes.length > 2 * 1024 * 1024) throw new Error('Alignment preset exceeds 2 MiB');
    let parsed: unknown;
    try {
      parsed = JSON.parse(bytes);
    } catch {
      throw new Error('Alignment preset is not valid JSON');
    }
    return { path, preset: parsed };
  });
  ipcMain.handle(
    'alignment-presets:save',
    async (_event, request: { suggestedName?: string; preset: unknown }) => {
      if (!request || typeof request.preset !== 'object' || request.preset == null) {
        throw new Error('Invalid alignment preset save request');
      }
      const encoded = JSON.stringify(request.preset, null, 2);
      if (encoded.length > 2 * 1024 * 1024) throw new Error('Alignment preset exceeds 2 MiB');
      JSON.parse(encoded);
      const stem =
        typeof request.suggestedName === 'string' && request.suggestedName.trim()
          ? request.suggestedName
              .trim()
              .replace(/[<>:"/\\|?*\u0000-\u001f]+/g, '_')
              .replace(/\.hcalign$/i, '')
          : 'alignment-preset';
      const defaultPath = join(await preferredDirectory('alignmentPreset'), `${stem}.hcalign`);
      await mkdir(dirname(defaultPath), { recursive: true });
      const selection = mainWindow
        ? await dialog.showSaveDialog(mainWindow, {
            title: 'Save alignment preset',
            defaultPath,
            properties: ['createDirectory', 'showOverwriteConfirmation'],
            filters: [{ name: 'PhotoLab alignment preset', extensions: ['hcalign'] }],
          })
        : await dialog.showSaveDialog({
            title: 'Save alignment preset',
            defaultPath,
            properties: ['createDirectory', 'showOverwriteConfirmation'],
            filters: [{ name: 'PhotoLab alignment preset', extensions: ['hcalign'] }],
          });
      if (selection.canceled || !selection.filePath) return null;
      let filePath = selection.filePath;
      if (!filePath.toLowerCase().endsWith('.hcalign')) filePath = `${filePath}.hcalign`;
      await preferences.rememberDirectory('alignmentPreset', dirname(filePath));
      await writeFile(filePath, encoded, { encoding: 'utf8', mode: 0o600 });
      return { path: filePath, name: basename(filePath, '.hcalign') };
    },
  );

  ipcMain.handle('project:bootstrap', async () => {
    try {
      return rememberProject(await callSidecar({ method: 'photolab.project.snapshot' }));
    } catch {
      // Development sessions are deliberately disposable: always boot into a clean
      // project unless a capture project was explicitly requested. Packaged builds
      // retain normal last-project restoration.
      const previous =
        isDev && !process.env.HIMMELCAD_UI_PROJECT_PATH ? null : await readLastProjectPath();
      if (previous) {
        try {
          return rememberProject(
            await callSidecar({
              method: 'photolab.project.open',
              params: {
                path: previous,
                workingRoot: resolve(app.getPath('userData'), 'cache'),
                useLocalWorkingCopy: previous.toLowerCase().endsWith('.hcadx'),
                recoverExistingWorkingCopy: true,
                archiveOperationId: `archive-bootstrap-${randomUUID()}`,
                progressKey: `project-bootstrap:${Date.now()}`,
              },
            }),
          );
        } catch (error) {
          console.warn(`Last PhotoLab project could not be reopened: ${String(error)}`);
        }
      }
      const timestamp = new Date().toISOString().replaceAll(/[:.]/g, '-');
      return rememberProject(
        await callSidecar({
          method: 'photolab.project.create',
          params: {
            path: resolve(app.getPath('userData'), 'projects', `Untitled-${timestamp}.hcad`),
            name: 'Untitled PhotoLab Project',
          },
        }),
      );
    }
  });
  ipcMain.handle('project:create', async (_event, value: unknown) => {
    const operation = projectArchiveOperationRequest(value);
    const options: Electron.SaveDialogOptions = {
      title: 'Create PhotoLab Project',
      defaultPath: join(await preferredDirectory('project'), 'PhotoLab-Project.hcadx'),
      filters: [{ name: 'HimmelCAD PhotoLab Project', extensions: ['hcadx'] }],
      properties: ['createDirectory', 'showOverwriteConfirmation'],
    };
    const selection = mainWindow
      ? await dialog.showSaveDialog(mainWindow, options)
      : await dialog.showSaveDialog(options);
    if (selection.canceled || !selection.filePath) return null;
    await preferences.rememberDirectory('project', dirname(selection.filePath));
    const previous = await currentProjectSessionSnapshot();
    const localPath = resolve(
      app.getPath('userData'),
      'cache',
      'photolab',
      'workspaces',
      `new-${randomUUID()}.hcad`,
    );
    try {
      await callSidecar({ method: 'photolab.project.close' });
      await callSidecar({
        method: 'photolab.project.create',
        params: {
          path: localPath,
          name:
            selection.filePath
              .split(/[\\/]/)
              .at(-1)
              ?.replace(/\.hcadx$/i, '') ?? 'PhotoLab Project',
        },
      });
      await callSidecar({
        method: 'photolab.project.saveAs',
        params: archiveOperationParams(selection.filePath, true, operation),
      });
      return rememberProject(await callSidecar({ method: 'photolab.project.snapshot' }));
    } catch (error) {
      await restoreProjectSession(previous).catch((restoreError: unknown) => {
        console.error('Previous project session could not be restored', restoreError);
      });
      throw error;
    }
  });
  ipcMain.handle('project:open', async (_event, value: unknown) => {
    const operation = projectArchiveOperationRequest(value);
    const options: Electron.OpenDialogOptions = {
      title: 'Open PhotoLab Project',
      defaultPath: await preferredDirectory('project'),
      properties: ['openFile', 'openDirectory'],
      filters: [{ name: 'HimmelCAD PhotoLab Project', extensions: ['hcadx'] }],
    };
    const selection = mainWindow
      ? await dialog.showOpenDialog(mainWindow, options)
      : await dialog.showOpenDialog(options);
    const selectedPath = selection.filePaths[0];
    if (selection.canceled || !selectedPath) return null;
    await preferences.rememberDirectory('project', dirname(selectedPath));
    const previous = await currentProjectSessionSnapshot();
    try {
      await callSidecar({ method: 'photolab.project.close' });
      return rememberProject(
        await callSidecar({
          method: 'photolab.project.open',
          params: {
            path: selectedPath,
            workingRoot: resolve(app.getPath('userData'), 'cache'),
            useLocalWorkingCopy: true,
            recoverExistingWorkingCopy: true,
            ...operation,
          },
        }),
      );
    } catch (error) {
      await restoreProjectSession(previous).catch((restoreError: unknown) => {
        console.error('Previous project session could not be restored', restoreError);
      });
      throw error;
    }
  });
  ipcMain.handle('project:save', async (_event, value: unknown) => {
    const operation = projectArchiveOperationRequest(value);
    const snapshot = await callSidecar<{
      session: { sourcePath: string };
    }>({ method: 'photolab.project.snapshot' });
    // Untitled folder projects are never a durable archive — first Save is Save As.
    if (!snapshot.session.sourcePath.toLowerCase().endsWith('.hcadx')) {
      return saveProjectAsWithDialog(operation, null);
    }
    // Already bound to a .hcadx path: re-zip the local working copy into that file.
    await callSidecar({
      method: 'photolab.project.saveAs',
      params: archiveOperationParams(snapshot.session.sourcePath, true, operation),
    });
    return rememberProject(await callSidecar({ method: 'photolab.project.snapshot' }));
  });
  ipcMain.handle('project:save-as', async (_event, value: unknown) => {
    const operation = projectArchiveOperationRequest(value);
    const snapshot = await callSidecar<{
      session: { sourcePath: string };
    }>({ method: 'photolab.project.snapshot' });
    const defaultPath = snapshot.session.sourcePath.toLowerCase().endsWith('.hcadx')
      ? snapshot.session.sourcePath
      : null;
    return saveProjectAsWithDialog(operation, defaultPath);
  });
  ipcMain.handle('project:archive-cancel', (_event, archiveOperationId: string) =>
    callSidecar({
      method: 'photolab.project.archive.cancel',
      params: { archiveOperationId },
    }),
  );
  ipcMain.handle('images:select-files', async () => {
    const options: Electron.OpenDialogOptions = {
      title: 'Import Images',
      defaultPath: await preferredDirectory('image'),
      properties: ['openFile', 'multiSelections'],
      filters: [
        {
          name: 'PhotoLab imports',
          extensions: [
            'hcap',
            'jpg',
            'jpeg',
            'tif',
            'tiff',
            'dng',
            'png',
            'heic',
            'heif',
            'avif',
            'cr3',
            'raf',
            'iiq',
          ],
        },
        {
          name: 'HimmelCAD Cap project',
          extensions: ['hcap'],
        },
        {
          name: 'PhotoLab Images',
          extensions: [
            'jpg',
            'jpeg',
            'tif',
            'tiff',
            'dng',
            'png',
            'heic',
            'heif',
            'avif',
            'cr3',
            'raf',
            'iiq',
          ],
        },
      ],
    };
    const selection = mainWindow
      ? await dialog.showOpenDialog(mainWindow, options)
      : await dialog.showOpenDialog(options);
    const firstPath = selection.filePaths[0];
    if (selection.canceled || !firstPath) return null;
    await preferences.rememberDirectory('image', dirname(firstPath));
    return selection.filePaths;
  });
  ipcMain.handle('images:select-folder', async () => {
    const options: Electron.OpenDialogOptions = {
      title: 'Import Image Folder',
      defaultPath: await preferredDirectory('image'),
      properties: ['openDirectory'],
    };
    const selection = mainWindow
      ? await dialog.showOpenDialog(mainWindow, options)
      : await dialog.showOpenDialog(options);
    const selectedPath = selection.filePaths[0];
    if (selection.canceled || !selectedPath) return null;
    await preferences.rememberDirectory('image', selectedPath);
    return [selectedPath];
  });
  ipcMain.handle('himmelcap:select-file', async () => {
    const options: Electron.OpenDialogOptions = {
      title: 'Import HimmelCAD Cap Project',
      defaultPath: await preferredDirectory('image'),
      properties: ['openFile'],
      filters: [
        {
          name: 'HimmelCAD Cap project',
          extensions: ['hcap'],
        },
      ],
    };
    const selection = mainWindow
      ? await dialog.showOpenDialog(mainWindow, options)
      : await dialog.showOpenDialog(options);
    const selectedPath = selection.filePaths[0];
    if (selection.canceled || !selectedPath) return null;
    await preferences.rememberDirectory('image', dirname(selectedPath));
    return selectedPath;
  });
  ipcMain.handle(
    'grids:select',
    async (_event, requestedKindOrProgressKey?: string, requestedProgressKey?: string) => {
      const requestedKind =
        requestedKindOrProgressKey === 'vertical' || requestedKindOrProgressKey === 'horizontal'
          ? requestedKindOrProgressKey
          : null;
      const progressKey = requestedKind ? requestedProgressKey : requestedKindOrProgressKey;
      const directoryKey = requestedKind === 'vertical' ? 'verticalGrid' : 'horizontalGrid';
      const options: Electron.OpenDialogOptions = {
        title:
          requestedKind === 'vertical'
            ? 'Select Geoid or Quasigeoid Grid'
            : requestedKind === 'horizontal'
              ? 'Select Horizontal Datum Grid'
              : 'Select Geoid or Datum Transformation Grid',
        defaultPath: requestedKind
          ? await preferredDirectory(directoryKey)
          : ((await preferences.directory('horizontalGrid')) ??
            (await preferences.directory('verticalGrid')) ??
            app.getPath('documents')),
        properties: ['openFile'],
        filters: [
          { name: 'PROJ transformation grids', extensions: ['tif', 'tiff', 'gtx', 'gsb', 'bin'] },
          { name: 'All Files', extensions: ['*'] },
        ],
      };
      const selection = mainWindow
        ? await dialog.showOpenDialog(mainWindow, options)
        : await dialog.showOpenDialog(options);
      const source = selection.filePaths[0];
      if (selection.canceled || !source) return null;
      emitDesktopProgress(progressKey, 0.05, 'Registering transformation grid');
      const filename = basename(source);
      const role = requestedKind ?? 'grid';
      const root = join(app.getPath('userData'), 'proj-grids', 'user', role);
      await mkdir(root, { recursive: true });
      const extension = extname(filename)
        .toLowerCase()
        .replace(/[^.a-z0-9]/g, '');
      const safeStem = basename(filename, extname(filename)).replace(/[^a-zA-Z0-9._-]+/g, '_');
      const localPath = join(root, `${safeStem || 'grid'}${extension || '.bin'}`);
      const registered = await stat(localPath).catch(() => null);
      if (!registered) {
        emitDesktopProgress(progressKey, 0.25, 'Copying transformation grid');
        try {
          await copyFile(source, localPath, fsConstants.COPYFILE_FICLONE);
        } catch {
          await copyFile(source, localPath);
        }
      }
      emitDesktopProgress(
        progressKey,
        0.75,
        registered ? 'Using registered transformation grid' : 'Reading grid coverage',
      );
      const grid = await inspectGrid(localPath, requestedKind);
      await preferences.rememberDirectory(
        grid.kind === 'geoid' ? 'verticalGrid' : 'horizontalGrid',
        dirname(source),
      );
      emitDesktopProgress(progressKey, 1, 'Transformation grid ready');
      return { filename: basename(localPath), localPath, ...grid };
    },
  );
  ipcMain.handle('reference:select-gcp-csv', async () => {
    const options: Electron.OpenDialogOptions = {
      title: 'Import Ground Control Points',
      defaultPath: projectSourceDirectory() ?? app.getPath('documents'),
      properties: ['openFile'],
      filters: [
        { name: 'Coordinate file', extensions: ['csv', 'txt'] },
        { name: 'All Files', extensions: ['*'] },
      ],
    };
    const selection = mainWindow
      ? await dialog.showOpenDialog(mainWindow, options)
      : await dialog.showOpenDialog(options);
    return selection.canceled ? null : (selection.filePaths[0] ?? null);
  });
}

async function inspectGrid(
  path: string,
  requestedKind: 'vertical' | 'horizontal' | null,
): Promise<{
  kind: 'ntv2' | 'gtg' | 'geoid';
  driver: string;
  coverage: {
    westLongitude: number;
    southLatitude: number;
    eastLongitude: number;
    northLatitude: number;
  };
}> {
  const executable = app.isPackaged
    ? resolve(
        process.resourcesPath,
        'workers',
        'geo',
        'bin',
        process.platform === 'win32' ? 'gdalinfo.exe' : 'gdalinfo',
      )
    : '/usr/bin/gdalinfo';
  const output = await captureProcess(executable, ['-json', path]);
  const info = JSON.parse(output) as {
    driverShortName?: unknown;
    metadata?: Record<string, Record<string, string>>;
    bands?: { unit?: unknown }[];
    wgs84Extent?: { coordinates?: unknown };
    cornerCoordinates?: Record<string, unknown>;
  };
  const points = coordinatePairs(info.wgs84Extent?.coordinates ?? info.cornerCoordinates);
  if (points.length < 2)
    throw new Error('The selected file does not expose a WGS 84 grid coverage');
  const longitudes = points.map(([longitude]) => longitude);
  const latitudes = points.map(([, latitude]) => latitude);
  const driver = typeof info.driverShortName === 'string' ? info.driverShortName : 'unknown';
  const type = info.metadata?.['']?.TYPE?.toUpperCase() ?? '';
  const description = info.metadata?.['']?.TIFFTAG_IMAGEDESCRIPTION?.toUpperCase() ?? '';
  const bandUnit =
    typeof info.bands?.[0]?.unit === 'string' ? info.bands[0].unit.toLowerCase() : '';
  if (
    requestedKind === 'vertical' &&
    driver.toLowerCase() !== 'gtx' &&
    bandUnit !== 'metre' &&
    bandUnit !== 'meter' &&
    !type.includes('VERTICAL') &&
    !description.includes('GEOID') &&
    !description.includes('VERT_DATUM')
  ) {
    throw new Error(
      'The selected raster does not identify itself as a metric geoid or vertical correction grid.',
    );
  }
  // The user chooses the transformation role explicitly. Many valid local GeoTIFF
  // geoids omit GDAL's optional TYPE metadata, so metadata and filenames must not
  // silently override that decision. Driver metadata remains the fallback for the
  // compatibility picker that has no requested role.
  const kind =
    requestedKind === 'vertical'
      ? 'geoid'
      : requestedKind === 'horizontal'
        ? driver.toLowerCase() === 'ntv2'
          ? 'ntv2'
          : 'gtg'
        : driver.toLowerCase() === 'ntv2'
          ? 'ntv2'
          : type.includes('VERTICAL')
            ? 'geoid'
            : 'gtg';
  return {
    kind,
    driver,
    coverage: {
      westLongitude: Math.min(...longitudes),
      southLatitude: Math.min(...latitudes),
      eastLongitude: Math.max(...longitudes),
      northLatitude: Math.max(...latitudes),
    },
  };
}

function coordinatePairs(value: unknown): [number, number][] {
  if (!Array.isArray(value)) {
    if (value && typeof value === 'object')
      return Object.values(value as Record<string, unknown>).flatMap(coordinatePairs);
    return [];
  }
  if (value.length >= 2 && typeof value[0] === 'number' && typeof value[1] === 'number')
    return [[value[0], value[1]]];
  return value.flatMap(coordinatePairs);
}

function captureProcess(executable: string, args: string[]): Promise<string> {
  return new Promise((resolveProcess, rejectProcess) => {
    const child = spawn(executable, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
    child.on('error', rejectProcess);
    child.on('close', (code) => {
      if (code === 0) resolveProcess(Buffer.concat(stdout).toString('utf8'));
      else
        rejectProcess(
          new Error(
            Buffer.concat(stderr).toString('utf8').trim() ||
              `gdalinfo exited with code ${String(code)}`,
          ),
        );
    });
  });
}

function emitDesktopProgress(
  progressKey: string | undefined,
  fraction: number,
  message: string,
): void {
  if (!progressKey || !mainWindow) return;
  mainWindow.webContents.send(
    'sidecar:stderr',
    `__HC_PROGRESS__${JSON.stringify({ progressKey, fraction: Math.max(0, Math.min(1, fraction)), message })}`,
  );
}

function projectArchiveOperationRequest(value: unknown): ProjectArchiveOperationRequest {
  if (!value || typeof value !== 'object')
    throw new Error('Project operation identity is required');
  const candidate = value as Partial<ProjectArchiveOperationRequest>;
  if (
    typeof candidate.archiveOperationId !== 'string' ||
    candidate.archiveOperationId.length === 0 ||
    candidate.archiveOperationId.length > 128 ||
    !/^[a-zA-Z0-9_.-]+$/.test(candidate.archiveOperationId) ||
    typeof candidate.progressKey !== 'string' ||
    candidate.progressKey.length === 0 ||
    candidate.progressKey.length > 192 ||
    !/^[a-zA-Z0-9_.:-]+$/.test(candidate.progressKey)
  ) {
    throw new Error('Invalid project operation identity');
  }
  return {
    archiveOperationId: candidate.archiveOperationId,
    progressKey: candidate.progressKey,
  };
}

function archiveOperationParams(
  path: string,
  overwrite: boolean,
  operation: ProjectArchiveOperationRequest,
) {
  return {
    path,
    overwrite,
    ...operation,
  };
}

/**
 * Save As dialog → pack local working copy to .hcadx → return full project snapshot.
 * Callers always work on the temp/local workspace; the archive is the durable published copy.
 */
async function saveProjectAsWithDialog(
  operation: ProjectArchiveOperationRequest,
  defaultPath: string | null,
): Promise<unknown | null> {
  const options: Electron.SaveDialogOptions = {
    title: 'Save PhotoLab Project As',
    defaultPath: defaultPath ?? join(await preferredDirectory('project'), 'PhotoLab-Project.hcadx'),
    filters: [{ name: 'HimmelCAD PhotoLab Project', extensions: ['hcadx'] }],
    properties: ['createDirectory', 'showOverwriteConfirmation'],
  };
  const selection = mainWindow
    ? await dialog.showSaveDialog(mainWindow, options)
    : await dialog.showSaveDialog(options);
  if (selection.canceled || !selection.filePath) return null;
  await preferences.rememberDirectory('project', dirname(selection.filePath));
  await callSidecar({
    method: 'photolab.project.saveAs',
    params: archiveOperationParams(selection.filePath, true, operation),
  });
  return rememberProject(await callSidecar({ method: 'photolab.project.snapshot' }));
}

async function currentProjectSessionSnapshot(): Promise<CurrentProjectSessionSnapshot | null> {
  try {
    return await callSidecar<CurrentProjectSessionSnapshot>({
      method: 'photolab.project.snapshot',
    });
  } catch {
    return null;
  }
}

async function restoreProjectSession(
  previous: CurrentProjectSessionSnapshot | null,
): Promise<void> {
  if (!previous) return;
  await callSidecar({ method: 'photolab.project.close' }).catch(() => undefined);
  const restoreOperation: ProjectArchiveOperationRequest = {
    archiveOperationId: `archive-restore-${randomUUID()}`,
    progressKey: `project-restore:${randomUUID()}`,
  };
  rememberProject(
    await callSidecar({
      method: 'photolab.project.open',
      params: {
        path: previous.session.sourcePath,
        workingRoot: resolve(app.getPath('userData'), 'cache'),
        useLocalWorkingCopy: previous.session.usesLocalWorkingCopy,
        recoverExistingWorkingCopy: true,
        ...restoreOperation,
      },
    }),
  );
}

function rememberProject<T>(result: T): T {
  const candidate = result as { session?: { workingPath?: unknown; sourcePath?: unknown } };
  currentWorkingPath =
    typeof candidate.session?.workingPath === 'string'
      ? resolve(candidate.session.workingPath)
      : currentWorkingPath;
  if (typeof candidate.session?.sourcePath === 'string') {
    currentProjectSourcePath = resolve(candidate.session.sourcePath);
    void persistLastProjectPath(currentProjectSourcePath);
  }
  return result;
}

async function readLastProjectPath(): Promise<string | null> {
  const captureProject = process.env.HIMMELCAD_UI_PROJECT_PATH?.trim();
  if (captureProject) {
    await stat(captureProject);
    return resolve(captureProject);
  }
  try {
    const preferred = await preferences.lastProjectPath();
    if (preferred) {
      await stat(preferred);
      return preferred;
    }
    const value = JSON.parse(
      await readFile(resolve(app.getPath('userData'), 'last-project.json'), 'utf8'),
    ) as { path?: unknown };
    if (typeof value.path !== 'string') return null;
    await stat(value.path);
    return resolve(value.path);
  } catch {
    return null;
  }
}

async function persistLastProjectPath(path: string): Promise<void> {
  if (process.env.HIMMELCAD_UI_CAPTURE_PATH) return;
  try {
    await preferences.rememberLastProjectPath(path);
    await preferences.rememberDirectory('project', dirname(path));
  } catch (error) {
    console.warn(`Last PhotoLab project path could not be stored: ${String(error)}`);
  }
}

function projectSourceDirectory(): string | null {
  return currentProjectSourcePath ? dirname(currentProjectSourcePath) : null;
}

async function preferredDirectory(key: DirectoryPreference): Promise<string> {
  const remembered = await preferences.directory(key);
  if (remembered) return remembered;
  if (key === 'image') return projectSourceDirectory() ?? app.getPath('pictures');
  if (key === 'importWorkflow') {
    return join(app.getPath('documents'), 'HimmelCAD', 'import-workflows');
  }
  if (key === 'alignmentPreset') {
    return join(app.getPath('documents'), 'HimmelCAD', 'alignment-presets');
  }
  return projectSourceDirectory() ?? app.getPath('documents');
}

function registerProjectProtocols(): void {
  protocol.handle('hcad-image', async (request) => {
    const url = new URL(request.url);
    const hash = url.pathname.replace(/^\/+/, '');
    if (url.host !== 'project' || !/^[a-f0-9]{64}$/.test(hash) || !currentWorkingPath) {
      return new Response('forbidden', { status: 403 });
    }
    const previewRequested = url.searchParams.get('preview') === '1';
    let root = resolve(currentWorkingPath, previewRequested ? 'previews' : 'objects');
    let imagePath = previewRequested
      ? resolve(root, `${hash}.jpg`)
      : resolve(root, hash.slice(0, 2), hash.slice(2));
    if (previewRequested) {
      try {
        if (!(await stat(imagePath)).isFile()) throw new Error('preview unavailable');
      } catch {
        const objectRoot = resolve(currentWorkingPath, 'objects');
        const sourceImagePath = resolve(objectRoot, hash.slice(0, 2), hash.slice(2));
        try {
          await ensureProjectPreview(hash, sourceImagePath, imagePath);
        } catch {
          root = objectRoot;
          imagePath = sourceImagePath;
        }
      }
    }
    const relativeImagePath = relative(root, imagePath);
    if (relativeImagePath.startsWith('..') || isAbsolute(relativeImagePath)) {
      return new Response('forbidden', { status: 403 });
    }
    try {
      const metadata = await stat(imagePath);
      if (!metadata.isFile()) return new Response('not found', { status: 404 });
      const body = Readable.toWeb(createReadStream(imagePath)) as ReadableStream;
      return new Response(body, {
        headers: {
          'content-type': previewRequested
            ? 'image/jpeg'
            : imageContentType(url.searchParams.get('format')),
          'content-length': String(metadata.size),
          'cache-control': 'private, max-age=31536000, immutable',
          'x-content-type-options': 'nosniff',
        },
      });
    } catch {
      return new Response('not found', { status: 404 });
    }
  });
  protocol.handle('hcad-product', serveProjectProduct);
}

async function ensureProjectPreview(
  hash: string,
  sourceImagePath: string,
  previewPath: string,
): Promise<void> {
  const existing = previewGenerationTasks.get(hash);
  if (existing) return existing;
  const task = withPreviewGenerationSlot(async () => {
    try {
      if ((await stat(previewPath)).isFile()) return;
    } catch {
      // Missing previews are expected for projects created before preview import.
    }
    const decoded = nativeImage.createFromBuffer(await readFile(sourceImagePath));
    if (decoded.isEmpty()) throw new Error('preview decoder returned an empty image');
    const dimensions = decoded.getSize();
    const scale = Math.min(1, 1600 / Math.max(dimensions.width, dimensions.height));
    const thumbnail =
      scale < 1
        ? decoded.resize({
            width: Math.max(1, Math.round(dimensions.width * scale)),
            height: Math.max(1, Math.round(dimensions.height * scale)),
            quality: 'best',
          })
        : decoded;
    await mkdir(dirname(previewPath), { recursive: true });
    await writeFile(previewPath, thumbnail.toJPEG(86));
  });
  previewGenerationTasks.set(hash, task);
  try {
    await task;
  } finally {
    previewGenerationTasks.delete(hash);
  }
}

async function withPreviewGenerationSlot<T>(operation: () => Promise<T>): Promise<T> {
  if (activePreviewGenerations >= MAX_PARALLEL_PREVIEW_GENERATIONS) {
    await new Promise<void>((resolveSlot) => previewGenerationWaiters.push(resolveSlot));
  }
  activePreviewGenerations += 1;
  try {
    return await operation();
  } finally {
    activePreviewGenerations -= 1;
    previewGenerationWaiters.shift()?.();
  }
}

async function serveProjectProduct(request: Request): Promise<Response> {
  if (!currentWorkingPath) return new Response('forbidden', { status: 403 });
  const url = new URL(request.url);
  if (url.host !== 'project') return new Response('forbidden', { status: 403 });
  let relativePath: string;
  try {
    relativePath = decodeURIComponent(url.pathname.replace(/^\/+/, ''));
  } catch {
    return new Response('bad path', { status: 400 });
  }
  if (
    !relativePath ||
    relativePath.includes('\0') ||
    relativePath.includes('\\') ||
    relativePath.split('/').some((segment) => !segment || segment === '.' || segment === '..')
  ) {
    return new Response('forbidden', { status: 403 });
  }
  const datasetRoot = resolve(currentWorkingPath, 'datasets');
  const candidate = resolve(datasetRoot, relativePath);
  const lexicalRelative = relative(datasetRoot, candidate);
  if (lexicalRelative.startsWith('..') || isAbsolute(lexicalRelative)) {
    return new Response('forbidden', { status: 403 });
  }
  try {
    const [canonicalRoot, canonicalFile] = await Promise.all([
      realpath(datasetRoot),
      realpath(candidate),
    ]);
    const canonicalRelative = relative(canonicalRoot, canonicalFile);
    if (canonicalRelative.startsWith('..') || isAbsolute(canonicalRelative)) {
      return new Response('forbidden', { status: 403 });
    }
    const metadata = await stat(canonicalFile);
    if (!metadata.isFile()) return new Response('not found', { status: 404 });
    const range = parseByteRange(request.headers.get('range'), metadata.size);
    if (range === 'invalid') {
      return new Response(null, {
        status: 416,
        headers: { 'content-range': `bytes */${metadata.size}` },
      });
    }
    const stream = range
      ? createReadStream(canonicalFile, { start: range.start, end: range.end })
      : createReadStream(canonicalFile);
    const length = range ? range.end - range.start + 1 : metadata.size;
    return new Response(Readable.toWeb(stream) as ReadableStream, {
      status: range ? 206 : 200,
      headers: {
        'content-type': productContentType(canonicalFile),
        'content-length': String(length),
        'accept-ranges': 'bytes',
        'access-control-allow-origin': '*',
        // The URL namespace follows the active project session. Identical job-relative paths
        // can exist in two projects, so retaining a response across project switches would
        // silently render the previous project's product. The prepared viewer keeps its own
        // bounded tile cache; the network cache must not outlive the active project.
        'cache-control': 'private, no-store',
        'x-content-type-options': 'nosniff',
        ...(range ? { 'content-range': `bytes ${range.start}-${range.end}/${metadata.size}` } : {}),
      },
    });
  } catch {
    return new Response('not found', { status: 404 });
  }
}

function parseByteRange(
  header: string | null,
  size: number,
): { start: number; end: number } | null | 'invalid' {
  if (!header) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match) return 'invalid';
  const startText = match[1] ?? '';
  const endText = match[2] ?? '';
  if (!startText && !endText) return 'invalid';
  let start: number;
  let end: number;
  if (!startText) {
    const suffix = Number(endText);
    if (!Number.isSafeInteger(suffix) || suffix <= 0) return 'invalid';
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(startText);
    end = endText ? Number(endText) : size - 1;
  }
  if (
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(end) ||
    start < 0 ||
    end < start ||
    start >= size
  ) {
    return 'invalid';
  }
  return { start, end: Math.min(end, size - 1) };
}

function productContentType(path: string): string {
  const lower = path.toLowerCase();
  if (lower.endsWith('.json')) return 'application/json; charset=utf-8';
  if (lower.endsWith('.png')) return 'image/png';
  if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) return 'image/jpeg';
  if (lower.endsWith('.tif') || lower.endsWith('.tiff')) return 'image/tiff';
  if (lower.endsWith('.ply')) return 'application/octet-stream';
  return 'application/octet-stream';
}

function imageContentType(format: string | null): string {
  if (format === 'jpeg') return 'image/jpeg';
  if (format === 'png') return 'image/png';
  if (format === 'tiff' || format === 'dng') return 'image/tiff';
  if (format === 'heic' || format === 'heif') return 'image/heif';
  if (format === 'avif') return 'image/avif';
  return 'application/octet-stream';
}

void app.whenReady().then(async () => {
  preferences = new PhotolabPreferencesService(
    resolve(app.getPath('userData'), 'preferences.json'),
  );
  registerProjectProtocols();
  registerIpc();
  startSidecar();
  await createWindow();
  const releaseSmokeReport = process.env.HIMMELCAD_RELEASE_SMOKE_REPORT?.trim();
  if (releaseSmokeReport) await runReleaseStartSmoke(resolve(releaseSmokeReport));
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) void createWindow();
});

app.on('before-quit', stopSidecar);
