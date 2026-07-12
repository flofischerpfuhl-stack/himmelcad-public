import { randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readFile, realpath, stat, writeFile } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { Readable } from 'node:stream';

import { BrowserWindow, app, dialog, ipcMain, protocol } from 'electron';

import {
  callSidecar,
  isSidecarRunning,
  onSidecarStderr,
  startSidecar,
  stopSidecar,
} from './sidecar';

const isDev = !app.isPackaged;
app.setName('HimmelCAD PhotoLab');
let mainWindow: BrowserWindow | null = null;
let currentWorkingPath: string | null = null;

protocol.registerSchemesAsPrivileged([
  {
    scheme: 'hcad-image',
    privileges: { standard: true, secure: true, supportFetchAPI: true },
  },
  {
    scheme: 'hcad-product',
    privileges: { standard: true, secure: true, supportFetchAPI: true },
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
  'photolab.project.processingSet.list',
  'photolab.project.processingSet.create',
  'photolab.crs.discover',
  'photolab.crs.freeze',
  'photolab.crs.cancel',
  'photolab.images.commit',
  'photolab.images.commit.cancel',
  'photolab.images.list',
  'photolab.gcp.preview',
  'photolab.gcp.commit',
  'photolab.gcp.list',
  'photolab.gcp.observation.upsert',
  'photolab.gcp.observation.upsertAssisted',
  'photolab.gcp.optimization.snapshot',
  'photolab.gcp.optimization.latest',
  'photolab.gcp.alignedCameras',
  'photolab.gcp.cancel',
  'photolab.jobs.startAlignment',
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
  const window = new BrowserWindow({
    title: 'HimmelCAD PhotoLab',
    width: 1480,
    height: 920,
    minWidth: 980,
    minHeight: 620,
    backgroundColor: '#101114',
    frame: false,
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

  if (isDev) await window.loadURL('http://localhost:5174/');
  else await window.loadFile(resolve(__dirname, '../renderer/index.html'));
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
        const selection = mainWindow
          ? await dialog.showOpenDialog(mainWindow, {
              title: `Export ${request.name}`,
              buttonLabel: 'Export here',
              properties: ['openDirectory', 'createDirectory'],
            })
          : await dialog.showOpenDialog({
              title: `Export ${request.name}`,
              buttonLabel: 'Export here',
              properties: ['openDirectory', 'createDirectory'],
            });
        const parent = selection.filePaths[0];
        if (selection.canceled || !parent) return null;
        destinationPath = join(parent, safeName);
        if (await pathExists(destinationPath)) {
          const confirmation = mainWindow
            ? await dialog.showMessageBox(mainWindow, {
                type: 'warning',
                buttons: ['Replace', 'Cancel'],
                defaultId: 1,
                cancelId: 1,
                message: `“${safeName}” already exists. Replace it completely?`,
              })
            : await dialog.showMessageBox({
                type: 'warning',
                buttons: ['Replace', 'Cancel'],
                defaultId: 1,
                cancelId: 1,
                message: `“${safeName}” already exists. Replace it completely?`,
              });
          if (confirmation.response !== 0) return null;
        }
      } else {
        const extension = exportExtension(request.kind);
        const selection = mainWindow
          ? await dialog.showSaveDialog(mainWindow, {
              title: `Export ${request.name}`,
              defaultPath: `${safeName}.${extension}`,
              properties: ['createDirectory', 'showOverwriteConfirmation'],
              filters: [{ name: exportFilterName(request.kind), extensions: [extension] }],
            })
          : await dialog.showSaveDialog({
              title: `Export ${request.name}`,
              defaultPath: `${safeName}.${extension}`,
              properties: ['createDirectory', 'showOverwriteConfirmation'],
              filters: [{ name: exportFilterName(request.kind), extensions: [extension] }],
            });
        if (selection.canceled || !selection.filePath) return null;
        destinationPath = selection.filePath;
      }
      return callSidecar({
        method: 'photolab.jobs.startProductExport',
        params: {
          operationId: `export-${randomUUID()}`,
          entityId: request.entityId,
          destinationPath,
        },
      });
    },
  );
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
      const selection = mainWindow
        ? await dialog.showSaveDialog(mainWindow, {
            title: `Export processing report as ${request.format.toUpperCase()}`,
            defaultPath: `${suggestedName}.${request.format}`,
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
            defaultPath: `${suggestedName}.${request.format}`,
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
        await writeFile(selection.filePath, request.html, 'utf8');
        return true;
      }
      const reportWindow = new BrowserWindow({
        show: false,
        webPreferences: {
          contextIsolation: true,
          nodeIntegration: false,
          sandbox: true,
        },
      });
      reportWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
      try {
        await reportWindow.loadURL(
          `data:text/html;charset=utf-8,${encodeURIComponent(request.html)}`,
        );
        const pdf = await reportWindow.webContents.printToPDF({
          pageSize: 'A4',
          printBackground: true,
          margins: { top: 0.4, bottom: 0.4, left: 0.4, right: 0.4 },
        });
        await writeFile(selection.filePath, pdf);
        return true;
      } finally {
        reportWindow.destroy();
      }
    },
  );
  ipcMain.handle('batch:load', async () => {
    const selection = mainWindow
      ? await dialog.showOpenDialog(mainWindow, {
          title: 'Load PhotoLab Batch',
          properties: ['openFile'],
          filters: [{ name: 'PhotoLab Batch', extensions: ['hcbatch', 'json'] }],
        })
      : await dialog.showOpenDialog({
          title: 'Load PhotoLab Batch',
          properties: ['openFile'],
          filters: [{ name: 'PhotoLab Batch', extensions: ['hcbatch', 'json'] }],
        });
    const path = selection.filePaths[0];
    if (selection.canceled || !path) return null;
    const bytes = await readFile(path);
    if (bytes.byteLength > 4 * 1024 * 1024) throw new Error('Batch file exceeds 4 MiB');
    return JSON.parse(bytes.toString('utf8')) as unknown;
  });
  ipcMain.handle('batch:save', async (_event, value: unknown) => {
    const encoded = JSON.stringify(value, null, 2);
    if (encoded.length > 4 * 1024 * 1024) throw new Error('Batch file exceeds 4 MiB');
    JSON.parse(encoded);
    const selection = mainWindow
      ? await dialog.showSaveDialog(mainWindow, {
          title: 'Save PhotoLab Batch',
          defaultPath: 'PhotoLab-Pipeline.hcbatch',
          properties: ['createDirectory', 'showOverwriteConfirmation'],
          filters: [{ name: 'PhotoLab Batch', extensions: ['hcbatch'] }],
        })
      : await dialog.showSaveDialog({
          title: 'Save PhotoLab Batch',
          defaultPath: 'PhotoLab-Pipeline.hcbatch',
          properties: ['createDirectory', 'showOverwriteConfirmation'],
          filters: [{ name: 'PhotoLab Batch', extensions: ['hcbatch'] }],
        });
    if (selection.canceled || !selection.filePath) return false;
    await writeFile(selection.filePath, encoded, { encoding: 'utf8', mode: 0o600 });
    return true;
  });
  ipcMain.handle('project:bootstrap', async () => {
    try {
      return rememberProject(await callSidecar({ method: 'photolab.project.snapshot' }));
    } catch {
      const timestamp = new Date().toISOString().replaceAll(/[:.]/g, '-');
      return rememberProject(
        await callSidecar({
          method: 'photolab.project.create',
          params: {
            path: resolve(app.getPath('userData'), 'projects', `Unbenannt-${timestamp}.hcad`),
            name: 'Untitled PhotoLab Project',
          },
        }),
      );
    }
  });
  ipcMain.handle('project:create', async () => {
    const options: Electron.SaveDialogOptions = {
      title: 'Create PhotoLab Project',
      defaultPath: 'PhotoLab-Project.hcadx',
      filters: [{ name: 'HimmelCAD PhotoLab Project', extensions: ['hcadx'] }],
      properties: ['createDirectory', 'showOverwriteConfirmation'],
    };
    const selection = mainWindow
      ? await dialog.showSaveDialog(mainWindow, options)
      : await dialog.showSaveDialog(options);
    if (selection.canceled || !selection.filePath) return null;
    await callSidecar({ method: 'photolab.project.close' });
    const localPath = resolve(
      app.getPath('userData'),
      'cache',
      'photolab',
      'workspaces',
      `new-${randomUUID()}.hcad`,
    );
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
      params: archiveOperationParams(selection.filePath, true, 'project-create'),
    });
    return rememberProject(await callSidecar({ method: 'photolab.project.snapshot' }));
  });
  ipcMain.handle('project:open', async () => {
    const options: Electron.OpenDialogOptions = {
      title: 'Open PhotoLab Project',
      properties: ['openFile', 'openDirectory'],
      filters: [{ name: 'HimmelCAD PhotoLab Project', extensions: ['hcadx'] }],
    };
    const selection = mainWindow
      ? await dialog.showOpenDialog(mainWindow, options)
      : await dialog.showOpenDialog(options);
    const selectedPath = selection.filePaths[0];
    if (selection.canceled || !selectedPath) return null;
    await callSidecar({ method: 'photolab.project.close' });
    return rememberProject(
      await callSidecar({
        method: 'photolab.project.open',
        params: {
          path: selectedPath,
          workingRoot: resolve(app.getPath('userData'), 'cache'),
          useLocalWorkingCopy: true,
          recoverExistingWorkingCopy: true,
          archiveOperationId: `archive-open-${randomUUID()}`,
          progressKey: `project-open:${Date.now()}`,
        },
      }),
    );
  });
  ipcMain.handle('project:save', async () => {
    const snapshot = await callSidecar<{
      session: { sourcePath: string };
    }>({ method: 'photolab.project.snapshot' });
    if (!snapshot.session.sourcePath.toLowerCase().endsWith('.hcadx')) {
      return callSidecar({ method: 'photolab.project.save' });
    }
    return callSidecar({
      method: 'photolab.project.saveAs',
      params: archiveOperationParams(snapshot.session.sourcePath, true, 'project-save'),
    });
  });
  ipcMain.handle('project:save-as', async () => {
    const snapshot = await callSidecar<{
      session: { sourcePath: string };
    }>({ method: 'photolab.project.snapshot' });
    const options: Electron.SaveDialogOptions = {
      title: 'Save PhotoLab Project As',
      defaultPath: snapshot.session.sourcePath.toLowerCase().endsWith('.hcadx')
        ? snapshot.session.sourcePath
        : 'PhotoLab-Project.hcadx',
      filters: [{ name: 'HimmelCAD PhotoLab Project', extensions: ['hcadx'] }],
      properties: ['createDirectory', 'showOverwriteConfirmation'],
    };
    const selection = mainWindow
      ? await dialog.showSaveDialog(mainWindow, options)
      : await dialog.showSaveDialog(options);
    if (selection.canceled || !selection.filePath) return null;
    return callSidecar({
      method: 'photolab.project.saveAs',
      params: archiveOperationParams(selection.filePath, true, 'project-save-as'),
    });
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
      properties: ['openFile', 'multiSelections'],
      filters: [
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
    if (selection.canceled || selection.filePaths.length === 0) return null;
    return callSidecar({
      method: 'photolab.images.inspect',
      params: { paths: selection.filePaths },
    });
  });
  ipcMain.handle('images:select-folder', async () => {
    const options: Electron.OpenDialogOptions = {
      title: 'Import Image Folder',
      properties: ['openDirectory'],
    };
    const selection = mainWindow
      ? await dialog.showOpenDialog(mainWindow, options)
      : await dialog.showOpenDialog(options);
    const selectedPath = selection.filePaths[0];
    if (selection.canceled || !selectedPath) return null;
    return callSidecar({
      method: 'photolab.images.inspect',
      params: { paths: [selectedPath] },
    });
  });
  ipcMain.handle('reference:select-gcp-csv', async () => {
    const options: Electron.OpenDialogOptions = {
      title: 'Import Ground Control Points',
      properties: ['openFile'],
      filters: [
        { name: 'Koordinatendatei', extensions: ['csv', 'txt'] },
        { name: 'All Files', extensions: ['*'] },
      ],
    };
    const selection = mainWindow
      ? await dialog.showOpenDialog(mainWindow, options)
      : await dialog.showOpenDialog(options);
    return selection.canceled ? null : (selection.filePaths[0] ?? null);
  });
}

function archiveOperationParams(path: string, overwrite: boolean, progressPrefix: string) {
  return {
    path,
    overwrite,
    archiveOperationId: `archive-${randomUUID()}`,
    progressKey: `${progressPrefix}:${Date.now()}`,
  };
}

function rememberProject<T>(result: T): T {
  const candidate = result as { session?: { workingPath?: unknown } };
  currentWorkingPath =
    typeof candidate.session?.workingPath === 'string'
      ? resolve(candidate.session.workingPath)
      : currentWorkingPath;
  return result;
}

function registerProjectProtocols(): void {
  protocol.handle('hcad-image', async (request) => {
    const url = new URL(request.url);
    const hash = url.pathname.replace(/^\/+/, '');
    if (url.host !== 'project' || !/^[a-f0-9]{64}$/.test(hash) || !currentWorkingPath) {
      return new Response('forbidden', { status: 403 });
    }
    const root = resolve(currentWorkingPath, 'objects');
    const imagePath = resolve(root, hash.slice(0, 2), hash.slice(2));
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
          'content-type': imageContentType(url.searchParams.get('format')),
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
        'cache-control': 'private, max-age=31536000, immutable',
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
  registerProjectProtocols();
  registerIpc();
  startSidecar();
  await createWindow();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) void createWindow();
});

app.on('before-quit', stopSidecar);
