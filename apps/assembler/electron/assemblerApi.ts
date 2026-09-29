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

export interface AssemblerApi {
  readonly platform: AssemblerPlatform;
  readonly versions: {
    readonly electron: string;
    readonly chrome: string;
    readonly node: string;
  };
  readonly project: AssemblerProjectApi;
  readonly automation: AssemblerAutomationApi;
}
