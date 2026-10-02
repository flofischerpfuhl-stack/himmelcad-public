/**
 * The web product's platform host (contract:
 * `apps/assembler/renderer/src/foundation/host/host.ts`):
 *
 * - files: File System Access API (open/save in place, save pickers for
 *   exports) where the browser has it, otherwise upload and download;
 * - recent projects: file handles in IndexedDB (File System Access only);
 * - recovery: IndexedDB (falls back to `localStorage`);
 * - window: no close interception (the web product adds a `beforeunload`
 *   guard), projects opened from the operating system through the File
 *   Handling API when installed;
 * - slicers: none (a page cannot start programs; Open in Slicer downloads
 *   the 3MF);
 * - agent: the in-page API (`inPageAgent.ts`);
 * - assistant: none (it starts the user's agent CLI, which a page cannot;
 *   the island explains this and points to the desktop app).
 */
import type {
  AssemblerHost,
  HostOpenResult,
  HostRecovery,
  HostWindow,
} from '../../../assembler/renderer/src/foundation/host/index.js';
import {
  ASSISTANT_NEEDS_DESKTOP,
  browserFiles,
  localStorageRecovery,
} from '../../../assembler/renderer/src/foundation/host/index.js';
import { hasFileSystemAccess, type FileHandle } from './fileAccess.js';
import { hasIndexedDb, idbDelete, idbGet, idbPut } from './idb.js';
import { createInPageAgent } from './inPageAgent.js';
import { fileSystemAccessFiles, fileSystemAccessRecents, openFromLaunch } from './projectFiles.js';

const RECOVERY_KEY = 'recovery';

/** The recovery copy in IndexedDB: projects with reference meshes outgrow `localStorage` (~5 MB). */
const indexedDbRecovery: HostRecovery = {
  read: async () => {
    const value = await idbGet<{ text: string; when: string }>('kv', RECOVERY_KEY);
    if (value && typeof value.text === 'string' && typeof value.when === 'string') return value;
    // A copy written before the web host existed (plain browser build).
    return localStorageRecovery.read();
  },
  write: (text) => idbPut('kv', { text, when: new Date().toISOString() }, RECOVERY_KEY),
  clear: async () => {
    await idbDelete('kv', RECOVERY_KEY);
    await localStorageRecovery.clear();
  },
};

interface LaunchParams {
  files: readonly FileSystemHandle[];
}

interface LaunchQueue {
  setConsumer(consumer: (params: LaunchParams) => void): void;
}

/** Files opened with the installed app ("Open with", double-click), File Handling API. */
const webWindow: HostWindow = {
  onCloseRequested: () => () => undefined,
  respondClose: async () => undefined,
  onOpenRequested: (listener: (opened: HostOpenResult) => void) => {
    const queue = (window as unknown as { launchQueue?: LaunchQueue }).launchQueue;
    let active = true;
    queue?.setConsumer((params) => {
      const handle = params.files.find((h) => h.kind === 'file') as FileHandle | undefined;
      if (!active || !handle) return;
      void openFromLaunch(handle).then(listener, () => undefined);
    });
    return () => {
      active = false;
    };
  },
};

export function createWebHost(): AssemblerHost {
  const fileAccess = hasFileSystemAccess();
  const idb = hasIndexedDb();
  return {
    kind: 'web',
    files: fileAccess ? fileSystemAccessFiles : browserFiles,
    recovery: idb ? indexedDbRecovery : localStorageRecovery,
    window: webWindow,
    recentFiles: fileAccess && idb ? fileSystemAccessRecents : null,
    slicers: null,
    automation: createInPageAgent(),
    assistant: null,
    unavailableReason: (capability) => {
      if (capability === 'assistant') return ASSISTANT_NEEDS_DESKTOP;
      if (capability === 'recentFiles')
        return 'This browser cannot reopen files on its own: use Open… (Chrome and Edge list recent projects here).';
      if (capability === 'slicers')
        return 'A browser cannot start programs: open the downloaded 3MF in Bambu Studio, OrcaSlicer, PrusaSlicer or Cura.';
      return '';
    },
  };
}
