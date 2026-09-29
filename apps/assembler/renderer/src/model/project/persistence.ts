/**
 * File I/O abstraction over the two runtimes this app ships for
 * (`apps/assembler/README.md`): Electron (native dialogs + filesystem via
 * `window.assembler.project`, see `electron/fileApi.ts`) and the browser
 * (`pnpm dev:web`, file input for Open, downloads for Save/Export). Callers
 * (`projectStore.ts`, the `file.*` commands) never branch on the runtime
 * themselves — they call these functions.
 */
// `window.assembler`'s type comes from the ambient augmentation in
// `../../global.d.ts` (included by both `tsconfig.json`, the renderer
// program, and `tsconfig.test.json`, see its `include`).

export interface OpenResult {
  /** Electron: the absolute path opened. Web: `null` — a File object has no path. */
  path: string | null;
  text: string;
}

export interface SaveResult {
  /** Electron: the absolute path saved to. Web: `null` — a download has no path. */
  path: string | null;
}

function isElectron(): boolean {
  return typeof window !== 'undefined' && window.assembler !== undefined;
}

export { isElectron };

/** Opens a native/browser file picker for a `.hcasm` project and reads its text. `null` if cancelled. */
export async function openProjectDialog(): Promise<OpenResult | null> {
  if (isElectron()) {
    const result = await window.assembler!.project.openDialog();
    return result ? { path: result.path, text: result.text } : null;
  }
  return openViaFileInput('.hcasm');
}

function openViaFileInput(accept: string): Promise<OpenResult | null> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = accept;
    input.style.display = 'none';
    let settled = false;
    const finish = (value: OpenResult | null) => {
      if (settled) return;
      settled = true;
      input.remove();
      resolve(value);
    };
    input.addEventListener('change', () => {
      const file = input.files?.[0];
      if (!file) {
        finish(null);
        return;
      }
      void file.text().then((text) => finish({ path: null, text }));
    });
    // A cancelled native picker fires no event Chromium exposes reliably across
    // platforms; the caller's UI is expected to tolerate "no change" (no-op).
    document.body.appendChild(input);
    input.click();
  });
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
 * Opens a native/browser file picker for a STEP file (`.step`/`.stp`) and
 * returns its bytes as base64, ready to embed in an `ImportStepFeature`.
 */
export async function openStepDialog(): Promise<{ fileName: string; base64: string } | null> {
  if (isElectron()) {
    // Electron has no dedicated binary-open dialog in this app's IPC surface
    // yet (only the project-file open dialog); reuse the browser picker,
    // which works identically inside Electron's Chromium renderer.
    return openBinaryViaFileInput('.step,.stp');
  }
  return openBinaryViaFileInput('.step,.stp');
}

/**
 * Opens a native/browser file picker for an STL file (`.stl`) and returns
 * its raw bytes, ready for `kernel/stlImport.ts#parseStl`. Binary and ASCII
 * STL are both plain bytes here; format detection happens in the parser.
 */
export async function openStlDialog(): Promise<{ fileName: string; bytes: Uint8Array } | null> {
  return openBinaryBytesViaFileInput('.stl');
}

function openBinaryBytesViaFileInput(
  accept: string,
): Promise<{ fileName: string; bytes: Uint8Array } | null> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = accept;
    input.style.display = 'none';
    let settled = false;
    const finish = (value: { fileName: string; bytes: Uint8Array } | null) => {
      if (settled) return;
      settled = true;
      input.remove();
      resolve(value);
    };
    input.addEventListener('change', () => {
      const file = input.files?.[0];
      if (!file) {
        finish(null);
        return;
      }
      void file
        .arrayBuffer()
        .then((buffer) => finish({ fileName: file.name, bytes: new Uint8Array(buffer) }));
    });
    document.body.appendChild(input);
    input.click();
  });
}

function openBinaryViaFileInput(
  accept: string,
): Promise<{ fileName: string; base64: string } | null> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = accept;
    input.style.display = 'none';
    let settled = false;
    const finish = (value: { fileName: string; base64: string } | null) => {
      if (settled) return;
      settled = true;
      input.remove();
      resolve(value);
    };
    input.addEventListener('change', () => {
      const file = input.files?.[0];
      if (!file) {
        finish(null);
        return;
      }
      void file
        .arrayBuffer()
        .then((buffer) =>
          finish({ fileName: file.name, base64: bytesToBase64(new Uint8Array(buffer)) }),
        );
    });
    document.body.appendChild(input);
    input.click();
  });
}

/**
 * Saves `text` to `path` if given (Electron, "Save"), otherwise prompts
 * ("Save As" / web download). Returns the path saved to (Electron) or
 * `null` (web, or cancelled).
 */
export async function saveProjectText(
  text: string,
  options: { path?: string | null; suggestedName: string; forceDialog?: boolean },
): Promise<SaveResult | null> {
  if (isElectron()) {
    const api = window.assembler!.project;
    let path = options.forceDialog ? null : (options.path ?? null);
    if (!path) {
      const chosen = await api.saveDialog(options.suggestedName);
      if (!chosen) return null;
      path = chosen.path;
    }
    await api.save(path, text);
    return { path };
  }
  downloadBlob(new Blob([text], { type: 'application/json' }), options.suggestedName);
  return { path: null };
}

/** Exports binary `bytes` via a native "Save As" dialog (Electron) or a browser download. */
export async function exportBinary(
  bytes: Uint8Array,
  suggestedName: string,
  filters: { name: string; extensions: string[] }[],
  mimeType: string,
): Promise<SaveResult | null> {
  if (isElectron()) {
    const api = window.assembler!.project;
    const chosen = await api.exportDialog(suggestedName, filters);
    if (!chosen) return null;
    await api.writeBinary(chosen.path, bytes);
    return { path: chosen.path };
  }
  downloadBlob(new Blob([new Uint8Array(bytes)], { type: mimeType }), suggestedName);
  return { path: null };
}

function downloadBlob(blob: Blob, suggestedName: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = suggestedName;
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

const WEB_RECOVERY_KEY = 'himmelcad-assembler:recovery';

/** `localStorage` when available (browser/Electron renderer); `null` under Node (tests) or when blocked (private mode). */
function webStorage(): Storage | null {
  try {
    return typeof localStorage !== 'undefined' ? localStorage : null;
  } catch {
    return null;
  }
}

export async function readRecovery(): Promise<{ text: string; when: string } | null> {
  if (isElectron()) return window.assembler!.project.readRecovery();
  const raw = webStorage()?.getItem(WEB_RECOVERY_KEY);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as { text: string; when: string };
    if (typeof parsed.text === 'string' && typeof parsed.when === 'string') return parsed;
    return null;
  } catch {
    return null;
  }
}

export async function writeRecovery(text: string): Promise<void> {
  if (isElectron()) {
    await window.assembler!.project.writeRecovery(text);
    return;
  }
  webStorage()?.setItem(WEB_RECOVERY_KEY, JSON.stringify({ text, when: new Date().toISOString() }));
}

export async function clearRecovery(): Promise<void> {
  if (isElectron()) {
    await window.assembler!.project.clearRecovery();
    return;
  }
  webStorage()?.removeItem(WEB_RECOVERY_KEY);
}

/**
 * Registers the Electron main-process close confirmation. No-op on the web
 * (there is no equivalent "window close" to intercept there; browsers get
 * `beforeunload` instead, wired separately by the caller if desired).
 */
export function onCloseRequested(listener: () => void): () => void {
  if (isElectron()) return window.assembler!.project.onCloseRequested(listener);
  return () => undefined;
}

export async function respondClose(allow: boolean): Promise<void> {
  if (isElectron()) await window.assembler!.project.respondClose(allow);
}

export interface RecentFileInfo {
  path: string;
  name: string;
  missing: boolean;
}

export interface RecentOpenResult {
  path: string;
  text: string;
}

/** `[]` on the web (no filesystem paths to remember there — the browser Open flow has no path). */
export async function listRecentFiles(): Promise<RecentFileInfo[]> {
  if (isElectron()) return window.assembler!.recentFiles.list();
  return [];
}

export async function removeRecentFile(path: string): Promise<void> {
  if (isElectron()) await window.assembler!.recentFiles.remove(path);
}

export async function openRecentFile(path: string): Promise<RecentOpenResult | null> {
  if (isElectron()) return window.assembler!.recentFiles.openPath(path);
  return null;
}

export async function locateRecentFile(oldPath: string): Promise<RecentOpenResult | null> {
  if (isElectron()) return window.assembler!.recentFiles.locate(oldPath);
  return null;
}
