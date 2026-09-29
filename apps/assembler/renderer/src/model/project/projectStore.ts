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
import { parseStl, suggestStlUnitHint, type StlUnitHint } from '../../kernel/stlImport.js';
import { exportBodyStl, stlBufferForMeshes } from '../../kernel/stlExport.js';
import { buildThreeMf } from '../../kernel/threeMf.js';
import type { Feature } from '../document.js';
import {
  referenceMeshFromParsedStl,
  referenceMeshToBody,
  type ReferenceMesh,
} from '../referenceMesh.js';
import { useAssemblerStore } from '../store.js';
import {
  CURRENT_SCHEMA_VERSION,
  ProjectFormatError,
  loadProjectFile,
  saveProjectFile,
  type ProjectViewState,
  type ReferenceMeshRecordV1,
} from './format.js';
import { decodeMeshPayload, encodeMeshPayload, MeshPayloadTooLargeError } from './meshCodec.js';
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
  /** A just-imported STL whose bounding box suggests it may not be in millimetres; the user must confirm/rescale or keep as-is (never applied silently). */
  unitHintOffer: { meshId: string; hint: StlUnitHint; scaleToMm: number } | null;

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
  /** File > Import > STL…: reads, parses (binary or ASCII) and adds a reference mesh; offers a unit-rescale confirmation when the bbox suggests metres/inches. */
  importStl: () => Promise<void>;
  /** Applies the offered unit rescale (uniform `scaleToMm`) to the mesh's own coordinates, or keeps it as-is; either way clears the offer. Never applied without this explicit call. */
  resolveUnitHint: (apply: boolean) => void;

  checkRecovery: () => Promise<void>;
  restoreRecovery: () => void;
  dismissRecovery: () => void;
}

let kernelAdapter: KernelAdapter | null = null;
let autosaveTimer: ReturnType<typeof setInterval> | null = null;
let recoveryDebounce: ReturnType<typeof setTimeout> | null = null;
let baselineFeatures: Feature[] | null = null;
let subscribed = false;

/** Captures the current view-only state for persistence; never affects geometry or undo history. */
function currentViewState(): ProjectViewState {
  const doc = useAssemblerStore.getState();
  return {
    displayMode: doc.viewState.displayMode,
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
    },
    panels: { items: doc.panels.items, history: doc.panels.history },
  };
}

/** Encodes every reference mesh's triangle data (gzip+base64, `meshCodec.ts`) for the `.hcasm` file. */
async function encodeReferenceMeshes(
  meshes: readonly ReferenceMesh[],
): Promise<ReferenceMeshRecordV1[]> {
  return Promise.all(
    meshes.map(async (m) => ({
      id: m.id,
      name: m.name,
      fileName: m.fileName,
      data: await encodeMeshPayload({
        positions: m.positions,
        normals: m.normals,
        indices: m.indices,
      }),
      min: m.min,
      max: m.max,
      transform: { ...m.transform },
      hidden: m.hidden,
    })),
  );
}

/** Inverse of {@link encodeReferenceMeshes}; propagates {@link MeshPayloadTooLargeError} so a load that exceeds the size limit is rejected with a clear message, never a silent partial load. */
async function decodeReferenceMeshes(
  records: readonly ReferenceMeshRecordV1[],
): Promise<ReferenceMesh[]> {
  return Promise.all(
    records.map(async (r) => {
      const buffers = await decodeMeshPayload(r.data);
      return {
        id: r.id,
        name: r.name,
        fileName: r.fileName,
        positions: buffers.positions,
        normals: buffers.normals,
        indices: buffers.indices,
        min: r.min,
        max: r.max,
        transform: { ...r.transform },
        hidden: r.hidden,
      } satisfies ReferenceMesh;
    }),
  );
}

async function currentProjectPayload(): Promise<string> {
  const doc = useAssemblerStore.getState();
  const project = useProjectStore.getState();
  const referenceMeshes = await encodeReferenceMeshes(doc.referenceMeshes);
  return saveProjectFile({
    projectName: doc.projectName,
    features: doc.features,
    appVersion: APP_VERSION,
    referenceMeshes,
    viewState: currentViewState(),
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
    void currentProjectPayload().then((text) => io.writeRecovery(text));
  }, RECOVERY_DEBOUNCE_MS);
  unref(recoveryDebounce);
}

function ensureAutosave(): void {
  if (autosaveTimer) return;
  autosaveTimer = setInterval(() => {
    void currentProjectPayload().then((text) => io.writeRecovery(text));
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
  unitHintOffer: null,

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
      const referenceMeshes = await decodeReferenceMeshes(project.referenceMeshes ?? []);
      baselineFeatures = project.features;
      useAssemblerStore
        .getState()
        .loadDocument(project.features, { projectName: project.projectName, referenceMeshes });
      useAssemblerStore.getState().applyViewState(project.viewState ?? {});
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
          error instanceof ProjectFormatError || error instanceof MeshPayloadTooLargeError
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
      const text = await currentProjectPayload();
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
      const text = await currentProjectPayload();
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
    const visibleMeshes = doc.referenceMeshes.filter((m) => !m.hidden);
    if (doc.evaluation.bodies.length === 0 && visibleMeshes.length === 0) return;
    set({ busyMessage: 'Exporting STL…' });
    try {
      const meshBodies = visibleMeshes.map(referenceMeshToBody);
      const bytes = new Uint8Array(
        stlBufferForMeshes([...doc.evaluation.bodies, ...meshBodies].map((b) => b.mesh)),
      );
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
    const visibleMeshes = doc.referenceMeshes.filter((m) => !m.hidden);
    if (doc.evaluation.bodies.length === 0 && visibleMeshes.length === 0) return;
    set({ busyMessage: 'Exporting 3MF…' });
    try {
      const bytes = buildThreeMf([
        ...doc.evaluation.bodies,
        ...visibleMeshes.map(referenceMeshToBody),
      ]);
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
  importStl: async () => {
    const opened = await io.openStlDialog();
    if (!opened) return;
    try {
      const parsed = parseStl(opened.bytes);
      if (parsed.triangleCount === 0) {
        set({ loadError: `"${opened.fileName}" has no usable triangles.` });
        return;
      }
      const id = `refmesh-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
      const mesh = referenceMeshFromParsedStl({
        id,
        name: opened.fileName.replace(/\.stl$/i, '') || 'Reference mesh',
        fileName: opened.fileName,
        parsed,
      });
      useAssemblerStore.getState().importReferenceMesh(mesh);
      const suggestion = suggestStlUnitHint(parsed.min, parsed.max);
      if (suggestion) {
        set({
          unitHintOffer: { meshId: id, hint: suggestion.hint, scaleToMm: suggestion.scaleToMm },
        });
      }
    } catch (error) {
      set({
        loadError: `Could not import "${opened.fileName}": ${error instanceof Error ? error.message : String(error)}`,
      });
    }
  },
  resolveUnitHint: (apply) => {
    const offer = get().unitHintOffer;
    set({ unitHintOffer: null });
    if (!offer || !apply) return;
    const mesh = useAssemblerStore.getState().referenceMeshes.find((m) => m.id === offer.meshId);
    if (!mesh) return;
    // Rescales the mesh's own coordinates uniformly around its own origin
    // (not the document-level `transform`, which stays an independent
    // translation applied on top) — an explicit, one-time, user-confirmed
    // edit, never automatic.
    const scale = offer.scaleToMm;
    const positions = new Float32Array(mesh.positions.length);
    for (let i = 0; i < positions.length; i += 1) positions[i] = mesh.positions[i]! * scale;
    const min: [number, number, number] = [
      mesh.min[0] * scale,
      mesh.min[1] * scale,
      mesh.min[2] * scale,
    ];
    const max: [number, number, number] = [
      mesh.max[0] * scale,
      mesh.max[1] * scale,
      mesh.max[2] * scale,
    ];
    useAssemblerStore.getState().removeReferenceMesh(mesh.id);
    useAssemblerStore
      .getState()
      .importReferenceMesh({ ...mesh, positions, normals: mesh.normals, min, max });
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
        useAssemblerStore
          .getState()
          .loadDocument(project.features, { projectName: project.projectName, referenceMeshes });
        useAssemblerStore.getState().applyViewState(project.viewState ?? {});
        set({
          recoveryOffer: null,
          dirty: true,
          filePath: null,
          createdAt: project.createdAt,
          lastSavedAt: null,
        });
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
