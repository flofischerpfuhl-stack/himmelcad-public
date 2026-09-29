/**
 * Application-state store for HimmelCAD Assembler.
 *
 * The single source of truth the viewport, panels, adaptive toolbar,
 * command search and context menu are built on. It owns:
 *
 * - the document (`features`) and its derived {@link EvaluationResult}
 *   (`evaluation`), computed asynchronously by the CAD kernel behind a
 *   {@link KernelAdapter} (OCCT in a Web Worker in the app, in-process in
 *   tests). Every document change bumps a revision; results of older
 *   revisions are discarded, so the viewport never shows geometry that is
 *   newer or older than the document it claims to be. Until a result
 *   arrives, `evaluation` keeps the last completed result and
 *   `evaluationPending` is `true`. Results are cached per feature-array
 *   identity, so undo/redo back to a known state is instant;
 * - transactional undo/redo of `features` (one committed tool operation or
 *   one parameter edit = exactly one undo step);
 * - selection/hover by stable naming keys (see `kernel/naming.ts`), re-mapped
 *   or pruned after every re-evaluation;
 * - view-only state (visibility, camera requests, display mode, panels)
 *   that is deliberately **not** part of the undo history;
 * - the explicit tool state machine
 *   (`collectingReferences -> preview -> numericEditing -> committing`,
 *   with `cancel()` valid from any uncommitted state) for the interactive
 *   tools `sketchRectangle`, `extrude`, `move`, plus one-step commands for
 *   fillet/chamfer, shell and body booleans.
 *
 * Built on zustand. Usable as a React hook (`useAssemblerStore()`) and
 * imperatively (`useAssemblerStore.getState()`), which is how
 * `commands/registry.ts` and the tests drive it.
 */
import { create } from 'zustand';

import type { KernelAdapter, KernelJob } from '../kernel/adapter.js';
import { baseEdgeKey, baseFaceKey, edgeSignatureOf, faceSignatureOf } from '../kernel/naming.js';
import {
  EMPTY_EVALUATION,
  type Body,
  type EvaluationResult,
  type KernelStatus,
} from '../kernel/types.js';
import {
  createDemoDocument,
  frameForFace,
  frameForPlane,
  type BooleanFeature,
  type ChamferFeature,
  type EdgeRef,
  type ExtrudeFeature,
  type ExtrudeOperation,
  type ExtrudeProfileRef,
  type FaceRef,
  type Feature,
  type FilletFeature,
  type MoveFeature,
  type Plane,
  type ShellFeature,
  type SketchFeature,
  type SketchFrame,
  type SketchPlaneRef,
} from './document.js';

/** One selectable/hoverable thing in the viewport or a panel. */
export type SelectionItem =
  | { kind: 'body'; bodyId: string }
  | { kind: 'face'; bodyId: string; faceKey: string }
  | { kind: 'edge'; bodyId: string; edgeKey: string }
  | { kind: 'sketchProfile'; featureId: string }
  | { kind: 'feature'; featureId: string };

/** Explicit lifecycle every tool session moves through. `cancel()` is valid from any of these except after commit. */
export type ToolPhase = 'collectingReferences' | 'preview' | 'numericEditing' | 'committing';

interface ToolSessionBase {
  phase: ToolPhase;
}

/** `R` — draws a rectangle on a plane, or on a selected planar body face. */
export interface SketchRectangleTool extends ToolSessionBase {
  kind: 'sketchRectangle';
  plane: SketchPlaneRef;
  /** Resolved frame the rectangle is drawn in. */
  frame: SketchFrame;
  preview: { x: number; y: number; width: number; height: number } | null;
}

/** `E` — extrudes a sketch profile or pushes/pulls a planar body face. */
export interface ExtrudeTool extends ToolSessionBase {
  kind: 'extrude';
  profile: ExtrudeProfileRef;
  distance: number;
  operation: ExtrudeOperation;
  targetBodyId?: string;
  /** `true` once the user picked the operation explicitly (disables sign-based join/cut). */
  operationLocked: boolean;
  /**
   * Kernel evaluation of `features + provisional feature`, recomputed
   * asynchronously on every change without touching `features`. `null`
   * until the first preview result arrives. The provisional feature
   * carries the reserved id `"__preview_extrude__"`.
   */
  previewEvaluation: EvaluationResult | null;
  /** `true` while a newer preview than `previewEvaluation` is being computed. */
  previewPending: boolean;
}

/** `M` — translates a single body. */
export interface MoveTool extends ToolSessionBase {
  kind: 'move';
  bodyId: string;
  delta: { dx: number; dy: number; dz: number };
}

export type ToolSession = SketchRectangleTool | ExtrudeTool | MoveTool;

/** Reserved feature id used only for the extrude tool's live preview; never committed. */
export const PREVIEW_EXTRUDE_FEATURE_ID = '__preview_extrude__';

export type DisplayMode = 'shaded' | 'wireframe' | 'xray';
export type SectionAxis = 'X' | 'Y' | 'Z';
export type CameraPreset = 'iso' | 'front' | 'back' | 'top' | 'bottom' | 'left' | 'right' | 'fit';

export interface ViewState {
  displayMode: DisplayMode;
  sectionEnabled: boolean;
  sectionAxis: SectionAxis;
  sectionOffset: number;
  measureEnabled: boolean;
  gridVisible: boolean;
  snapToGrid: boolean;
  gridStep: number;
  /** Bumping `nonce` is the signal to (re-)apply `preset`. */
  cameraRequest: { preset: CameraPreset; nonce: number } | null;
}

export interface PanelsState {
  items: boolean;
  history: boolean;
}

/**
 * Patch for {@link AssemblerState.editFeatureParams}. Callers pass a patch
 * shape that matches the feature they edit; never include `id` or `kind`.
 */
export type FeaturePatch = {
  [K in Feature['kind']]: Partial<Omit<Extract<Feature, { kind: K }>, 'id' | 'kind'>>;
}[Feature['kind']];

export interface AssemblerState {
  projectName: string;
  /** Sets the project's display name (not undo-tracked). Blank input is ignored. */
  setProjectName: (name: string) => void;
  features: Feature[];
  /** Last completed kernel evaluation (see `evaluationPending`). */
  evaluation: EvaluationResult;
  /** `true` while the kernel computes a newer document revision than `evaluation`. */
  evaluationPending: boolean;

  kernelStatus: KernelStatus;
  kernelMessage: string;
  /** Kernel load progress 0..1 while loading, when known. */
  kernelProgress: number | null;
  /** Measured kernel load time once ready, ms. */
  kernelLoadMs: number | null;
  /** Connects the store to a kernel and evaluates the current document. */
  attachKernel: (adapter: KernelAdapter) => void;
  /** Resolves once no document or preview evaluation is outstanding. */
  whenSettled: () => Promise<void>;

  history: { canUndo: boolean; canRedo: boolean };
  undo: () => void;
  redo: () => void;

  selection: SelectionItem[];
  hover: SelectionItem | null;
  select: (item: SelectionItem, options?: { additive?: boolean }) => void;
  toggle: (item: SelectionItem) => void;
  clearSelection: () => void;
  setHover: (item: SelectionItem | null) => void;

  hiddenBodyIds: string[];
  isolatedBodyIds: string[] | null;
  hideBodies: (bodyIds: string[]) => void;
  showBodies: (bodyIds: string[]) => void;
  showAllBodies: () => void;
  setIsolatedBodyIds: (bodyIds: string[] | null) => void;

  activeTool: ToolSession | null;
  beginSketchRectangle: (origin?: { bodyId: string; faceKey: string }) => void;
  setPreviewRect: (x: number, y: number, width: number, height: number) => void;
  beginExtrude: (profile: ExtrudeProfileRef) => void;
  setDistance: (distanceMm: number) => void;
  setExtrudeOperation: (operation: ExtrudeOperation) => void;
  beginMove: (bodyId: string) => void;
  setDelta: (dx: number, dy: number, dz: number) => void;
  /** Enters the `numericEditing` phase (e.g. a dimension field gained focus). No-op without an active tool. */
  beginNumericEditing: () => void;
  /** Leaves `numericEditing` back to `preview`. No-op unless currently `numericEditing`. */
  endNumericEditing: () => void;
  /** Commits the active tool's provisional feature as exactly one undo step. No-op without an active tool. */
  commit: () => void;
  /** Cancels the active tool. `features` and the undo stack are left exactly as they were. */
  cancel: () => void;

  /** Fillets or chamfers the selected edges (one undo step); selects the new feature. */
  addEdgeBlend: (kind: 'fillet' | 'chamfer', size: number) => void;
  /** Shells the body of the selected faces, opening them (one undo step). */
  addShell: (thickness: number) => void;
  /** Boolean of the selected bodies: the first selected body is the target (one undo step). */
  addBoolean: (operation: BooleanFeature['operation']) => void;

  editFeatureParams: (featureId: string, patch: FeaturePatch) => void;
  setSuppressed: (featureId: string, suppressed: boolean) => void;
  renameFeature: (featureId: string, name: string) => void;
  deleteFeature: (featureId: string) => void;

  viewState: ViewState;
  setDisplayMode: (mode: DisplayMode) => void;
  setSectionEnabled: (enabled: boolean) => void;
  setSectionAxis: (axis: SectionAxis) => void;
  setSectionOffset: (offset: number) => void;
  setMeasureEnabled: (enabled: boolean) => void;
  setGridVisible: (visible: boolean) => void;
  setSnapToGrid: (enabled: boolean) => void;
  setGridStep: (step: number) => void;
  requestCamera: (preset: CameraPreset) => void;

  panels: PanelsState;
  togglePanel: (panel: keyof PanelsState) => void;
  setPanelVisible: (panel: keyof PanelsState, visible: boolean) => void;

  recentCommandIds: string[];
  pushRecentCommand: (commandId: string) => void;

  /**
   * Replaces the whole document (features + project name), resetting undo
   * history, selection, hover and visibility state.
   */
  loadDocument: (features: Feature[], options?: { projectName?: string }) => void;
}

// ---- reference helpers (pure) -------------------------------------------------

/** Finds a face of a body by naming key: exact key, then alias, then split-face base key. */
export function findFace(body: Body, faceKey: string) {
  return (
    body.faces.find((f) => f.key === faceKey) ??
    body.faces.find((f) => f.aliases.includes(faceKey)) ??
    body.faces.find((f) => baseFaceKey(f.key) === baseFaceKey(faceKey))
  );
}

export function findEdge(body: Body, edgeKey: string) {
  return (
    body.edges.find((e) => e.key === edgeKey) ??
    body.edges.find((e) => baseEdgeKey(e.key) === baseEdgeKey(edgeKey))
  );
}

/** Stable {@link FaceRef} for a face of the given evaluation, or `null` if it doesn't resolve. */
export function makeFaceRef(
  evaluation: EvaluationResult,
  bodyId: string,
  faceKey: string,
): FaceRef | null {
  const body = evaluation.bodies.find((b) => b.id === bodyId);
  const face = body ? findFace(body, faceKey) : undefined;
  if (!face) return null;
  return { bodyId, key: face.key, signature: faceSignatureOf(face) };
}

export function makeEdgeRef(
  evaluation: EvaluationResult,
  bodyId: string,
  edgeKey: string,
): EdgeRef | null {
  const body = evaluation.bodies.find((b) => b.id === bodyId);
  const edge = body ? findEdge(body, edgeKey) : undefined;
  if (!edge) return null;
  return { bodyId, key: edge.key, signature: edgeSignatureOf(edge) };
}

/** `true` if the face is planar (usable as sketch plane or push/pull face). */
export function isPlanarFace(
  evaluation: EvaluationResult,
  bodyId: string,
  faceKey: string,
): boolean {
  const body = evaluation.bodies.find((b) => b.id === bodyId);
  const face = body ? findFace(body, faceKey) : undefined;
  return face?.surface === 'plane' && face.normal !== null;
}

function selectionKeysEqual(a: SelectionItem, b: SelectionItem): boolean {
  switch (a.kind) {
    case 'body':
      return b.kind === 'body' && a.bodyId === b.bodyId;
    case 'face':
      return b.kind === 'face' && a.bodyId === b.bodyId && a.faceKey === b.faceKey;
    case 'edge':
      return b.kind === 'edge' && a.bodyId === b.bodyId && a.edgeKey === b.edgeKey;
    case 'sketchProfile':
      return b.kind === 'sketchProfile' && a.featureId === b.featureId;
    case 'feature':
      return b.kind === 'feature' && a.featureId === b.featureId;
  }
}

/** Re-maps a selection item onto a new evaluation (keys may gain/lose `#n`), or `null` if it is gone. */
function remapSelectionItem(
  item: SelectionItem,
  evaluation: EvaluationResult,
  featureIds: ReadonlySet<string>,
): SelectionItem | null {
  switch (item.kind) {
    case 'body':
      return evaluation.bodies.some((b) => b.id === item.bodyId) ? item : null;
    case 'face': {
      const body = evaluation.bodies.find((b) => b.id === item.bodyId);
      const face = body ? findFace(body, item.faceKey) : undefined;
      if (!face) return null;
      return face.key === item.faceKey ? item : { ...item, faceKey: face.key };
    }
    case 'edge': {
      const body = evaluation.bodies.find((b) => b.id === item.bodyId);
      const edge = body ? findEdge(body, item.edgeKey) : undefined;
      if (!edge) return null;
      return edge.key === item.edgeKey ? item : { ...item, edgeKey: edge.key };
    }
    case 'sketchProfile':
      return evaluation.sketches.some((s) => s.featureId === item.featureId) ? item : null;
    case 'feature':
      return featureIds.has(item.featureId) ? item : null;
  }
}

/**
 * Seeded from the demo document's own ids so newly created features never
 * collide with the pre-existing document (duplicate ids would corrupt
 * id-keyed lookups and React keys).
 */
let featureIdCounter = highestFeatureIdSuffix(createDemoDocument());

function highestFeatureIdSuffix(features: readonly { id: string }[]): number {
  let max = 0;
  for (const feature of features) {
    const match = /-(\d+)$/.exec(feature.id);
    if (match) max = Math.max(max, Number(match[1]));
  }
  return max;
}

function createFeatureId(kind: string): string {
  featureIdCounter += 1;
  return `feature-${kind}-${featureIdCounter}`;
}

function nextFeatureName(prefix: string, features: readonly Feature[]): string {
  const count = features.filter((f) => f.name.startsWith(`${prefix} `)).length;
  return `${prefix} ${count + 1}`;
}

function buildProvisionalExtrude(tool: {
  profile: ExtrudeProfileRef;
  distance: number;
  operation: ExtrudeOperation;
  targetBodyId?: string;
}): ExtrudeFeature {
  return {
    id: PREVIEW_EXTRUDE_FEATURE_ID,
    name: 'Extrude (preview)',
    suppressed: false,
    kind: 'extrude',
    profile: tool.profile,
    distance: tool.distance,
    symmetric: false,
    operation: tool.operation,
    ...(tool.targetBodyId !== undefined ? { targetBodyId: tool.targetBodyId } : {}),
  };
}

/** For a sketch lying on a body face: join into that body for a positive distance, cut for a negative one. */
function autoOperation(distance: number): ExtrudeOperation {
  return distance < 0 ? 'cut' : 'join';
}

export const useAssemblerStore = create<AssemblerState>((set, get) => {
  /** Undo/redo snapshots of `features`; only `history.canUndo/canRedo` are public. */
  let past: Feature[][] = [];
  let future: Feature[][] = [];

  let kernel: KernelAdapter | null = null;
  let unsubscribeKernel: (() => void) | null = null;
  /** Document revision: bumped on every `features` change. */
  let documentRevision = 0;
  let documentJob: KernelJob | null = null;
  /** Preview revision: bumped on every provisional change, tool end, or document change. */
  let previewRevision = 0;
  let previewJob: KernelJob | null = null;
  /** Completed evaluations by feature-array identity (undo/redo reuse them instantly). */
  let resultCache = new WeakMap<Feature[], EvaluationResult>();
  let settledWaiters: (() => void)[] = [];

  function isSettled(): boolean {
    const state = get();
    const previewBusy = state.activeTool?.kind === 'extrude' && state.activeTool.previewPending;
    return !state.evaluationPending && !previewBusy;
  }

  function notifySettled(): void {
    if (!isSettled()) return;
    const waiters = settledWaiters;
    settledWaiters = [];
    for (const resolve of waiters) resolve();
  }

  function applyEvaluation(evaluation: EvaluationResult): void {
    const state = get();
    const bodyIds = new Set(evaluation.bodies.map((b) => b.id));
    const featureIds = new Set(state.features.map((f) => f.id));
    const selection = state.selection
      .map((item) => remapSelectionItem(item, evaluation, featureIds))
      .filter((item): item is SelectionItem => item !== null);
    const hover = state.hover ? remapSelectionItem(state.hover, evaluation, featureIds) : null;
    set({
      evaluation,
      evaluationPending: false,
      selection,
      hover,
      hiddenBodyIds: state.hiddenBodyIds.filter((id) => bodyIds.has(id)),
      isolatedBodyIds: state.isolatedBodyIds
        ? state.isolatedBodyIds.filter((id) => bodyIds.has(id))
        : null,
    });
    notifySettled();
  }

  /** Requests evaluation of the current `features`. Stale results (older revisions) are dropped. */
  function evaluateDocument(): void {
    documentRevision += 1;
    const revision = documentRevision;
    const features = get().features;
    if (documentJob) {
      kernel?.cancel(documentJob.id);
      documentJob = null;
    }
    const cached = resultCache.get(features);
    if (cached) {
      applyEvaluation(cached);
      return;
    }
    set({ evaluationPending: true });
    if (!kernel) return; // evaluated as soon as a kernel is attached
    const job = kernel.evaluate({ channel: 'document', revision, features });
    documentJob = job;
    void job.outcome.then((outcome) => {
      if (outcome.revision !== documentRevision) return; // stale
      documentJob = null;
      if (outcome.kind === 'done') {
        resultCache.set(features, outcome.result);
        applyEvaluation(outcome.result);
      } else if (outcome.kind === 'failed') {
        set({ evaluationPending: false, kernelMessage: outcome.message });
        notifySettled();
      }
    });
  }

  /** Requests a preview evaluation for the active extrude tool. */
  function evaluatePreview(tool: ExtrudeTool): ExtrudeTool {
    previewRevision += 1;
    const revision = previewRevision;
    if (!kernel) return { ...tool, previewPending: true };
    const features = [...get().features, buildProvisionalExtrude(tool)];
    const job = kernel.evaluate({ channel: 'preview', revision, features });
    previewJob = job;
    void job.outcome.then((outcome) => {
      if (outcome.revision !== previewRevision) return; // stale or tool ended
      previewJob = null;
      const current = get().activeTool;
      if (current?.kind !== 'extrude') return;
      set({
        activeTool: {
          ...current,
          previewPending: false,
          previewEvaluation: outcome.kind === 'done' ? outcome.result : current.previewEvaluation,
        },
      });
      notifySettled();
    });
    return { ...tool, previewPending: true };
  }

  function endPreview(): void {
    previewRevision += 1;
    if (previewJob) {
      kernel?.cancel(previewJob.id);
      previewJob = null;
    }
  }

  function setFeatures(nextFeatures: Feature[], extra: Partial<AssemblerState> = {}): void {
    set({ features: nextFeatures, ...extra });
    evaluateDocument();
    notifySettled();
  }

  function commitFeatures(nextFeatures: Feature[], selectionOverride?: SelectionItem[]): void {
    const state = get();
    past = [...past, state.features];
    future = [];
    endPreview();
    setFeatures(nextFeatures, {
      ...(selectionOverride ? { selection: selectionOverride } : {}),
      history: { canUndo: true, canRedo: false },
      activeTool: null,
    });
  }

  function appendFeature(feature: Feature): void {
    commitFeatures([...get().features, feature], [{ kind: 'feature', featureId: feature.id }]);
  }

  return {
    projectName: 'Bracket',
    setProjectName: (name) => {
      const trimmed = name.trim();
      if (!trimmed) return;
      set({ projectName: trimmed });
    },
    features: createDemoDocument(),
    evaluation: EMPTY_EVALUATION,
    evaluationPending: true,

    kernelStatus: 'loading',
    kernelMessage: 'Loading CAD kernel…',
    kernelProgress: null,
    kernelLoadMs: null,
    attachKernel: (adapter) => {
      unsubscribeKernel?.();
      kernel = adapter;
      resultCache = new WeakMap();
      unsubscribeKernel = adapter.onStatus((status) => {
        const wasReady = get().kernelStatus === 'ready';
        set({
          kernelStatus: status.status,
          kernelMessage: status.message,
          kernelProgress: status.progress,
          kernelLoadMs: status.loadMs,
        });
        if (status.status === 'error') {
          set({ evaluationPending: false });
          notifySettled();
        }
        // A restarted worker (after a hard cancel) lost nothing: re-request the current revision.
        if (status.status === 'ready' && !wasReady && get().evaluationPending && !documentJob) {
          evaluateDocument();
        }
      });
      evaluateDocument();
      const tool = get().activeTool;
      if (tool?.kind === 'extrude') set({ activeTool: evaluatePreview(tool) });
    },
    whenSettled: () =>
      new Promise<void>((resolve) => {
        settledWaiters.push(resolve);
        notifySettled();
      }),

    history: { canUndo: false, canRedo: false },
    undo: () => {
      const state = get();
      if (past.length === 0) return;
      const previousFeatures = past[past.length - 1]!;
      past = past.slice(0, -1);
      future = [...future, state.features];
      setFeatures(previousFeatures, {
        history: { canUndo: past.length > 0, canRedo: future.length > 0 },
      });
    },
    redo: () => {
      const state = get();
      if (future.length === 0) return;
      const nextFeatures = future[future.length - 1]!;
      future = future.slice(0, -1);
      past = [...past, state.features];
      setFeatures(nextFeatures, {
        history: { canUndo: past.length > 0, canRedo: future.length > 0 },
      });
    },

    selection: [],
    hover: null,
    select: (item, options) => {
      const additive = options?.additive ?? false;
      set((s) => {
        if (!additive) return { selection: [item] };
        if (s.selection.some((existing) => selectionKeysEqual(existing, item))) return {};
        return { selection: [...s.selection, item] };
      });
    },
    toggle: (item) =>
      set((s) => {
        const exists = s.selection.some((existing) => selectionKeysEqual(existing, item));
        return {
          selection: exists
            ? s.selection.filter((existing) => !selectionKeysEqual(existing, item))
            : [...s.selection, item],
        };
      }),
    clearSelection: () => set({ selection: [] }),
    setHover: (item) => set({ hover: item }),

    hiddenBodyIds: [],
    isolatedBodyIds: null,
    hideBodies: (bodyIds) =>
      set((s) => ({ hiddenBodyIds: [...new Set([...s.hiddenBodyIds, ...bodyIds])] })),
    showBodies: (bodyIds) =>
      set((s) => ({ hiddenBodyIds: s.hiddenBodyIds.filter((id) => !bodyIds.includes(id)) })),
    showAllBodies: () => set({ hiddenBodyIds: [] }),
    setIsolatedBodyIds: (bodyIds) => set({ isolatedBodyIds: bodyIds }),

    activeTool: null,
    beginSketchRectangle: (origin) => {
      const state = get();
      let plane: SketchPlaneRef = { kind: 'plane', plane: 'XY' as Plane, offset: 0 };
      let frame: SketchFrame = frameForPlane('XY', 0);
      if (origin) {
        const ref = makeFaceRef(state.evaluation, origin.bodyId, origin.faceKey);
        const normal = ref?.signature.normal;
        if (ref && normal && ref.signature.surface === 'plane') {
          plane = { kind: 'face', face: ref };
          frame = frameForFace(normal, ref.signature.centroid);
        }
      }
      endPreview();
      set({
        activeTool: {
          kind: 'sketchRectangle',
          phase: 'collectingReferences',
          plane,
          frame,
          preview: null,
        },
      });
    },
    setPreviewRect: (x, y, width, height) => {
      const tool = get().activeTool;
      if (!tool || tool.kind !== 'sketchRectangle') return;
      set({ activeTool: { ...tool, phase: 'preview', preview: { x, y, width, height } } });
    },
    beginExtrude: (profile) => {
      const state = get();
      let operation: ExtrudeOperation = 'new';
      let targetBodyId: string | undefined;
      if (profile.kind === 'sketch') {
        const sketch = state.features.find(
          (f): f is SketchFeature => f.id === profile.featureId && f.kind === 'sketch',
        );
        if (sketch?.plane.kind === 'face') {
          operation = 'join';
          targetBodyId = sketch.plane.face.bodyId;
        }
      } else {
        operation = 'join';
      }
      const tool: ExtrudeTool = {
        kind: 'extrude',
        phase: 'collectingReferences',
        profile,
        distance: 0,
        operation,
        ...(targetBodyId !== undefined ? { targetBodyId } : {}),
        operationLocked: false,
        previewEvaluation: null,
        previewPending: false,
      };
      endPreview();
      // A zero distance has no geometry to preview; the first drag/entry requests one.
      set({ activeTool: tool });
    },
    setDistance: (distanceMm) => {
      const tool = get().activeTool;
      if (!tool || tool.kind !== 'extrude') return;
      const operation =
        !tool.operationLocked && (tool.targetBodyId !== undefined || tool.profile.kind === 'face')
          ? autoOperation(distanceMm)
          : tool.operation;
      set({
        activeTool: evaluatePreview({ ...tool, phase: 'preview', distance: distanceMm, operation }),
      });
    },
    setExtrudeOperation: (operation) => {
      const tool = get().activeTool;
      if (!tool || tool.kind !== 'extrude') return;
      set({ activeTool: evaluatePreview({ ...tool, operation, operationLocked: true }) });
    },
    beginMove: (bodyId) => {
      endPreview();
      set({
        activeTool: {
          kind: 'move',
          phase: 'collectingReferences',
          bodyId,
          delta: { dx: 0, dy: 0, dz: 0 },
        },
      });
    },
    setDelta: (dx, dy, dz) => {
      const tool = get().activeTool;
      if (!tool || tool.kind !== 'move') return;
      set({ activeTool: { ...tool, phase: 'preview', delta: { dx, dy, dz } } });
    },
    beginNumericEditing: () => {
      const tool = get().activeTool;
      if (!tool) return;
      set({ activeTool: { ...tool, phase: 'numericEditing' } });
    },
    endNumericEditing: () => {
      const tool = get().activeTool;
      if (!tool || tool.phase !== 'numericEditing') return;
      set({ activeTool: { ...tool, phase: 'preview' } });
    },
    commit: () => {
      const state = get();
      const tool = state.activeTool;
      if (!tool) return;

      if (tool.kind === 'sketchRectangle') {
        if (!tool.preview) {
          set({ activeTool: null });
          notifySettled();
          return;
        }
        const id = createFeatureId('sketch');
        const feature: SketchFeature = {
          id,
          name: nextFeatureName('Sketch', state.features),
          suppressed: false,
          kind: 'sketch',
          plane: tool.plane,
          profiles: [{ kind: 'rectangle', ...tool.preview }],
        };
        commitFeatures([...state.features, feature], [{ kind: 'sketchProfile', featureId: id }]);
        return;
      }

      if (tool.kind === 'extrude') {
        const provisional = buildProvisionalExtrude(tool);
        const id = createFeatureId('extrude');
        const feature: ExtrudeFeature = {
          ...provisional,
          id,
          name: nextFeatureName('Extrude', state.features),
        };
        commitFeatures([...state.features, feature]);
        return;
      }

      const id = createFeatureId('move');
      const feature: MoveFeature = {
        id,
        name: nextFeatureName('Move', state.features),
        suppressed: false,
        kind: 'move',
        bodyId: tool.bodyId,
        dx: tool.delta.dx,
        dy: tool.delta.dy,
        dz: tool.delta.dz,
      };
      commitFeatures([...state.features, feature]);
    },
    cancel: () => {
      endPreview();
      set({ activeTool: null });
      notifySettled();
    },

    addEdgeBlend: (kind, size) => {
      const state = get();
      const edges = state.selection
        .filter((item): item is Extract<SelectionItem, { kind: 'edge' }> => item.kind === 'edge')
        .map((item) => makeEdgeRef(state.evaluation, item.bodyId, item.edgeKey))
        .filter((ref): ref is EdgeRef => ref !== null);
      if (edges.length === 0) return;
      const prefix = kind === 'fillet' ? 'Fillet' : 'Chamfer';
      const base = {
        id: createFeatureId(kind),
        name: nextFeatureName(prefix, state.features),
        suppressed: false,
      };
      const feature: FilletFeature | ChamferFeature =
        kind === 'fillet'
          ? { ...base, kind: 'fillet', edges, radius: size }
          : { ...base, kind: 'chamfer', edges, distance: size };
      appendFeature(feature);
    },
    addShell: (thickness) => {
      const state = get();
      const faces = state.selection
        .filter((item): item is Extract<SelectionItem, { kind: 'face' }> => item.kind === 'face')
        .map((item) => makeFaceRef(state.evaluation, item.bodyId, item.faceKey))
        .filter((ref): ref is FaceRef => ref !== null);
      if (faces.length === 0) return;
      const feature: ShellFeature = {
        id: createFeatureId('shell'),
        name: nextFeatureName('Shell', state.features),
        suppressed: false,
        kind: 'shell',
        bodyId: faces[0]!.bodyId,
        faces,
        thickness,
      };
      appendFeature(feature);
    },
    addBoolean: (operation) => {
      const state = get();
      const bodyIds = state.selection
        .filter((item): item is Extract<SelectionItem, { kind: 'body' }> => item.kind === 'body')
        .map((item) => item.bodyId);
      if (bodyIds.length < 2) return;
      const label =
        operation === 'union' ? 'Union' : operation === 'subtract' ? 'Subtract' : 'Intersect';
      const feature: BooleanFeature = {
        id: createFeatureId('boolean'),
        name: nextFeatureName(label, state.features),
        suppressed: false,
        kind: 'boolean',
        operation,
        targetBodyId: bodyIds[0]!,
        toolBodyIds: bodyIds.slice(1),
      };
      appendFeature(feature);
    },

    editFeatureParams: (featureId, patch) => {
      const state = get();
      const next = state.features.map((f) =>
        f.id === featureId ? ({ ...f, ...patch } as Feature) : f,
      );
      commitFeatures(next);
    },
    setSuppressed: (featureId, suppressed) => {
      const state = get();
      commitFeatures(state.features.map((f) => (f.id === featureId ? { ...f, suppressed } : f)));
    },
    renameFeature: (featureId, name) => {
      const state = get();
      commitFeatures(state.features.map((f) => (f.id === featureId ? { ...f, name } : f)));
    },
    deleteFeature: (featureId) => {
      const state = get();
      commitFeatures(state.features.filter((f) => f.id !== featureId));
    },

    viewState: {
      displayMode: 'shaded',
      sectionEnabled: false,
      sectionAxis: 'Z',
      sectionOffset: 0,
      measureEnabled: false,
      gridVisible: true,
      snapToGrid: true,
      gridStep: 5,
      cameraRequest: null,
    },
    setDisplayMode: (mode) => set((s) => ({ viewState: { ...s.viewState, displayMode: mode } })),
    setSectionEnabled: (enabled) =>
      set((s) => ({ viewState: { ...s.viewState, sectionEnabled: enabled } })),
    setSectionAxis: (axis) => set((s) => ({ viewState: { ...s.viewState, sectionAxis: axis } })),
    setSectionOffset: (offset) =>
      set((s) => ({ viewState: { ...s.viewState, sectionOffset: offset } })),
    setMeasureEnabled: (enabled) =>
      set((s) => ({ viewState: { ...s.viewState, measureEnabled: enabled } })),
    setGridVisible: (visible) =>
      set((s) => ({ viewState: { ...s.viewState, gridVisible: visible } })),
    setSnapToGrid: (enabled) =>
      set((s) => ({ viewState: { ...s.viewState, snapToGrid: enabled } })),
    setGridStep: (step) => set((s) => ({ viewState: { ...s.viewState, gridStep: step } })),
    requestCamera: (preset) =>
      set((s) => ({
        viewState: {
          ...s.viewState,
          cameraRequest: { preset, nonce: (s.viewState.cameraRequest?.nonce ?? 0) + 1 },
        },
      })),

    panels: { items: true, history: true },
    togglePanel: (panel) => set((s) => ({ panels: { ...s.panels, [panel]: !s.panels[panel] } })),
    setPanelVisible: (panel, visible) =>
      set((s) => ({ panels: { ...s.panels, [panel]: visible } })),

    recentCommandIds: [],
    pushRecentCommand: (commandId) =>
      set((s) => ({
        recentCommandIds: [commandId, ...s.recentCommandIds.filter((id) => id !== commandId)].slice(
          0,
          8,
        ),
      })),

    loadDocument: (features, options) => {
      past = [];
      future = [];
      endPreview();
      const previous = get();
      set({
        projectName: options?.projectName ?? previous.projectName,
        history: { canUndo: false, canRedo: false },
        activeTool: null,
        selection: [],
        hover: null,
        hiddenBodyIds: [],
        isolatedBodyIds: null,
        evaluation: EMPTY_EVALUATION,
      });
      setFeatures(features);
    },
  };
});

export type { Body, EvaluationResult, ExtrudeProfileRef, Feature, Plane };
