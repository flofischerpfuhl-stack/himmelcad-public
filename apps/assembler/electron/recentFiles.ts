/**
 * Recent-files list logic: pure and Electron-free (`addRecentFile`,
 * `removeRecentFile`, `relocateRecentFile`, `parseRecentFilesState`) so it
 * is unit-testable with plain `node:test`
 * (`apps/assembler/test/electron/recentFiles.test.ts`) without spinning up
 * Electron. {@link RecentFilesStore} is the only Electron-adjacent (Node
 * `fs`) part: it persists this state as JSON at a given path and is what
 * `fileApi.ts` actually wires to IPC.
 */
import { promises as fs } from 'node:fs';

export const MAX_RECENT_FILES = 8;

export interface RecentFileEntry {
  path: string;
  /** Display name (file name without directory), stored so the menu never needs a sync `fs` call to render. */
  name: string;
  /** ISO 8601 timestamp of when it was opened/saved. */
  openedAt: string;
}

export interface RecentFilesStateV1 {
  version: 1;
  entries: RecentFileEntry[];
}

export function emptyRecentFilesState(): RecentFilesStateV1 {
  return { version: 1, entries: [] };
}

function baseName(path: string): string {
  const normalized = path.replace(/\\/g, '/');
  const last = normalized.slice(normalized.lastIndexOf('/') + 1);
  return last || path;
}

/**
 * Adds/moves `path` to the front (most-recent-first), de-duplicated by
 * path, capped at {@link MAX_RECENT_FILES}. Comparison is exact-string
 * (the caller is expected to pass an already-normalized absolute path, as
 * every write path in `fileApi.ts` does).
 */
export function addRecentFile(
  state: RecentFilesStateV1,
  path: string,
  openedAt: string = new Date().toISOString(),
): RecentFilesStateV1 {
  const entry: RecentFileEntry = { path, name: baseName(path), openedAt };
  const rest = state.entries.filter((e) => e.path !== path);
  return { version: 1, entries: [entry, ...rest].slice(0, MAX_RECENT_FILES) };
}

export function removeRecentFile(state: RecentFilesStateV1, path: string): RecentFilesStateV1 {
  return { version: 1, entries: state.entries.filter((e) => e.path !== path) };
}

/** "Locate…": replaces `oldPath` with `newPath` in place (keeps its position), rather than moving it to the front. */
export function relocateRecentFile(
  state: RecentFilesStateV1,
  oldPath: string,
  newPath: string,
): RecentFilesStateV1 {
  const withoutNewPath = state.entries.filter((e) => e.path !== newPath || e.path === oldPath);
  return {
    version: 1,
    entries: withoutNewPath.map((e) =>
      e.path === oldPath ? { path: newPath, name: baseName(newPath), openedAt: e.openedAt } : e,
    ),
  };
}

/** Strictly validates a parsed JSON value, or returns a fresh empty state for anything malformed — the recent-files list is a convenience, never worth failing app startup over. */
export function parseRecentFilesState(raw: unknown): RecentFilesStateV1 {
  if (
    typeof raw !== 'object' ||
    raw === null ||
    (raw as { version?: unknown }).version !== 1 ||
    !Array.isArray((raw as { entries?: unknown }).entries)
  ) {
    return emptyRecentFilesState();
  }
  const entries = (raw as { entries: unknown[] }).entries
    .filter(
      (e): e is RecentFileEntry =>
        typeof e === 'object' &&
        e !== null &&
        typeof (e as RecentFileEntry).path === 'string' &&
        typeof (e as RecentFileEntry).name === 'string' &&
        typeof (e as RecentFileEntry).openedAt === 'string',
    )
    .slice(0, MAX_RECENT_FILES);
  return { version: 1, entries };
}

export interface RecentFileInfo {
  path: string;
  /** `true` if the file no longer exists at this path. */
  missing: boolean;
}

/** Bytes read from the start of a `.hcasm` to find its thumbnail (it is written right after `projectName`). */
export const THUMBNAIL_SCAN_BYTES = 512 * 1024;
const THUMBNAIL_PATTERN = /"thumbnail"\s*:\s*"(data:image\/png;base64,[A-Za-z0-9+/]+={0,2})"/;

/**
 * The project's Home-screen thumbnail (a PNG data URL) from the first bytes
 * of its `.hcasm` text, without parsing the (possibly large) model. `null`
 * when there is none — older files, web downloads, or a file saved while no
 * 3D view was available. Only a well-formed PNG data URL is ever returned,
 * so the renderer can put it straight into an `<img>`.
 */
export function extractThumbnail(head: string): string | null {
  const match = THUMBNAIL_PATTERN.exec(head);
  return match ? match[1]! : null;
}

/**
 * Persists a {@link RecentFilesStateV1} as JSON at `filePath` (typically
 * under `app.getPath('userData')`) and layers filesystem existence checks
 * on top for `listWithStatus()`. Every method re-reads the file first
 * (rather than caching in memory) so it stays correct across the app's
 * whole process lifetime with a single source of truth on disk; the list
 * is small (<= {@link MAX_RECENT_FILES} entries) so this is cheap.
 */
export class RecentFilesStore {
  constructor(private readonly filePath: string) {}

  private async read(): Promise<RecentFilesStateV1> {
    try {
      const text = await fs.readFile(this.filePath, 'utf8');
      return parseRecentFilesState(JSON.parse(text));
    } catch {
      return emptyRecentFilesState();
    }
  }

  private async write(state: RecentFilesStateV1): Promise<void> {
    const tmp = `${this.filePath}.tmp-${process.pid}`;
    await fs.writeFile(tmp, JSON.stringify(state, null, 2), 'utf8');
    await fs.rename(tmp, this.filePath);
  }

  /** Records `path` as the most-recently-opened/saved file. Best-effort: a write failure here never blocks the save/open it was recording. */
  async add(path: string): Promise<void> {
    try {
      const state = await this.read();
      await this.write(addRecentFile(state, path));
    } catch {
      // best-effort
    }
  }

  async remove(path: string): Promise<void> {
    const state = await this.read();
    await this.write(removeRecentFile(state, path));
  }

  /** "Locate…": relinks `oldPath` to `newPath` in place. */
  async replace(oldPath: string, newPath: string): Promise<void> {
    const state = await this.read();
    await this.write(relocateRecentFile(state, oldPath, newPath));
  }

  /** The list with a per-entry existence check, most-recent-first, for the renderer's "Open Recent" submenu. */
  async listWithStatus(): Promise<RecentFileInfo[]> {
    const state = await this.read();
    return Promise.all(
      state.entries.map(async (e) => ({ path: e.path, missing: !(await pathExists(e.path)) })),
    );
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await fs.access(path);
    return true;
  } catch {
    return false;
  }
}
