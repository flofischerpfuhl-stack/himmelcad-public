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

import {
  addRecentFile,
  emptyRecentFilesState,
  parseRecentFilesState,
  relocateRecentFile,
  removeRecentFile as removeRecentFileEntry,
  type RecentFilesStateV1,
} from './recentFiles';

const HCASM_FILTERS = [{ name: 'HimmelCAD Assembler project', extensions: ['hcasm'] }];
const RECOVERY_FILE = 'assembler-recovery.json';
const RECENT_FILES_FILE = 'assembler-recent-files.json';

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

const recentFilesPath = () => `${app.getPath('userData')}/${RECENT_FILES_FILE}`;

async function readRecentFilesState(): Promise<RecentFilesStateV1> {
  try {
    const text = await fs.readFile(recentFilesPath(), 'utf8');
    return parseRecentFilesState(JSON.parse(text));
  } catch {
    return emptyRecentFilesState();
  }
}

async function writeRecentFilesState(state: RecentFilesStateV1): Promise<void> {
  try {
    const tmp = `${recentFilesPath()}.tmp-${process.pid}`;
    await fs.writeFile(tmp, JSON.stringify(state, null, 2), 'utf8');
    await fs.rename(tmp, recentFilesPath());
  } catch {
    // Best-effort: a recent-files write failure never blocks Open/Save.
  }
}

async function rememberRecentFile(path: string): Promise<void> {
  await writeRecentFilesState(addRecentFile(await readRecentFilesState(), path));
}

/**
 * Reads a `.hcasm` at `path` (double-click file association, a CLI
 * argument, or a second app instance's forwarded argv — `main.ts`),
 * authorizing it the same way a dialog-obtained path is (so a subsequent
 * Ctrl+S onto it works) and recording it in Recent Files. `null` if the
 * path doesn't exist/isn't readable, or isn't absolute.
 */
export async function readHcasmFile(path: string): Promise<{ path: string; text: string } | null> {
  if (!isAbsolute(path) || !path.toLowerCase().endsWith('.hcasm')) return null;
  try {
    const text = await fs.readFile(path, 'utf8');
    authorize(path);
    await rememberRecentFile(path);
    return { path, text };
  } catch {
    return null;
  }
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
    await rememberRecentFile(path);
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
    await rememberRecentFile(validPath);
  });

  ipcMain.handle('assembler:recentFiles:list', async () => {
    const state = await readRecentFilesState();
    return Promise.all(
      state.entries.map(async (entry) => ({
        path: entry.path,
        name: entry.name,
        missing: !(await pathExists(entry.path)),
      })),
    );
  });

  ipcMain.handle('assembler:recentFiles:remove', async (_event, path: unknown) => {
    if (typeof path !== 'string') throw new Error('Invalid path');
    await writeRecentFilesState(removeRecentFileEntry(await readRecentFilesState(), path));
  });

  /**
   * Opens a path from the Recent Files list. Only paths that are on the list
   * (recorded by this module from a dialog, a save or a launch argument) are
   * accepted — a renderer-invented path is refused, like everywhere else here.
   */
  ipcMain.handle('assembler:recentFiles:openPath', async (_event, path: unknown) => {
    if (typeof path !== 'string') throw new Error('Invalid path');
    const listed = (await readRecentFilesState()).entries.some((entry) => entry.path === path);
    if (!listed) throw new Error('Not a recent file');
    return readHcasmFile(path); // null if missing/unreadable: the renderer offers Locate…/Remove instead.
  });

  /** "Locate…" for a missing recent entry: lets the user pick its new location and relinks the list entry. */
  ipcMain.handle('assembler:recentFiles:locate', async (_event, oldPath: unknown) => {
    if (typeof oldPath !== 'string') throw new Error('Invalid path');
    const win = getWindow();
    const options: Electron.OpenDialogOptions = {
      filters: HCASM_FILTERS,
      properties: ['openFile'],
    };
    const result = win
      ? await dialog.showOpenDialog(win, options)
      : await dialog.showOpenDialog(options);
    if (result.canceled || !result.filePaths[0]) return null;
    const path = authorize(result.filePaths[0]);
    const text = await fs.readFile(path, 'utf8');
    await writeRecentFilesState(relocateRecentFile(await readRecentFilesState(), oldPath, path));
    return { path, text };
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
