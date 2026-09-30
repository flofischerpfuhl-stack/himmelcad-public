/**
 * Shape of `window.assembler`, exposed by `preload.ts` via `contextBridge`.
 * Kept in its own module, deliberately without a `NodeJS` namespace
 * reference or an `electron` import, so the renderer's `global.d.ts` can
 * pull in the type without needing `@types/node` in the renderer's
 * TypeScript project.
 */
export type AssemblerPlatform =
  | 'aix'
  | 'darwin'
  | 'freebsd'
  | 'linux'
  | 'openbsd'
  | 'sunos'
  | 'win32'
  | 'android'
  | 'cygwin'
  | 'netbsd'
  | 'haiku';

export interface ProjectExportFilter {
  name: string;
  extensions: string[];
}

/**
 * Native project I/O, exposed only through `window.assembler.project`.
 * Every path the renderer can write to was returned by `openDialog`,
 * `saveDialog` or `exportDialog` — the renderer never invents a path.
 */
export interface AssemblerProjectApi {
  openDialog(): Promise<{ path: string; text: string } | null>;
  saveDialog(suggestedName: string): Promise<{ path: string } | null>;
  save(path: string, text: string): Promise<void>;
  exportDialog(
    suggestedName: string,
    filters: ProjectExportFilter[],
  ): Promise<{ path: string } | null>;
  writeBinary(path: string, bytes: Uint8Array): Promise<void>;
  readRecovery(): Promise<{ text: string; when: string } | null>;
  writeRecovery(text: string): Promise<void>;
  clearRecovery(): Promise<void>;
  /** Fired when the OS/window asks to close while the app may have unsaved changes. Returns an unsubscribe function. */
  onCloseRequested(listener: () => void): () => void;
  /** Answers a pending close request; `true` lets the window close. */
  respondClose(allow: boolean): Promise<void>;
  /**
   * Fired when the main process wants a `.hcasm` opened outside the normal
   * Open dialog: launched with a file argument (double-click association,
   * or a CLI path) or forwarded from a second app instance. Returns an
   * unsubscribe function.
   */
  onOpenRequested(listener: (path: string, text: string) => void): () => void;
}

export interface RecentFileInfo {
  path: string;
  /** Display name (file name without directory). */
  name: string;
  /** `true` if the file no longer exists at this path — render greyed out with Locate…/Remove. */
  missing: boolean;
  /** When it was last opened or saved in the app (ISO 8601). */
  openedAt?: string;
  /** The file's modification time (ISO 8601); `null` when missing. */
  modifiedAt?: string | null;
  /** Home screen preview stored in the file (`data:image/png;base64,…`), if any. */
  thumbnail?: string | null;
}

/**
 * File menu "Open Recent": up to 8 most-recently-opened/saved `.hcasm`
 * paths, persisted in `userData` (`electron/recentFiles.ts`).
 */
export interface AssemblerRecentFilesApi {
  list(): Promise<RecentFileInfo[]>;
  remove(path: string): Promise<void>;
  /** Reads and opens `path` directly (no dialog); `null` if it no longer exists. */
  openPath(path: string): Promise<{ path: string; text: string } | null>;
  /** Lets the user pick a replacement for a missing entry; relinks the list entry to the new path. */
  locate(oldPath: string): Promise<{ path: string; text: string } | null>;
  /**
   * Records a project the renderer opened successfully (a path from Open,
   * Open Recent, Locate… or a launch argument). A file that fails to open is
   * never added to the list.
   */
  confirmOpened(path: string): Promise<void>;
}

/** State of the opt-in local agent endpoint (`electron/automationServer.ts`). */
export interface AssemblerAutomationStatus {
  enabled: boolean;
  url: string | null;
  port: number | null;
  token: string | null;
}

/**
 * Agent access: the main process owns the loopback server; request bodies
 * are forwarded here and answered by the renderer's canonical command layer.
 */
export interface AssemblerAutomationApi {
  status(): Promise<AssemblerAutomationStatus>;
  setEnabled(enabled: boolean): Promise<AssemblerAutomationStatus>;
  /** Subscribes to forwarded JSON-RPC request bodies. Returns an unsubscribe function. */
  onRequest(listener: (id: string, body: string) => void): () => void;
  /** Answers a forwarded request (empty string for a notification). */
  respond(id: string, body: string): Promise<void>;
}

/** A slicer the app can hand a model to (`electron/slicerPaths.ts`). */
export interface SlicerInfo {
  id: string;
  name: string;
  kind: 'bambu' | 'orca' | 'prusa' | 'cura' | 'custom';
  path: string;
  source: 'detected' | 'user';
  /** The executable exists right now. */
  available: boolean;
}

export interface SlicerListInfo {
  slicers: SlicerInfo[];
  defaultId: string | null;
  platform: AssemblerPlatform;
}

/**
 * "Open in slicer": the main process detects installed slicers and keeps
 * the user's registered ones; the renderer names a slicer by id only.
 */
export interface AssemblerSlicersApi {
  list(): Promise<SlicerListInfo>;
  /** Native "choose program" dialog; `error` explains a rejected choice. */
  add(): Promise<SlicerListInfo & { error: string | null }>;
  remove(id: string): Promise<SlicerListInfo>;
  setDefault(id: string): Promise<SlicerListInfo>;
  /** Writes `bytes` (a 3MF) to a temp file and launches the slicer with it. */
  open(
    id: string,
    bytes: Uint8Array,
    projectName: string,
  ): Promise<{ ok: true; path: string; slicer: string } | { ok: false; error: string }>;
}

export interface AssemblerApi {
  readonly platform: AssemblerPlatform;
  readonly versions: {
    readonly electron: string;
    readonly chrome: string;
    readonly node: string;
  };
  readonly project: AssemblerProjectApi;
  readonly automation: AssemblerAutomationApi;
  readonly recentFiles: AssemblerRecentFilesApi;
  readonly slicers: AssemblerSlicersApi;
}
