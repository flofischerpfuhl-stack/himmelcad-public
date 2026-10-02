/**
 * Project file lifecycle: dirty tracking, Save/Open/New, autosave and crash
 * recovery, the busy status of File exports (the exports themselves belong
 * to their modules: `modules/interop/meshExports.ts`, print). Offered to code
 * below the shell as {@link PROJECT_PERSISTENCE}. Kept as its own zustand store — additive to
 * `model/store.ts` (the document/tool store) rather than folded into it, so
 * the two stores can evolve independently (see the module-owner split in
 * `apps/assembler/README.md`). `model/store.ts` only gained one small,
 * additive action (`addImportedBody`) to support STEP import as a history
 * step; everything else here is new.
 */
import { create } from 'zustand';

import { APP_CAPABILITIES, AgentSession } from '../../agent-api/session.js';
import type { KernelAdapter } from '../../../foundation/geometry-kernel/adapter.js';
import type { Feature } from '../../../foundation/document/document.js';
import type { ProjectPersistence } from '../../../foundation/document/projectPersistence.js';
import {
  decodeReferenceMeshes,
  encodeReferenceMeshes,
} from '../../../foundation/commands/projectFields.js';
import { useAssemblerStore } from '../../../foundation/commands/store.js';
import {
  CURRENT_SCHEMA_VERSION,
  ProjectFormatError,
  loadProjectFile,
  saveProjectFile,
  type ProjectFileV1,
} from '../../../foundation/document/format.js';
import { MeshPayloadTooLargeError } from '../../../foundation/document/meshCodec.js';
import {
  collectProjectSections,
  loadProjectSections,
  registerProjectSection,
  watchProjectSections,
} from '../../../foundation/document/projectSections.js';
import * as io from '../../../foundation/document/persistence.js';
import { useWorkspaceStore } from '../workspace.js';
import { renderProjectThumbnail } from './thumbnail.js';

import {
  projectTemplate,
  type ProjectTemplateId,
} from '../../../foundation/commands/projectTemplates.js';

/** Bumped by hand alongside `package.json` `version`; written into saved files for diagnostics only (never read back for behaviour). */
const APP_VERSION = '0.1.0-phase1';
const AUTOSAVE_INTERVAL_MS = 60_000;
/** Debounce after a feature-history change before writing a recovery copy ("on important commits"). */
const RECOVERY_DEBOUNCE_MS = 2_000;

/** `openFile`: open a specific file (Open Recent, file association, second instance). */
export type PendingAction = 'new' | 'open' | 'openFile' | 'template' | 'close' | null;

/** The file an `openFile` pending action opens (read lazily for Open Recent). */
let pendingOpen: (() => Promise<io.OpenResult | null>) | null = null;
/** The template a `template` pending action creates. */
let pendingTemplate: ProjectTemplateId | null = null;

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
  /**
   * Opens a specific file (Open Recent, a double-clicked `.hcasm`, a second
   * app instance): asks about unsaved changes first through the same dialog
   * as New/Open. `load` reads the file; `null` = nothing to open.
   */
  requestOpenFile: (load: () => Promise<io.OpenResult | null>) => void;
  /** Home screen template card: asks about unsaved changes first, then {@link newFromTemplate}. */
  requestTemplate: (id: ProjectTemplateId) => void;
  /**
   * A new project built by a template's agent-API script
   * (`templates/projectTemplates.ts`): a real, editable history. The result
   * becomes the project's baseline (undo history cleared, not dirty), like
   * an opened file. Resolves `false` (and sets `loadError`) if it failed.
   */
  newFromTemplate: (id: ProjectTemplateId) => Promise<boolean>;
  /** Called by the Electron main process (via `onCloseRequested`) when the window is about to close. */
  requestCloseWindow: () => void;
  /** Discards unsaved changes and proceeds with `pendingAction`. */
  confirmDiscard: () => void;
  /** Cancels `pendingAction`; nothing changes. */
  cancelPending: () => void;
  /** Saves (prompting if there is no file yet), then proceeds with `pendingAction` if it succeeded. */
  saveThenProceed: () => Promise<void>;

  /** Replaces the document with a blank project (`name` defaults to `Untitled`). */
  newProject: (name?: string, options?: { keepHome?: boolean }) => void;
  openProject: () => Promise<void>;
  /**
   * Applies an already-read `.hcasm` (path + text) as the current document —
   * the common tail of `openProject` (OS dialog), the Recent Files list and
   * opening a file via double-click/command-line argument or a second app
   * instance forwarding its argv (`electron/main.ts`).
   */
  openFromResult: (opened: io.OpenResult) => Promise<boolean>;
  save: () => Promise<void>;
  saveAs: () => Promise<void>;
  /** Runs `task` (an export) with `message` as the busy status. */
  runBusy: (message: string, task: () => Promise<unknown>) => Promise<void>;

  checkRecovery: () => Promise<void>;
  restoreRecovery: () => void;
  dismissRecovery: () => void;
}

let kernelAdapter: KernelAdapter | null = null;
let autosaveTimer: ReturnType<typeof setInterval> | null = null;
let recoveryDebounce: ReturnType<typeof setTimeout> | null = null;
let baselineFeatures: Feature[] | null = null;
/** Items, saved views or reference meshes changed since the last New/Open/Save. */
let extrasDirty = false;
let subscribed = false;
/** Set while New/Open/Recover replace item names and saved views (not a user edit). */
let restoringExtras = false;

/** Runs a document replacement (New/Open/Recover) without it counting as a user edit. */
function loadWithoutDirty(load: () => void): void {
  restoringExtras = true;
  try {
    load();
  } finally {
    restoringExtras = false;
  }
}

/**
 * The products' start document: a blank "Untitled" project, never the
 * sample (owner, Block 9: Escape or closing the Home screen at start must
 * not leave the demo bracket behind; desktop and web alike). Called by the
 * product compositions before the kernel is attached, so nothing is
 * evaluated for a document that was never shown. Not an edit (not dirty)
 * and, unlike New, it keeps the crash-recovery copy the Home screen offers.
 */
export function startWithBlankDocument(): void {
  loadWithoutDirty(() =>
    useAssemblerStore.getState().loadDocument([], { projectName: 'Untitled' }),
  );
  // The new baseline (a subscription made earlier saw the replaced document as an edit).
  baselineFeatures = useAssemblerStore.getState().features;
  extrasDirty = false;
  cancelRecoveryWrite();
  useProjectStore.setState({ dirty: false });
}

function restoreExtras(project: ProjectFileV1 | null): void {
  restoringExtras = true;
  try {
    applyProjectExtras(project);
  } finally {
    restoringExtras = false;
  }
}

/**
 * The document store's own view state (camera preset, section, grid,
 * panels) as a project section; the modules' parts (display, pins, saved
 * views) come from their own sections (`foundation/document/projectSections.ts`).
 * Applied on Open by the store (`applyViewState`). View-only: never dirty.
 */
registerProjectSection({
  id: 'commands.viewState',
  order: 100,
  save: () => {
    const doc = useAssemblerStore.getState();
    return {
      viewState: {
        camera: doc.viewState.cameraRequest ? { preset: doc.viewState.cameraRequest.preset } : {},
        section: {
          enabled: doc.viewState.sectionEnabled,
          axis: doc.viewState.sectionAxis,
          offset: doc.viewState.sectionOffset,
          flipped: doc.viewState.sectionFlipped,
        },
        grid: {
          visible: doc.viewState.gridVisible,
          snap: doc.viewState.snapToGrid,
          step: doc.viewState.gridStep,
          auto: doc.viewState.gridAuto,
        },
        panels: {
          items: doc.panels.items,
          history: doc.panels.history,
          parameters: doc.panels.parameters,
        },
      },
    };
  },
  load: () => undefined,
});
/**
 * The project file text Save would write now: features, view state, saved
 * views, Items names/folders and reference meshes. Also what an agent's
 * `project.save` returns in the app (`api/app/automationStore.ts`), so an
 * agent save never drops the user's non-feature data.
 */
export async function currentProjectText(projectName?: string): Promise<string> {
  const text = await currentProjectPayload();
  if (projectName === undefined) return text;
  const file = JSON.parse(text) as { projectName: string };
  file.projectName = projectName;
  return JSON.stringify(file, null, 2);
}

async function currentProjectPayload(options: { thumbnail?: string | null } = {}): Promise<string> {
  const doc = useAssemblerStore.getState();
  const project = useProjectStore.getState();
  const referenceMeshes = await encodeReferenceMeshes(doc.referenceMeshes);
  // The modules' fields and view-state parts (items, display, pins, saved views …).
  const sections = await collectProjectSections();
  return saveProjectFile({
    projectName: doc.projectName,
    ...(options.thumbnail ? { thumbnail: options.thumbnail } : {}),
    features: doc.features,
    appVersion: APP_VERSION,
    parameters: doc.parameters,
    referenceMeshes,
    ...sections.fields,
    // One view-state object: the store's parts and the modules' parts.
    viewState: sections.viewState,
    createdAt: project.createdAt,
  });
}

/** Restores the non-feature parts of a project (the modules' sections: items, pins, saved views …). */
function applyProjectExtras(project: ProjectFileV1 | null): void {
  loadProjectSections(project);
}

/** Node's `Timeout` (unlike the browser's numeric handle) exposes `unref()` so it never keeps a test process alive. */
function unref(handle: unknown): void {
  (handle as { unref?: () => void }).unref?.();
}

/** Drops a pending recovery write (the document was just replaced or saved). */
function cancelRecoveryWrite(): void {
  if (recoveryDebounce) clearTimeout(recoveryDebounce);
  recoveryDebounce = null;
}

/** The Home screen preview written with a Save (the current view; none without geometry). */
function thumbnailOf(doc: {
  evaluation: { bodies: readonly unknown[] };
  referenceMeshes: readonly { hidden: boolean }[];
}): Promise<string | null> {
  return renderProjectThumbnail(
    doc.evaluation.bodies.length > 0 || doc.referenceMeshes.some((m) => !m.hidden),
  );
}

function writeRecoverySoon(): void {
  if (recoveryDebounce) clearTimeout(recoveryDebounce);
  recoveryDebounce = setTimeout(() => {
    void currentProjectPayload().then((text) => io.writeRecovery(text));
  }, RECOVERY_DEBOUNCE_MS);
  unref(recoveryDebounce);
}

function ensureAutosave(): void {
  if (autosaveTimer) return;
  autosaveTimer = setInterval(() => {
    // Only unsaved work needs a recovery copy: a saved project would otherwise be offered for
    // recovery at the next start (the web app has no clean-close hook that clears it).
    if (!useProjectStore.getState().dirty) return;
    void currentProjectPayload().then((text) => io.writeRecovery(text));
  }, AUTOSAVE_INTERVAL_MS);
  unref(autosaveTimer);
}

function ensureSubscription(): void {
  if (subscribed) return;
  subscribed = true;
  baselineFeatures = useAssemblerStore.getState().features;
  // Item names/folders, saved views, pins and reference meshes are saved with the project too.
  const markDirty = () => {
    if (restoringExtras) return;
    extrasDirty = true;
    useProjectStore.setState({ dirty: true });
    writeRecoverySoon();
  };
  useAssemblerStore.subscribe((state, prev) => {
    // Import/remove/hide/move of an STL reference mesh (not a feature, so not
    // covered by the feature baseline below).
    if (state.referenceMeshes !== prev.referenceMeshes) markDirty();
    // A parameter edit that recomputes no feature's `*Expression` field still
    // changes `parameters` without necessarily changing `features` identity.
    if (state.parameters !== prev.parameters) markDirty();
    if (state.features === prev.features) return;
    // Undo back to the saved feature list makes the project clean again
    // (unless items, saved views or meshes changed meanwhile).
    const dirty = extrasDirty || state.features !== baselineFeatures;
    if (dirty !== useProjectStore.getState().dirty) useProjectStore.setState({ dirty });
    if (dirty) writeRecoverySoon();
  });
  // The modules' sections (items, pins, saved views …), also those registered later.
  watchProjectSections((section) => {
    section.subscribe?.(markDirty);
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
  requestOpenFile: (load) => {
    ensureSubscription();
    const proceed = async () => {
      const opened = await load();
      if (opened) await get().openFromResult(opened);
    };
    if (!get().dirty) {
      void proceed();
      return;
    }
    pendingOpen = load;
    set({ pendingAction: 'openFile' });
  },
  requestTemplate: (id) => {
    ensureSubscription();
    if (!get().dirty) {
      void get().newFromTemplate(id);
      return;
    }
    pendingTemplate = id;
    set({ pendingAction: 'template' });
  },
  newFromTemplate: async (id) => {
    const template = projectTemplate(id);
    if (template.id === 'blank') {
      get().newProject(template.name);
      return true;
    }
    // Home stays up (with its progress line) until the part is built.
    get().newProject(template.name, { keepHome: true });
    if (!kernelAdapter) {
      set({ loadError: 'The CAD kernel is not available; templates need it.' });
      return false;
    }
    set({ busyMessage: `Creating “${template.name}”…` });
    // The template runs the canonical agent commands on this document (one
    // command layer for UI, agents and templates), then becomes the baseline.
    const session = new AgentSession({
      store: useAssemblerStore,
      kernel: kernelAdapter,
      host: { server: 'app', capabilities: APP_CAPABILITIES },
    });
    try {
      await template.build((method, params) => session.handle(method, params ?? {}));
      await useAssemblerStore.getState().whenSettled();
      const doc = useAssemblerStore.getState();
      const features = doc.features;
      baselineFeatures = features;
      extrasDirty = false;
      loadWithoutDirty(() =>
        useAssemblerStore.getState().loadDocument(features, {
          projectName: template.name,
          parameters: doc.parameters,
        }),
      );
      set({ dirty: false, loadError: null });
      // Building it scheduled recovery copies; an untouched template needs none.
      cancelRecoveryWrite();
      void io.clearRecovery();
      useAssemblerStore.getState().clearSelection();
      useWorkspaceStore.getState().sendCamera({ kind: 'fitAll' });
      useWorkspaceStore.getState().setHomeOpen(false);
      return true;
    } catch (error) {
      get().newProject(template.name, { keepHome: true });
      set({
        loadError: `Could not create “${template.name}”: ${error instanceof Error ? error.message : String(error)}`,
      });
      return false;
    } finally {
      session.dispose();
      set({ busyMessage: null });
    }
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
    else if (action === 'openFile') void openPendingFile();
    else if (action === 'template') void createPendingTemplate();
    else if (action === 'close') void io.respondClose(true);
  },
  cancelPending: () => {
    pendingOpen = null;
    pendingTemplate = null;
    set({ pendingAction: null });
  },
  saveThenProceed: async () => {
    const action = get().pendingAction;
    set({ pendingAction: null });
    await get().save();
    if (get().dirty) return; // save was cancelled (Save As dialog dismissed) — stay put
    if (action === 'new') get().newProject();
    else if (action === 'open') void get().openProject();
    else if (action === 'openFile') void openPendingFile();
    else if (action === 'template') void createPendingTemplate();
    else if (action === 'close') void io.respondClose(true);
  },

  newProject: (name, options) => {
    ensureSubscription();
    const features: Feature[] = []; // a blank document, not the demo.
    baselineFeatures = features;
    extrasDirty = false;
    loadWithoutDirty(() =>
      useAssemblerStore.getState().loadDocument(features, { projectName: name ?? 'Untitled' }),
    );
    restoreExtras(null);
    set({
      filePath: null,
      dirty: false,
      createdAt: new Date().toISOString(),
      lastSavedAt: null,
      loadError: null,
    });
    cancelRecoveryWrite();
    void io.clearRecovery();
    if (!options?.keepHome) useWorkspaceStore.getState().setHomeOpen(false);
  },

  openProject: async () => {
    ensureSubscription();
    const opened = await io.openProjectDialog();
    if (!opened) return;
    await get().openFromResult(opened);
  },

  openFromResult: async (opened) => {
    ensureSubscription();
    try {
      const project = loadProjectFile(opened.text);
      const referenceMeshes = await decodeReferenceMeshes(project.referenceMeshes ?? []);
      baselineFeatures = project.features;
      extrasDirty = false;
      loadWithoutDirty(() =>
        useAssemblerStore.getState().loadDocument(project.features, {
          projectName: project.projectName,
          referenceMeshes,
          parameters: project.parameters,
        }),
      );
      useAssemblerStore.getState().applyViewState(project.viewState ?? {});
      restoreExtras(project);
      set({
        filePath: opened.path,
        dirty: false,
        createdAt: project.createdAt,
        lastSavedAt: project.modifiedAt,
        loadError: null,
      });
      cancelRecoveryWrite();
      void io.clearRecovery();
      // Only a project that opened goes to Open Recent (a corrupt file never does).
      if (opened.path) void io.confirmOpenedFile(opened.path).catch(() => undefined);
      useWorkspaceStore.getState().setHomeOpen(false);
      return true;
    } catch (error) {
      set({
        loadError:
          error instanceof ProjectFormatError || error instanceof MeshPayloadTooLargeError
            ? error.message
            : `Could not open this project: ${error instanceof Error ? error.message : String(error)}`,
      });
      return false;
    }
  },

  save: async () => {
    ensureSubscription();
    const doc = useAssemblerStore.getState();
    set({ saving: true, busyMessage: 'Saving…' });
    try {
      const text = await currentProjectPayload({ thumbnail: await thumbnailOf(doc) });
      const result = await io.saveProjectText(text, {
        path: get().filePath,
        suggestedName: `${sanitizeFileName(doc.projectName)}.hcasm`,
      });
      if (!result) return; // cancelled
      baselineFeatures = doc.features;
      extrasDirty = false;
      set({
        filePath: result.path ?? get().filePath,
        dirty: false,
        lastSavedAt: new Date().toISOString(),
      });
      // A recovery write still pending from the last edit would bring back what was just saved.
      cancelRecoveryWrite();
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
      const text = await currentProjectPayload({ thumbnail: await thumbnailOf(doc) });
      const result = await io.saveProjectText(text, {
        suggestedName: `${sanitizeFileName(doc.projectName)}.hcasm`,
        forceDialog: true,
      });
      if (!result) return;
      baselineFeatures = doc.features;
      extrasDirty = false;
      set({
        filePath: result.path ?? get().filePath,
        dirty: false,
        lastSavedAt: new Date().toISOString(),
      });
      // A recovery write still pending from the last edit would bring back what was just saved.
      cancelRecoveryWrite();
      void io.clearRecovery();
    } finally {
      set({ saving: false, busyMessage: null });
    }
  },

  runBusy: async (message, task) => {
    set({ busyMessage: message });
    try {
      await task();
    } finally {
      set({ busyMessage: null });
    }
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
    void (async () => {
      try {
        const project = loadProjectFile(offer.text);
        const referenceMeshes = await decodeReferenceMeshes(project.referenceMeshes ?? []);
        baselineFeatures = null; // force dirty: a restored-but-unsaved recovery is not yet "saved"
        loadWithoutDirty(() =>
          useAssemblerStore.getState().loadDocument(project.features, {
            projectName: project.projectName,
            referenceMeshes,
            parameters: project.parameters,
          }),
        );
        useAssemblerStore.getState().applyViewState(project.viewState ?? {});
        restoreExtras(project);
        set({
          recoveryOffer: null,
          dirty: true,
          filePath: null,
          createdAt: project.createdAt,
          lastSavedAt: null,
        });
        useWorkspaceStore.getState().setHomeOpen(false);
      } catch (error) {
        set({
          recoveryOffer: null,
          loadError:
            error instanceof ProjectFormatError || error instanceof MeshPayloadTooLargeError
              ? error.message
              : `Could not recover the autosaved copy: ${error instanceof Error ? error.message : String(error)}`,
        });
      }
    })();
  },
  dismissRecovery: () => {
    set({ recoveryOffer: null });
    void io.clearRecovery();
  },
}));

// Subscribe to the document store immediately at module load, not lazily on
// the first Save/Open/New. Previously `ensureSubscription()` only ran inside
// those actions, so a user who edited the (implicit, unsaved) startup
// document without ever touching the File menu first never had `dirty` set
// to `true` — the subscription, and its `baselineFeatures` snapshot, simply
// didn't exist yet. Subscribing here means `dirty` is correct from the very
// first change after app startup.
ensureSubscription();

export { CURRENT_SCHEMA_VERSION };

async function createPendingTemplate(): Promise<void> {
  const id = pendingTemplate;
  pendingTemplate = null;
  if (id) await useProjectStore.getState().newFromTemplate(id);
}

/**
 * The project lifecycle for code below the shell (agent `project.*`, a
 * `.hcasm` dropped on the window); installed by the shell module.
 */
export const PROJECT_PERSISTENCE: ProjectPersistence = {
  hasUnsavedChanges: () => useProjectStore.getState().dirty,
  open: async (text) => {
    const ok = await useProjectStore.getState().openFromResult({ path: null, text });
    if (!ok) throw new Error(useProjectStore.getState().loadError ?? 'Could not open the project');
  },
  newProject: (name) => useProjectStore.getState().newProject(name),
  text: (projectName) => currentProjectText(projectName),
  requestOpen: (load) => useProjectStore.getState().requestOpenFile(load),
};

async function openPendingFile(): Promise<void> {
  const load = pendingOpen;
  pendingOpen = null;
  if (!load) return;
  const opened = await load();
  if (opened) await useProjectStore.getState().openFromResult(opened);
}
