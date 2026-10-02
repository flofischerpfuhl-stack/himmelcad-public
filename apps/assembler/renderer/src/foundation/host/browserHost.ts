/**
 * The plain-browser host: what any browser can do without extra APIs — a
 * hidden `<input type="file">` for opening, a download for saving and
 * exporting, `localStorage` for the recovery copy. Used by `pnpm dev:web`,
 * by tests under Node (every call degrades to "cancelled"/no-op there), and
 * by the web product as the fallback where the File System Access API is
 * missing (Safari, Firefox). Formerly the non-Electron branches of
 * `document/persistence.ts`, unchanged.
 */
import type { AssemblerHost, HostFiles, HostOpenResult, HostRecovery, HostWindow } from './host.js';

function pickFile<T>(accept: string, read: (file: File) => Promise<T>): Promise<T | null> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = accept;
    input.style.display = 'none';
    let settled = false;
    const finish = (value: T | null) => {
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
      void read(file).then(finish, () => finish(null));
    });
    // Chromium 113+, Firefox 91+, Safari 16.4+ report a dismissed picker.
    input.addEventListener('cancel', () => finish(null));
    document.body.appendChild(input);
    input.click();
  });
}

/** Opens a picker for one file; `null` when cancelled or outside a browser. */
export function pickTextFile(accept: string): Promise<HostOpenResult | null> {
  if (typeof document === 'undefined') return Promise.resolve(null);
  return pickFile(accept, async (file) => ({ path: null, text: await file.text() }));
}

export function pickBinaryFile(
  accept: string,
): Promise<{ fileName: string; bytes: Uint8Array } | null> {
  if (typeof document === 'undefined') return Promise.resolve(null);
  return pickFile(accept, async (file) => ({
    fileName: file.name,
    bytes: new Uint8Array(await file.arrayBuffer()),
  }));
}

/** Starts a browser download of `blob` named `suggestedName`. */
export function downloadBlob(blob: Blob, suggestedName: string): void {
  if (typeof document === 'undefined') return;
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

/** Open = file input, Save/Export = download (no path to remember). */
export const browserFiles: HostFiles = {
  openProject: () => pickTextFile('.hcasm'),
  openBinary: (accept) => pickBinaryFile(accept),
  saveProject: async (text, options) => {
    downloadBlob(new Blob([text], { type: 'application/json' }), options.suggestedName);
    return { path: null };
  },
  exportBinary: async (bytes, suggestedName, _filters, mimeType) => {
    downloadBlob(new Blob([new Uint8Array(bytes)], { type: mimeType }), suggestedName);
    return { path: null };
  },
};

const RECOVERY_KEY = 'himmelcad-assembler:recovery';

/** `localStorage` when available; `null` under Node (tests) or when blocked (private mode). */
function webStorage(): Storage | null {
  try {
    return typeof localStorage !== 'undefined' ? localStorage : null;
  } catch {
    return null;
  }
}

export const localStorageRecovery: HostRecovery = {
  read: async () => {
    const raw = webStorage()?.getItem(RECOVERY_KEY);
    if (!raw) return null;
    try {
      const parsed = JSON.parse(raw) as { text: string; when: string };
      if (typeof parsed.text === 'string' && typeof parsed.when === 'string') return parsed;
      return null;
    } catch {
      return null;
    }
  },
  write: async (text) => {
    webStorage()?.setItem(RECOVERY_KEY, JSON.stringify({ text, when: new Date().toISOString() }));
  },
  clear: async () => {
    webStorage()?.removeItem(RECOVERY_KEY);
  },
};

/** No OS window to intercept and no file association. */
export const inertWindow: HostWindow = {
  onCloseRequested: () => () => undefined,
  respondClose: async () => undefined,
  onOpenRequested: () => () => undefined,
};

/** Why the embedded assistant is missing in a browser (shown in its island and command). */
export const ASSISTANT_NEEDS_DESKTOP =
  'The assistant runs the Claude, Codex or OpenCode command-line tool installed on your computer, with your own subscription. A browser cannot start programs: use the desktop app, or connect an external agent through Agent Access.';

export function createBrowserHost(): AssemblerHost {
  return {
    kind: 'browser',
    files: browserFiles,
    recovery: localStorageRecovery,
    window: inertWindow,
    recentFiles: null,
    slicers: null,
    automation: null,
    assistant: null,
    unavailableReason: (capability) =>
      capability === 'recentFiles'
        ? 'Recent projects are listed in the desktop app.'
        : capability === 'slicers'
          ? 'Starting a slicer needs the desktop app: Open in Slicer downloads the 3MF.'
          : capability === 'assistant'
            ? ASSISTANT_NEEDS_DESKTOP
            : 'Only available in the desktop app.',
  };
}
