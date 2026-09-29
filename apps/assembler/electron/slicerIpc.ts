/**
 * "Open in slicer" (main process): detects installed slicers, keeps the
 * user's registered slicers in `userData/assembler-slicers.json`, writes a
 * handed-off 3MF into the OS temp directory and launches the slicer with it
 * — `spawn(executable, [file], { shell: false })`, never a command string.
 * The renderer only ever names a registered slicer by id; paths come from
 * detection or a native file dialog and are validated again at launch.
 * Nothing is installed or downloaded.
 */
import { spawn } from 'node:child_process';
import { promises as fs, readdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { type BrowserWindow, app, dialog, ipcMain } from 'electron';

import {
  buildSlicerLaunch,
  detectSlicers,
  emptySlicerSettings,
  handoffDir,
  handoffFileName,
  mergeSlicers,
  nextUserSlicerId,
  parseSlicerSettings,
  slicerCandidates,
  slicerNameFromPath,
  validateSlicerPath,
  type SlicerEntry,
  type SlicerSettingsV1,
} from './slicerPaths';

const SETTINGS_FILE = 'assembler-slicers.json';
/** Handed-off files older than this are removed on the next handoff. */
const HANDOFF_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const MAX_HANDOFF_BYTES = 512 * 1024 * 1024;

export interface SlicerListResult {
  slicers: (SlicerEntry & { available: boolean })[];
  defaultId: string | null;
  platform: NodeJS.Platform;
}

const settingsPath = () => join(app.getPath('userData'), SETTINGS_FILE);

async function readSettings(): Promise<SlicerSettingsV1> {
  try {
    return parseSlicerSettings(
      JSON.parse(await fs.readFile(settingsPath(), 'utf8')),
      process.platform,
    );
  } catch {
    return emptySlicerSettings();
  }
}

async function writeSettings(settings: SlicerSettingsV1): Promise<void> {
  const tmp = `${settingsPath()}.tmp-${process.pid}`;
  await fs.writeFile(tmp, JSON.stringify(settings, null, 2), 'utf8');
  await fs.rename(tmp, settingsPath());
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function detected(): SlicerEntry[] {
  if (process.platform !== 'win32') return [];
  return detectSlicers(
    slicerCandidates(
      {
        programFiles: process.env.ProgramFiles,
        programFilesX86: process.env['ProgramFiles(x86)'],
        localAppData: process.env.LOCALAPPDATA,
      },
      (dir) => readdirSync(dir),
    ),
    isFile,
  );
}

async function list(): Promise<SlicerListResult> {
  const settings = await readSettings();
  const slicers = mergeSlicers(detected(), settings).map((s) => ({
    ...s,
    available: isFile(s.path),
  }));
  const defaultId =
    settings.defaultId && slicers.some((s) => s.id === settings.defaultId)
      ? settings.defaultId
      : (slicers.find((s) => s.available)?.id ?? null);
  return { slicers, defaultId, platform: process.platform };
}

async function removeOldHandoffs(dir: string): Promise<void> {
  try {
    const now = Date.now();
    for (const name of await fs.readdir(dir)) {
      if (!name.toLowerCase().endsWith('.3mf')) continue;
      const path = join(dir, name);
      const info = await fs.stat(path);
      if (now - info.mtimeMs > HANDOFF_MAX_AGE_MS) await fs.rm(path, { force: true });
    }
  } catch {
    // Best-effort cleanup.
  }
}

/** Starts `launch` and resolves once the process spawned (or rejects on a spawn error). */
function start(command: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      shell: false,
      detached: true,
      stdio: 'ignore',
      windowsHide: false,
    });
    child.once('error', reject);
    child.once('spawn', () => {
      child.unref();
      resolve();
    });
  });
}

/** Registers the `assembler:slicers:*` IPC handlers used by `preload.ts`. */
export function registerSlicerIpc(getWindow: () => BrowserWindow | null): void {
  ipcMain.handle('assembler:slicers:list', () => list());

  ipcMain.handle('assembler:slicers:add', async () => {
    const win = getWindow();
    const options: Electron.OpenDialogOptions = {
      title: 'Choose the slicer program',
      properties: ['openFile'],
      filters:
        process.platform === 'win32'
          ? [{ name: 'Programs', extensions: ['exe'] }]
          : [{ name: 'All files', extensions: ['*'] }],
    };
    const result = win
      ? await dialog.showOpenDialog(win, options)
      : await dialog.showOpenDialog(options);
    if (result.canceled || !result.filePaths[0]) return { ...(await list()), error: null };
    const path = result.filePaths[0];
    const problem =
      validateSlicerPath(path, process.platform) ?? (isFile(path) ? null : 'Not a file.');
    if (problem) return { ...(await list()), error: problem };
    const settings = await readSettings();
    if (!settings.user.some((u) => u.path.toLowerCase() === path.toLowerCase())) {
      const id = nextUserSlicerId(settings);
      settings.user.push({ id, name: slicerNameFromPath(path), path });
      settings.defaultId ??= id;
      await writeSettings(settings);
    }
    return { ...(await list()), error: null };
  });

  ipcMain.handle('assembler:slicers:remove', async (_event, id: unknown) => {
    if (typeof id !== 'string') throw new Error('Invalid slicer id');
    const settings = await readSettings();
    settings.user = settings.user.filter((u) => u.id !== id);
    if (settings.defaultId === id) settings.defaultId = null;
    await writeSettings(settings);
    return list();
  });

  ipcMain.handle('assembler:slicers:setDefault', async (_event, id: unknown) => {
    if (typeof id !== 'string') throw new Error('Invalid slicer id');
    const current = await list();
    if (!current.slicers.some((s) => s.id === id)) throw new Error('Unknown slicer');
    const settings = await readSettings();
    settings.defaultId = id;
    await writeSettings(settings);
    return list();
  });

  ipcMain.handle(
    'assembler:slicers:open',
    async (_event, id: unknown, bytes: unknown, projectName: unknown) => {
      if (typeof id !== 'string') return { ok: false, error: 'No slicer chosen.' };
      if (!(bytes instanceof Uint8Array) && !ArrayBuffer.isView(bytes)) {
        return { ok: false, error: 'Invalid model data.' };
      }
      const data = new Uint8Array(
        (bytes as Uint8Array).buffer,
        (bytes as Uint8Array).byteOffset,
        (bytes as Uint8Array).byteLength,
      );
      if (data.byteLength === 0 || data.byteLength > MAX_HANDOFF_BYTES) {
        return { ok: false, error: 'The model is empty or too large to hand off.' };
      }
      const { slicers } = await list();
      const slicer = slicers.find((s) => s.id === id);
      if (!slicer) return { ok: false, error: 'This slicer is no longer registered.' };
      if (!slicer.available)
        return { ok: false, error: `${slicer.name} was not found at ${slicer.path}.` };
      const problem = validateSlicerPath(slicer.path, process.platform);
      if (problem) return { ok: false, error: problem };
      const dir = handoffDir(tmpdir());
      await fs.mkdir(dir, { recursive: true });
      await removeOldHandoffs(dir);
      const file = join(
        dir,
        handoffFileName(typeof projectName === 'string' ? projectName : 'Model', new Date()),
      );
      await fs.writeFile(file, data);
      try {
        const launch = buildSlicerLaunch(slicer.path, file, process.platform);
        await start(launch.command, launch.args);
      } catch (error) {
        return {
          ok: false,
          error: `${slicer.name} could not be started: ${error instanceof Error ? error.message : String(error)}`,
        };
      }
      return { ok: true, path: file, slicer: slicer.name };
    },
  );
}
