/**
 * Main-process file I/O for the Assembler: native dialogs, atomic project
 * writes with rolling backups, binary export writes and a crash-recovery
 * copy in `userData`. Narrow, validated IPC surface: the renderer never
 * gets raw filesystem access — every `ipcMain.handle` here takes only
 * primitive arguments and every write path must have been returned by one
 * of this module's own dialog handlers first (`authorizedPaths`), never an
 * arbitrary renderer-supplied string.
 */
import { promises as fs } from 'node:fs';
import { isAbsolute } from 'node:path';

import { type BrowserWindow, app, dialog, ipcMain } from 'electron';

const HCASM_FILTERS = [{ name: 'HimmelCAD Assembler project', extensions: ['hcasm'] }];
const RECOVERY_FILE = 'assembler-recovery.json';

/** Paths the renderer may write to: only ones this module handed back from a dialog. */
const authorizedPaths = new Set<string>();

function authorize(path: string): string {
  if (!isAbsolute(path)) throw new Error('Invalid path');
  authorizedPaths.add(path);
  return path;
}

function requireAuthorized(path: unknown): string {
  if (typeof path !== 'string' || !authorizedPaths.has(path)) {
    throw new Error('Path was not obtained from a save/export dialog');
  }
  return path;
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await fs.access(path);
    return true;
  } catch {
    return false;
  }
}

/** Rotates `path.bak1..3` (bak1 = most recent) before `path` is overwritten. Best-effort: a backup failure never blocks the save. */
async function rotateBackups(path: string): Promise<void> {
  try {
    if (!(await pathExists(path))) return;
    const bak = (n: number) => `${path}.bak${n}`;
    await fs.rm(bak(3), { force: true });
    for (const n of [2, 1]) {
      if (await pathExists(bak(n))) await fs.rename(bak(n), bak(n + 1));
    }
    await fs.copyFile(path, bak(1));
  } catch {
    // Backups are best-effort; never block a save on them.
  }
}

async function atomicWrite(path: string, data: string | Uint8Array): Promise<void> {
  await rotateBackups(path);
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
  if (typeof data === 'string') await fs.writeFile(tmp, data, 'utf8');
  else await fs.writeFile(tmp, data);
  await fs.rename(tmp, path);
}

interface ExportFilter {
  name: string;
  extensions: string[];
}

function sanitizeFilters(filters: unknown): ExportFilter[] {
  if (!Array.isArray(filters)) return [];
  return filters
    .filter(
      (f): f is ExportFilter =>
        typeof f === 'object' &&
        f !== null &&
        typeof (f as ExportFilter).name === 'string' &&
        Array.isArray((f as ExportFilter).extensions) &&
        (f as ExportFilter).extensions.every((e) => typeof e === 'string'),
    )
    .map((f) => ({ name: f.name, extensions: f.extensions }));
}

/** Registers the `assembler:project:*` IPC handlers used by `preload.ts`. Call once per app instance. */
export function registerFileApi(getWindow: () => BrowserWindow | null): void {
  ipcMain.handle('assembler:project:openDialog', async () => {
    const win = getWindow();
    const result = win
      ? await dialog.showOpenDialog(win, { filters: HCASM_FILTERS, properties: ['openFile'] })
      : await dialog.showOpenDialog({ filters: HCASM_FILTERS, properties: ['openFile'] });
    if (result.canceled || !result.filePaths[0]) return null;
    const path = authorize(result.filePaths[0]);
    const text = await fs.readFile(path, 'utf8');
    return { path, text };
  });

  ipcMain.handle('assembler:project:saveDialog', async (_event, suggestedName: unknown) => {
    const win = getWindow();
    const options = {
      filters: HCASM_FILTERS,
      defaultPath: typeof suggestedName === 'string' ? suggestedName : 'Project.hcasm',
    };
    const result = win
      ? await dialog.showSaveDialog(win, options)
      : await dialog.showSaveDialog(options);
    if (result.canceled || !result.filePath) return null;
    return { path: authorize(result.filePath) };
  });

  ipcMain.handle('assembler:project:save', async (_event, path: unknown, text: unknown) => {
    const validPath = requireAuthorized(path);
    if (typeof text !== 'string') throw new Error('Invalid project text');
    await atomicWrite(validPath, text);
  });

  ipcMain.handle(
    'assembler:project:exportDialog',
    async (_event, suggestedName: unknown, filters: unknown) => {
      const win = getWindow();
      const options = {
        defaultPath: typeof suggestedName === 'string' ? suggestedName : 'export',
        filters: sanitizeFilters(filters),
      };
      const result = win
        ? await dialog.showSaveDialog(win, options)
        : await dialog.showSaveDialog(options);
      if (result.canceled || !result.filePath) return null;
      return { path: authorize(result.filePath) };
    },
  );

  ipcMain.handle('assembler:project:writeBinary', async (_event, path: unknown, bytes: unknown) => {
    const validPath = requireAuthorized(path);
    if (!(bytes instanceof Uint8Array) && !ArrayBuffer.isView(bytes)) {
      throw new Error('Invalid binary payload');
    }
    await atomicWrite(
      validPath,
      new Uint8Array(
        (bytes as Uint8Array).buffer,
        (bytes as Uint8Array).byteOffset,
        (bytes as Uint8Array).byteLength,
      ),
    );
  });

  const recoveryPath = () => `${app.getPath('userData')}/${RECOVERY_FILE}`;

  ipcMain.handle('assembler:project:readRecovery', async () => {
    try {
      const text = await fs.readFile(recoveryPath(), 'utf8');
      const parsed = JSON.parse(text) as { text: string; when: string };
      if (typeof parsed.text !== 'string' || typeof parsed.when !== 'string') return null;
      return parsed;
    } catch {
      return null;
    }
  });

  ipcMain.handle('assembler:project:writeRecovery', async (_event, text: unknown) => {
    if (typeof text !== 'string') throw new Error('Invalid recovery text');
    const payload = JSON.stringify({ text, when: new Date().toISOString() });
    const tmp = `${recoveryPath()}.tmp-${process.pid}`;
    await fs.writeFile(tmp, payload, 'utf8');
    await fs.rename(tmp, recoveryPath());
  });

  ipcMain.handle('assembler:project:clearRecovery', async () => {
    await fs.rm(recoveryPath(), { force: true });
  });
}

/**
 * Intercepts the window's native close so the renderer can confirm an
 * unsaved-changes prompt first. The renderer must call `respondClose(true)`
 * (via `window.assembler.project.respondClose`) to actually let the window
 * close; any other outcome (cancel, or no response) leaves it open.
 */
export function attachCloseGuard(win: BrowserWindow): void {
  let allowClose = false;
  win.on('close', (event) => {
    if (allowClose) return;
    event.preventDefault();
    win.webContents.send('assembler:project:close-requested');
  });
  ipcMain.handle('assembler:project:respondClose', (_event, allow: unknown) => {
    if (allow === true) {
      allowClose = true;
      win.close();
    }
  });
}
