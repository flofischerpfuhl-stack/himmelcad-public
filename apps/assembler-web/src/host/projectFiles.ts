/**
 * Project files and recent projects with the File System Access API.
 *
 * The host's "path" of a project is an opaque token `fsa:<id>` naming a file
 * handle: held in memory for the session and, once the project opened or
 * saved successfully, kept in IndexedDB as a recent project (up to 8, like
 * the desktop list). Save writes back through the handle (Chromium writes a
 * swap file and replaces the target on close); Save As, the first Save and
 * exports show the browser's save picker. A refused picker (the click is too
 * long ago, see `isActivationError`) falls back to a download.
 */
import type {
  HostFileFilter,
  HostFiles,
  HostOpenResult,
  HostRecentFileInfo,
  HostRecentFiles,
  HostSaveResult,
} from '../../../assembler/renderer/src/foundation/host/index.js';
import {
  browserFiles,
  downloadBlob,
} from '../../../assembler/renderer/src/foundation/host/index.js';
import {
  PROJECT_TYPES,
  ensurePermission,
  exportTypes,
  isActivationError,
  showOpenPicker,
  showSavePicker,
  writeHandle,
  type FileHandle,
} from './fileAccess.js';
import { idbAll, idbDelete, idbGet, idbPut } from './idb.js';

export const MAX_RECENT_FILES = 8;
const TOKEN_PREFIX = 'fsa:';
/** Shown under a recent project's name (a handle has no path the page may read). */
const LOCATION = 'On this device';
const THUMBNAIL_PATTERN = /"thumbnail"\s*:\s*"(data:image\/png;base64,[A-Za-z0-9+/]+={0,2})"/;

interface RecentRecord {
  id: string;
  name: string;
  handle: FileHandle;
  openedAt: string;
  modifiedAt: string | null;
  thumbnail: string | null;
}

/** The project's Home-screen thumbnail from the start of its text (same rule as `electron/recentFiles.ts`). */
export function extractThumbnail(text: string): string | null {
  return THUMBNAIL_PATTERN.exec(text.slice(0, 512 * 1024))?.[1] ?? null;
}

const tokenOf = (id: string) => `${TOKEN_PREFIX}${id}`;
const idOf = (token: string) =>
  token.startsWith(TOKEN_PREFIX) ? token.slice(TOKEN_PREFIX.length) : null;

function newId(): string {
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

/** Handles of this session, by id, with what the recent list needs once the open succeeds. */
const session = new Map<string, { handle: FileHandle; thumbnail: string | null }>();

async function handleFor(token: string | null | undefined): Promise<FileHandle | null> {
  const id = token ? idOf(token) : null;
  if (!id) return null;
  const live = session.get(id);
  if (live) return live.handle;
  const record = await idbGet<RecentRecord>('recent', id).catch(() => undefined);
  return record?.handle ?? null;
}

/** An id for `handle`: the one of an equal remembered handle (same file picked again), else new. */
async function idFor(handle: FileHandle): Promise<string> {
  for (const [id, entry] of session) {
    if (await entry.handle.isSameEntry(handle).catch(() => false)) return id;
  }
  for (const record of await idbAll<RecentRecord>('recent').catch(() => [])) {
    if (await record.handle.isSameEntry(handle).catch(() => false)) return record.id;
  }
  return newId();
}

async function remember(
  id: string,
  handle: FileHandle,
  update: { opened?: boolean; text?: string; modifiedAt?: string | null },
): Promise<void> {
  const previous = await idbGet<RecentRecord>('recent', id).catch(() => undefined);
  const now = new Date().toISOString();
  const record: RecentRecord = {
    id,
    name: handle.name,
    handle,
    openedAt: update.opened || !previous ? now : previous.openedAt,
    modifiedAt: update.modifiedAt ?? previous?.modifiedAt ?? null,
    thumbnail:
      (update.text !== undefined ? extractThumbnail(update.text) : session.get(id)?.thumbnail) ??
      previous?.thumbnail ??
      null,
  };
  await idbPut('recent', record);
  // Oldest beyond the limit drop out (most recently opened first, as on desktop).
  const all = (await idbAll<RecentRecord>('recent')).sort((a, b) =>
    b.openedAt.localeCompare(a.openedAt),
  );
  for (const stale of all.slice(MAX_RECENT_FILES)) await idbDelete('recent', stale.id);
}

async function readHandle(handle: FileHandle): Promise<{ text: string; modifiedAt: string }> {
  const file = await handle.getFile();
  return { text: await file.text(), modifiedAt: new Date(file.lastModified).toISOString() };
}

/** Opens through the picker; the handle joins the recent list once the project loads (`confirmOpened`). */
async function openProject(): Promise<HostOpenResult | null> {
  const handle = await showOpenPicker({ id: 'hcasm', types: PROJECT_TYPES });
  if (!handle) return null;
  const { text } = await readHandle(handle);
  const id = await idFor(handle);
  session.set(id, { handle, thumbnail: extractThumbnail(text) });
  return { path: tokenOf(id), text };
}

async function saveAs(text: string, suggestedName: string): Promise<HostSaveResult | null> {
  let handle: FileHandle | null;
  try {
    handle = await showSavePicker({ id: 'hcasm', suggestedName, types: PROJECT_TYPES });
  } catch (error) {
    if (!isActivationError(error)) throw error;
    return browserFiles.saveProject(text, { suggestedName });
  }
  if (!handle) return null;
  await writeHandle(handle, text);
  const id = await idFor(handle);
  session.set(id, { handle, thumbnail: extractThumbnail(text) });
  await remember(id, handle, { opened: true, text, modifiedAt: new Date().toISOString() }).catch(
    () => undefined,
  );
  return { path: tokenOf(id) };
}

export const fileSystemAccessFiles: HostFiles = {
  openProject,
  openBinary: (accept) => browserFiles.openBinary(accept),
  saveProject: async (text, options) => {
    const handle = options.forceDialog ? null : await handleFor(options.path);
    if (handle && options.path && (await ensurePermission(handle, 'readwrite'))) {
      await writeHandle(handle, text);
      const id = idOf(options.path)!;
      session.set(id, { handle, thumbnail: extractThumbnail(text) });
      await remember(id, handle, { text, modifiedAt: new Date().toISOString() }).catch(
        () => undefined,
      );
      return { path: options.path };
    }
    return saveAs(text, options.suggestedName);
  },
  exportBinary: async (
    bytes: Uint8Array,
    suggestedName: string,
    filters: HostFileFilter[],
    mimeType: string,
  ) => {
    let handle: FileHandle | null;
    try {
      handle = await showSavePicker({
        id: 'export',
        suggestedName,
        types: exportTypes(filters, mimeType),
      });
    } catch (error) {
      if (!isActivationError(error)) throw error;
      downloadBlob(new Blob([new Uint8Array(bytes)], { type: mimeType }), suggestedName);
      return { path: null };
    }
    if (!handle) return null;
    await writeHandle(handle, bytes);
    return { path: handle.name };
  },
};

/** File handles opened from the operating system (installed app, File Handling API). */
export async function openFromLaunch(handle: FileHandle): Promise<HostOpenResult> {
  const { text } = await readHandle(handle);
  const id = await idFor(handle);
  session.set(id, { handle, thumbnail: extractThumbnail(text) });
  return { path: tokenOf(id), text };
}

export const fileSystemAccessRecents: HostRecentFiles = {
  list: async () => {
    const records = await idbAll<RecentRecord>('recent').catch(() => [] as RecentRecord[]);
    records.sort((a, b) => b.openedAt.localeCompare(a.openedAt));
    const out: HostRecentFileInfo[] = [];
    for (const record of records) {
      let missing = false;
      let modifiedAt = record.modifiedAt;
      // Without a granted permission the file cannot be probed; it is checked when opened.
      if ((await record.handle.queryPermission?.({ mode: 'read' })) === 'granted') {
        try {
          modifiedAt = new Date((await record.handle.getFile()).lastModified).toISOString();
        } catch (error) {
          missing = error instanceof DOMException && error.name === 'NotFoundError';
        }
      }
      out.push({
        path: tokenOf(record.id),
        name: record.name,
        missing,
        openedAt: record.openedAt,
        modifiedAt,
        thumbnail: record.thumbnail,
        location: LOCATION,
      });
    }
    return out;
  },
  remove: async (path) => {
    const id = idOf(path);
    if (id) await idbDelete('recent', id);
  },
  openPath: async (path) => {
    const handle = await handleFor(path);
    if (!handle || !(await ensurePermission(handle, 'readwrite'))) return null;
    try {
      const { text } = await readHandle(handle);
      session.set(idOf(path)!, { handle, thumbnail: extractThumbnail(text) });
      return { path, text };
    } catch (error) {
      if (error instanceof DOMException && error.name === 'NotFoundError') return null;
      throw error;
    }
  },
  locate: async (oldPath) => {
    const id = idOf(oldPath);
    const handle = await showOpenPicker({ id: 'hcasm', types: PROJECT_TYPES });
    if (!id || !handle) return null;
    const { text, modifiedAt } = await readHandle(handle);
    session.set(id, { handle, thumbnail: extractThumbnail(text) });
    // Relinks the entry in place (keeps its position), as the desktop's Locate… does.
    await remember(id, handle, { text, modifiedAt });
    return { path: oldPath, text };
  },
  confirmOpened: async (path) => {
    const id = idOf(path);
    const live = id ? session.get(id) : undefined;
    if (!id || !live) return;
    await remember(id, live.handle, { opened: true });
  },
};
