/**
 * Platform host services (assembler/MODULES.md, foundation `host`; Block 8
 * web stream). Everything the app needs from the environment it runs in —
 * project files, recent projects, crash recovery, the window lifecycle, the
 * slicer hand-off and the agent transport — is one {@link AssemblerHost}.
 * Each product installs its implementation before anything else runs:
 *
 * - desktop (Electron): `desktopHost.ts`, a thin adapter over the preload
 *   bridge `window.assembler` (`electron/preload.ts`); it is also the
 *   default whenever that bridge exists, so the desktop composition needs no
 *   explicit install;
 * - web (PWA, `apps/assembler-web`): File System Access API with a
 *   download/upload fallback, IndexedDB recents and recovery, an in-page
 *   agent API (`apps/assembler-web/src/host/`);
 * - plain browser without a product host (`pnpm dev:web`, tests under Node):
 *   `browserHost.ts` (file input, downloads, `localStorage`).
 *
 * Callers never branch on the runtime; they read {@link host} (or the
 * persistence functions in `document/persistence.ts`, which delegate here).
 * A capability a host cannot offer is `null`, and the UI hides or disables
 * the entry with {@link AssemblerHost.unavailableReason}.
 */

/** Result of an Open: the host-specific location (a path or an opaque handle id) and the text. */
export interface HostOpenResult {
  /** Desktop: the absolute path. Web: an opaque handle id, or `null` for an uploaded copy. */
  path: string | null;
  text: string;
}

export interface HostSaveResult {
  /** Desktop: the absolute path. Web: an opaque handle id, or `null` for a download. */
  path: string | null;
}

export interface HostFileFilter {
  name: string;
  extensions: string[];
}

/** Project and exchange files. */
export interface HostFiles {
  /** Picks a `.hcasm` and reads it; `null` when cancelled. */
  openProject(): Promise<HostOpenResult | null>;
  /** Picks a binary file (`accept` = `.step,.stp` style list) and reads its bytes; `null` when cancelled. */
  openBinary(accept: string): Promise<{ fileName: string; bytes: Uint8Array } | null>;
  /**
   * Writes the project text: to `path` when given and `forceDialog` is not
   * set (Save), otherwise to a location the user picks (Save As). `null`
   * when cancelled.
   */
  saveProject(
    text: string,
    options: { path?: string | null; suggestedName: string; forceDialog?: boolean },
  ): Promise<HostSaveResult | null>;
  /** Writes an export (STL, 3MF, STEP, PNG …) where the user picks; `null` when cancelled. */
  exportBinary(
    bytes: Uint8Array,
    suggestedName: string,
    filters: HostFileFilter[],
    mimeType: string,
  ): Promise<HostSaveResult | null>;
}

/** The crash-recovery copy of the open project (autosave). */
export interface HostRecovery {
  read(): Promise<{ text: string; when: string } | null>;
  write(text: string): Promise<void>;
  clear(): Promise<void>;
}

/** Window lifecycle: close confirmation and files opened from outside the app. */
export interface HostWindow {
  /** The host asks to close while there may be unsaved work; returns an unsubscribe function. */
  onCloseRequested(listener: () => void): () => void;
  /** Answers a pending close request; `true` lets the window close. */
  respondClose(allow: boolean): Promise<void>;
  /** A project opened from outside (file association, launch argument); returns an unsubscribe function. */
  onOpenRequested(listener: (opened: HostOpenResult) => void): () => void;
}

export interface HostRecentFileInfo {
  /** The host's key: an absolute path (desktop) or an opaque handle id (web). */
  path: string;
  name: string;
  missing: boolean;
  openedAt?: string;
  modifiedAt?: string | null;
  thumbnail?: string | null;
  /** Shown under the name instead of the folder of `path` (web: where the file lives). */
  location?: string;
}

/** File › Open Recent and the Home screen list. */
export interface HostRecentFiles {
  list(): Promise<HostRecentFileInfo[]>;
  remove(path: string): Promise<void>;
  openPath(path: string): Promise<{ path: string; text: string } | null>;
  locate(oldPath: string): Promise<{ path: string; text: string } | null>;
  confirmOpened(path: string): Promise<void>;
}

/** A slicer the host can hand a model to (desktop: `electron/slicerPaths.ts`). */
export interface HostSlicerInfo {
  id: string;
  name: string;
  kind: 'bambu' | 'orca' | 'prusa' | 'cura' | 'custom';
  path: string;
  source: 'detected' | 'user';
  available: boolean;
}

export interface HostSlicerList {
  slicers: HostSlicerInfo[];
  defaultId: string | null;
  platform: string;
}

/** Starting installed programs ("Open in slicer"); desktop only. */
export interface HostSlicers {
  list(): Promise<HostSlicerList>;
  add(): Promise<HostSlicerList & { error: string | null }>;
  remove(id: string): Promise<HostSlicerList>;
  setDefault(id: string): Promise<HostSlicerList>;
  open(
    id: string,
    bytes: Uint8Array,
    projectName: string,
  ): Promise<{ ok: true; path: string; slicer: string } | { ok: false; error: string }>;
}

export interface HostAutomationStatus {
  enabled: boolean;
  /** What to show and hand to an agent: a loopback URL (desktop) or the in-page global (web). */
  url: string | null;
  port: number | null;
  token: string | null;
}

/**
 * The agent transport behind "Agent Access": requests arrive as JSON-RPC
 * text and are answered by the canonical command layer
 * (`interface/agent-api/automationStore.ts`). Desktop: a loopback HTTP
 * endpoint in the main process. Web: an in-page `window` API.
 */
export interface HostAutomation {
  status(): Promise<HostAutomationStatus>;
  setEnabled(enabled: boolean): Promise<HostAutomationStatus>;
  onRequest(listener: (id: string, body: string) => void): () => void;
  respond(id: string, body: string): Promise<void>;
}

/** A tool call a running agent CLI made (`electron/assistantHost.ts` → the assistant island). */
export interface HostAssistantToolRequest {
  /** The host's thread id of the session that made the call. */
  threadId: string;
  /** MCP tool name (`hcasm_call`, `view_render`, …). */
  name: string;
  arguments: unknown;
}

/**
 * The embedded assistant's host (assembler/AGENT-ASSISTANT.md): runs the
 * user's own Claude, Codex or OpenCode CLI as a child process and forwards
 * the tool calls it makes back to the renderer, which answers them through
 * the canonical command layer. Desktop only — a browser cannot start
 * programs.
 */
export interface HostAssistant {
  /**
   * The harness transport of `@himmelcad/agent` (`AgentHarnessHostTransport`:
   * discover, openSession, sendTurn, interrupt, closeSession, subscribe);
   * typed structurally so foundation code does not depend on the package.
   */
  readonly harness: {
    request(request: unknown): Promise<unknown>;
    subscribe(sessionId: string, onPayload: (payload: unknown) => void): () => void;
  };
  /** Tool calls of running turns; returns an unsubscribe function. */
  onToolRequest(listener: (id: string, request: HostAssistantToolRequest) => void): () => void;
  /** Answers a tool call with an MCP tool result (`{content, isError?}`). */
  respondTool(id: string, result: unknown): Promise<void>;
}

export type HostKind = 'desktop' | 'web' | 'browser';

export interface AssemblerHost {
  readonly kind: HostKind;
  readonly files: HostFiles;
  readonly recovery: HostRecovery;
  readonly window: HostWindow;
  /** `null`: this host cannot remember project locations. */
  readonly recentFiles: HostRecentFiles | null;
  /** `null`: this host cannot start programs (Open in Slicer downloads the 3MF instead). */
  readonly slicers: HostSlicers | null;
  /** `null`: no agent transport. */
  readonly automation: HostAutomation | null;
  /** `null`: no embedded assistant (it needs to start local agent CLIs). Optional for older hosts. */
  readonly assistant?: HostAssistant | null;
  /** Why a `null` capability is missing, for disabled entries and empty states. */
  unavailableReason(capability: 'recentFiles' | 'slicers' | 'automation' | 'assistant'): string;
}
