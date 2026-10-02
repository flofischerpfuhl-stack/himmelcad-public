/**
 * The desktop host: an adapter over the Electron preload bridge
 * `window.assembler` (`electron/preload.ts`, shape `electron/assemblerApi.ts`;
 * its type comes from the ambient augmentation in `renderer/src/global.d.ts`).
 * Formerly the `isElectron()` branches of `document/persistence.ts`,
 * unchanged. Binary opens use the browser picker, which works identically in
 * Electron's Chromium renderer (the IPC surface has no binary-open dialog).
 */
import { pickBinaryFile } from './browserHost.js';
import type { AssemblerHost } from './host.js';

type Bridge = NonNullable<Window['assembler']>;

/** The preload bridge, if this renderer runs in the desktop app. */
export function desktopBridge(): Bridge | undefined {
  return typeof window !== 'undefined' ? window.assembler : undefined;
}

export function createDesktopHost(bridge: Bridge): AssemblerHost {
  const api = bridge.project;
  return {
    kind: 'desktop',
    files: {
      openProject: async () => {
        const result = await api.openDialog();
        return result ? { path: result.path, text: result.text } : null;
      },
      openBinary: (accept) => pickBinaryFile(accept),
      saveProject: async (text, options) => {
        let path = options.forceDialog ? null : (options.path ?? null);
        if (!path) {
          const chosen = await api.saveDialog(options.suggestedName);
          if (!chosen) return null;
          path = chosen.path;
        }
        await api.save(path, text);
        return { path };
      },
      exportBinary: async (bytes, suggestedName, filters) => {
        const chosen = await api.exportDialog(suggestedName, filters);
        if (!chosen) return null;
        await api.writeBinary(chosen.path, bytes);
        return { path: chosen.path };
      },
    },
    recovery: {
      read: () => api.readRecovery(),
      write: (text) => api.writeRecovery(text),
      clear: () => api.clearRecovery(),
    },
    window: {
      onCloseRequested: (listener) => api.onCloseRequested(listener),
      respondClose: (allow) => api.respondClose(allow),
      onOpenRequested: (listener) => api.onOpenRequested((path, text) => listener({ path, text })),
    },
    recentFiles: bridge.recentFiles,
    slicers: bridge.slicers,
    automation: bridge.automation,
    // The embedded assistant: local agent CLIs run by the main process (`electron/assistantHost.ts`).
    assistant: bridge.assistant ?? null,
    unavailableReason: (capability) =>
      capability === 'assistant' && !bridge.assistant
        ? 'This build of the app has no assistant host.'
        : '',
  };
}
