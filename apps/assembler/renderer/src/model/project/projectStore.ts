/**
 * Project file lifecycle: dirty tracking, Save/Open/New, exports, autosave
 * and crash recovery. Kept as its own zustand store — additive to
 * `model/store.ts` (the document/tool store) rather than folded into it, so
 * the two stores can evolve independently (see the module-owner split in
 * `apps/assembler/README.md`). `model/store.ts` only gained one small,
 * additive action (`addImportedBody`) to support STEP import as a history
 * step; everything else here is new.
 */
import { create } from 'zustand';

import type { KernelAdapter } from '../../kernel/adapter.js';
import { exportAllBodiesStl, exportBodyStl } from '../../kernel/stlExport.js';
import { buildThreeMf } from '../../kernel/threeMf.js';
import type { Feature } from '../document.js';
import { useAssemblerStore } from '../store.js';
import {
  CURRENT_SCHEMA_VERSION,
  ProjectFormatError,
  loadProjectFile,
  saveProjectFile,
} from './format.js';
import * as io from './persistence.js';

/** Bumped by hand alongside `package.json` `version`; written into saved files for diagnostics only (never read back for behaviour). */
const APP_VERSION = '0.1.0-phase1';
const AUTOSAVE_INTERVAL_MS = 60_000;
/** Debounce after a feature-history change before writing a recovery copy ("on important commits"). */
const RECOVERY_DEBOUNCE_MS = 2_000;

export type PendingAction = 'new' | 'open' | 'close' | null;

function sanitizeFileName(name: string): string {
  const cleaned = name.trim().replace(/[\\/:*?"<>|]+/g, '_');
  return cleaned || 'Project';
}

export interface RecoveryOffer {
  text: string;
  when: string;
}

export interface ProjectFileState {
  filePath: string | null;
  dirty: boolean;
  createdAt: string;
  lastSavedAt: string | null;
  saving: boolean;
  busyMessage: string | null;
  /** Surfaced once (e.g. by a toast/status strip) after a failed Open/Import; cleared by `clearLoadError`. */
  loadError: string | null;
  pendingAction: PendingAction;
  recoveryOffer: RecoveryOffer | null;

  attachKernelAdapter: (adapter: KernelAdapter) => void;
  clearLoadError: () => void;

  /** `true` if it is safe to discard the current document without asking. */
  isDirty: () => boolean;
  requestNew: () => void;
  requestOpen: () => void;
  /** Called by the Electron main process (via `onCloseRequested`) when the window is about to close. */
  requestCloseWindow: () => void;
  /** Discards unsaved changes and proceeds with `pendingAction`. */
  confirmDiscard: () => void;
  /** Cancels `pendingAction`; nothing changes. */
  cancelPending: () => void;
  /** Saves (prompting if there is no file yet), then proceeds with `pendingAction` if it succeeded. */
  saveThenProceed: () => Promise<void>;

  newProject: () => void;
  openProject: () => Promise<void>;
  save: () => Promise<void>;
  saveAs: () => Promise<void>;
  exportStlAll: () => Promise<void>;
  exportStlBody: (bodyId: string) => Promise<void>;
  export3mf: () => Promise<void>;
  exportStep: () => Promise<void>;
  importStep: () => Promise<void>;

  checkRecovery: () => Promise<void>;
  restoreRecovery: () => void;
  dismissRecovery: () => void;
}

let kernelAdapter: KernelAdapter | null = null;
let autosaveTimer: ReturnType<typeof setInterval> | null = null;
let recoveryDebounce: ReturnType<typeof setTimeout> | null = null;
let baselineFeatures: Feature[] | null = null;
let subscribed = false;

function currentProjectPayload(): string {
  const doc = useAssemblerStore.getState();
  const project = useProjectStore.getState();
  return saveProjectFile({
    projectName: doc.projectName,
    features: doc.features,
    appVersion: APP_VERSION,
    createdAt: project.createdAt,
  });
}

/** Node's `Timeout` (unlike the browser's numeric handle) exposes `unref()` so it never keeps a test process alive. */
function unref(handle: unknown): void {
  (handle as { unref?: () => void }).unref?.();
}

function writeRecoverySoon(): void {
  if (recoveryDebounce) clearTimeout(recoveryDebounce);
  recoveryDebounce = setTimeout(() => {
    void io.writeRecovery(currentProjectPayload());
  }, RECOVERY_DEBOUNCE_MS);
  unref(recoveryDebounce);
}

function ensureAutosave(): void {
  if (autosaveTimer) return;
  autosaveTimer = setInterval(() => {
    void io.writeRecovery(currentProjectPayload());
  }, AUTOSAVE_INTERVAL_MS);
  unref(autosaveTimer);
}

function ensureSubscription(): void {
  if (subscribed) return;
  subscribed = true;
  baselineFeatures = useAssemblerStore.getState().features;
  useAssemblerStore.subscribe((state, prev) => {
    if (state.features === prev.features) return;
    if (state.features !== baselineFeatures) {
      useProjectStore.setState({ dirty: true });
      writeRecoverySoon();
    }
  });
  ensureAutosave();
}

export const useProjectStore = create<ProjectFileState>((set, get) => ({
  filePath: null,
  dirty: false,
  createdAt: new Date().toISOString(),
  lastSavedAt: null,
  saving: false,
  busyMessage: null,
  loadError: null,
  pendingAction: null,
  recoveryOffer: null,

  attachKernelAdapter: (adapter) => {
    kernelAdapter = adapter;
  },
  clearLoadError: () => set({ loadError: null }),

  isDirty: () => get().dirty,

  requestNew: () => {
    ensureSubscription();
    if (!get().dirty) {
      get().newProject();
      return;
    }
    set({ pendingAction: 'new' });
  },
  requestOpen: () => {
    ensureSubscription();
    if (!get().dirty) {
      void get().openProject();
      return;
    }
    set({ pendingAction: 'open' });
  },
  requestCloseWindow: () => {
    ensureSubscription();
    if (!get().dirty) {
      void io.respondClose(true);
      return;
    }
    set({ pendingAction: 'close' });
  },
  confirmDiscard: () => {
    const action = get().pendingAction;
    set({ pendingAction: null });
    if (action === 'new') get().newProject();
    else if (action === 'open') void get().openProject();
    else if (action === 'close') void io.respondClose(true);
  },
  cancelPending: () => set({ pendingAction: null }),
  saveThenProceed: async () => {
    const action = get().pendingAction;
    set({ pendingAction: null });
    await get().save();
    if (get().dirty) return; // save was cancelled (Save As dialog dismissed) — stay put
    if (action === 'new') get().newProject();
    else if (action === 'open') void get().openProject();
    else if (action === 'close') void io.respondClose(true);
  },

  newProject: () => {
    ensureSubscription();
    const features: Feature[] = []; // a blank document, not the demo.
    baselineFeatures = features;
    useAssemblerStore.getState().loadDocument(features, { projectName: 'Untitled' });
    set({
      filePath: null,
      dirty: false,
      createdAt: new Date().toISOString(),
      lastSavedAt: null,
      loadError: null,
    });
    void io.clearRecovery();
  },

  openProject: async () => {
    ensureSubscription();
    const opened = await io.openProjectDialog();
    if (!opened) return;
    try {
      const project = loadProjectFile(opened.text);
      baselineFeatures = project.features;
      useAssemblerStore
        .getState()
        .loadDocument(project.features, { projectName: project.projectName });
      set({
        filePath: opened.path,
        dirty: false,
        createdAt: project.createdAt,
        lastSavedAt: project.modifiedAt,
        loadError: null,
      });
      void io.clearRecovery();
    } catch (error) {
      set({
        loadError:
          error instanceof ProjectFormatError
            ? error.message
            : `Could not open this project: ${error instanceof Error ? error.message : String(error)}`,
      });
    }
  },

  save: async () => {
    ensureSubscription();
    const doc = useAssemblerStore.getState();
    set({ saving: true, busyMessage: 'Saving…' });
    try {
      const text = currentProjectPayload();
      const result = await io.saveProjectText(text, {
        path: get().filePath,
        suggestedName: `${sanitizeFileName(doc.projectName)}.hcasm`,
      });
      if (!result) return; // cancelled
      baselineFeatures = doc.features;
      set({
        filePath: result.path ?? get().filePath,
        dirty: false,
        lastSavedAt: new Date().toISOString(),
      });
      void io.clearRecovery();
    } finally {
      set({ saving: false, busyMessage: null });
    }
  },
  saveAs: async () => {
    ensureSubscription();
    const doc = useAssemblerStore.getState();
    set({ saving: true, busyMessage: 'Saving…' });
    try {
      const text = currentProjectPayload();
      const result = await io.saveProjectText(text, {
        suggestedName: `${sanitizeFileName(doc.projectName)}.hcasm`,
        forceDialog: true,
      });
      if (!result) return;
      baselineFeatures = doc.features;
      set({
        filePath: result.path ?? get().filePath,
        dirty: false,
        lastSavedAt: new Date().toISOString(),
      });
      void io.clearRecovery();
    } finally {
      set({ saving: false, busyMessage: null });
    }
  },

  exportStlAll: async () => {
    const doc = useAssemblerStore.getState();
    if (doc.evaluation.bodies.length === 0) return;
    set({ busyMessage: 'Exporting STL…' });
    try {
      const bytes = new Uint8Array(exportAllBodiesStl(doc.evaluation.bodies));
      await io.exportBinary(
        bytes,
        `${sanitizeFileName(doc.projectName)}.stl`,
        [{ name: 'STL', extensions: ['stl'] }],
        'model/stl',
      );
    } finally {
      set({ busyMessage: null });
    }
  },
  exportStlBody: async (bodyId) => {
    const doc = useAssemblerStore.getState();
    const body = doc.evaluation.bodies.find((b) => b.id === bodyId);
    if (!body) return;
    set({ busyMessage: 'Exporting STL…' });
    try {
      const buffer = exportBodyStl(doc.evaluation.bodies, bodyId);
      if (!buffer) return;
      await io.exportBinary(
        new Uint8Array(buffer),
        `${sanitizeFileName(body.name)}.stl`,
        [{ name: 'STL', extensions: ['stl'] }],
        'model/stl',
      );
    } finally {
      set({ busyMessage: null });
    }
  },
  export3mf: async () => {
    const doc = useAssemblerStore.getState();
    if (doc.evaluation.bodies.length === 0) return;
    set({ busyMessage: 'Exporting 3MF…' });
    try {
      const bytes = buildThreeMf(doc.evaluation.bodies);
      await io.exportBinary(
        bytes,
        `${sanitizeFileName(doc.projectName)}.3mf`,
        [{ name: '3MF', extensions: ['3mf'] }],
        'model/3mf',
      );
    } finally {
      set({ busyMessage: null });
    }
  },
  exportStep: async () => {
    const doc = useAssemblerStore.getState();
    if (!kernelAdapter || doc.evaluation.bodies.length === 0) return;
    set({ busyMessage: 'Exporting STEP…' });
    try {
      const bytes = await kernelAdapter.exportStep(doc.features);
      await io.exportBinary(
        bytes,
        `${sanitizeFileName(doc.projectName)}.step`,
        [{ name: 'STEP', extensions: ['step', 'stp'] }],
        'model/step',
      );
    } catch (error) {
      set({
        loadError: `STEP export failed: ${error instanceof Error ? error.message : String(error)}`,
      });
    } finally {
      set({ busyMessage: null });
    }
  },
  importStep: async () => {
    const opened = await io.openStepDialog();
    if (!opened) return;
    useAssemblerStore
      .getState()
      .addImportedBody({ data: opened.base64, fileName: opened.fileName });
  },

  checkRecovery: async () => {
    const offer = await io.readRecovery();
    if (!offer) return;
    try {
      const project = loadProjectFile(offer.text);
      if (project.features.length === 0) return; // nothing meaningful to recover
      set({ recoveryOffer: { text: offer.text, when: offer.when } });
    } catch {
      // Corrupt recovery data: silently ignore rather than offering a broken restore.
      void io.clearRecovery();
    }
  },
  restoreRecovery: () => {
    const offer = get().recoveryOffer;
    if (!offer) return;
    const project = loadProjectFile(offer.text);
    baselineFeatures = null; // force dirty: a restored-but-unsaved recovery is not yet "saved"
    useAssemblerStore
      .getState()
      .loadDocument(project.features, { projectName: project.projectName });
    set({
      recoveryOffer: null,
      dirty: true,
      filePath: null,
      createdAt: project.createdAt,
      lastSavedAt: null,
    });
  },
  dismissRecovery: () => {
    set({ recoveryOffer: null });
    void io.clearRecovery();
  },
}));

export { CURRENT_SCHEMA_VERSION };
