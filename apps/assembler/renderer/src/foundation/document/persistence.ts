/**
 * File I/O for the project lifecycle and the exchange formats, over the
 * platform host (`foundation/host`): the desktop app (native dialogs and
 * filesystem through `window.assembler`), the web product (File System
 * Access API or upload/download, IndexedDB) or a plain browser
 * (`pnpm dev:web`). Callers (`projectStore.ts`, the `file.*` commands,
 * exports) never branch on the runtime themselves — they call these
 * functions.
 */
import { host, type HostRecentFileInfo } from '../host/index.js';

export interface OpenResult {
  /** Desktop: the absolute path opened. Web: an opaque file-handle id, or `null` for an uploaded copy. */
  path: string | null;
  text: string;
}

export interface SaveResult {
  /** Desktop: the absolute path saved to. Web: an opaque file-handle id, or `null` for a download. */
  path: string | null;
}

/** `true` in the desktop app (the Electron preload bridge is the host). */
function isElectron(): boolean {
  return host().kind === 'desktop';
}

export { isElectron };

/** Opens a native/browser file picker for a `.hcasm` project and reads its text. `null` if cancelled. */
export async function openProjectDialog(): Promise<OpenResult | null> {
  return host().files.openProject();
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

/**
 * Opens a file picker for a STEP file (`.step`/`.stp`) and returns its bytes
 * as base64, ready to embed in an `ImportStepFeature`.
 */
export async function openStepDialog(): Promise<{ fileName: string; base64: string } | null> {
  const picked = await host().files.openBinary('.step,.stp');
  return picked ? { fileName: picked.fileName, base64: bytesToBase64(picked.bytes) } : null;
}

/**
 * Opens a file picker for an STL file (`.stl`) and returns its raw bytes,
 * ready for `kernel/stlImport.ts#parseStl`. Binary and ASCII STL are both
 * plain bytes here; format detection happens in the parser.
 */
export async function openStlDialog(): Promise<{ fileName: string; bytes: Uint8Array } | null> {
  return host().files.openBinary('.stl');
}

/**
 * Saves `text` to `path` if given ("Save"), otherwise prompts ("Save As" /
 * web download). Returns where it was saved (`path` `null` for a download),
 * or `null` if cancelled.
 */
export async function saveProjectText(
  text: string,
  options: { path?: string | null; suggestedName: string; forceDialog?: boolean },
): Promise<SaveResult | null> {
  return host().files.saveProject(text, options);
}

/** Exports binary `bytes` via a "Save As" dialog (desktop, Chromium) or a browser download. */
export async function exportBinary(
  bytes: Uint8Array,
  suggestedName: string,
  filters: { name: string; extensions: string[] }[],
  mimeType: string,
): Promise<SaveResult | null> {
  return host().files.exportBinary(bytes, suggestedName, filters, mimeType);
}

export async function readRecovery(): Promise<{ text: string; when: string } | null> {
  return host().recovery.read();
}

export async function writeRecovery(text: string): Promise<void> {
  await host().recovery.write(text);
}

export async function clearRecovery(): Promise<void> {
  await host().recovery.clear();
}

/**
 * Registers the host's close confirmation (Electron: the main process asks
 * before the window closes). No-op on the web, where `beforeunload` can only
 * show the browser's own prompt (the web product wires that itself).
 */
export function onCloseRequested(listener: () => void): () => void {
  return host().window.onCloseRequested(listener);
}

/**
 * Fires when the host wants a `.hcasm` opened outside the normal Open
 * dialog: launched with a file argument (double-click, command line) or a
 * second instance forwarded its argv (`electron/main.ts`); in the installed
 * web app, a file opened through the operating system (File Handling API).
 */
export function onOpenRequested(listener: (opened: OpenResult) => void): () => void {
  return host().window.onOpenRequested(listener);
}

export async function respondClose(allow: boolean): Promise<void> {
  await host().window.respondClose(allow);
}

export type RecentFileInfo = HostRecentFileInfo;

export interface RecentOpenResult {
  path: string;
  text: string;
}

/** `true` if this host remembers recent projects (desktop; web with the File System Access API). */
export function hasRecentFiles(): boolean {
  return host().recentFiles !== null;
}

/** Why recent projects are not listed (empty when they are). */
export function recentFilesUnavailableReason(): string {
  return host().recentFiles ? '' : host().unavailableReason('recentFiles');
}

/** `[]` where the host cannot remember project locations. */
export async function listRecentFiles(): Promise<RecentFileInfo[]> {
  return (await host().recentFiles?.list()) ?? [];
}

export async function removeRecentFile(path: string): Promise<void> {
  await host().recentFiles?.remove(path);
}

export async function openRecentFile(path: string): Promise<RecentOpenResult | null> {
  return (await host().recentFiles?.openPath(path)) ?? null;
}

/** A project at `path` opened successfully: it goes to the top of Open Recent. */
export async function confirmOpenedFile(path: string): Promise<void> {
  await host().recentFiles?.confirmOpened(path);
}

export async function locateRecentFile(oldPath: string): Promise<RecentOpenResult | null> {
  return (await host().recentFiles?.locate(oldPath)) ?? null;
}
