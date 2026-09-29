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
  type ImportStepFeature,
  type MoveFeature,
  type Plane,
  type ShellFeature,
  type SketchFeature,
  type SketchFrame,
  type SketchPlaneRef,
} from './document.js';
import {
  autoExtrudeOperation,
  defaultSectionOffset,
  findSketchContact,
  visibleBounds,
  type SketchContact,
} from './modeling.js';

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

/**
 * Live kernel preview shared by every tool that adds a B-rep feature
 * (extrude, fillet/chamfer, shell, booleans). The store evaluates
 * `features + provisional feature` on the kernel's `preview` channel
 * without touching `features`; at most one preview request is in flight
 * and only the newest parameters are sent next (throttling), and results
 * of an older tool session or older than the one shown are discarded.
 */
export interface KernelPreviewFields {
  /**
   * Kernel evaluation of `features + provisional feature`. `null` until the
   * first valid preview arrives. When the kernel rejects the current
   * parameters this keeps the **last valid** preview (see `previewError`).
   * The provisional feature carries a reserved `__preview_*__` id.
   */
  previewEvaluation: EvaluationResult | null;
  /** `true` while a newer preview than `previewEvaluation` is being computed. */
  previewPending: boolean;
  /** Kernel error for the most recently evaluated parameters, else `null`. Blocks commit once current. */
  previewError: string | null;
}

/** `E` — extrudes a sketch profile or pushes/pulls a planar body face. */
export interface ExtrudeTool extends ToolSessionBase, KernelPreviewFields {
  kind: 'extrude';
  profile: ExtrudeProfileRef;
  distance: number;
  operation: ExtrudeOperation;
  targetBodyId?: string;
  /** `true` once the user picked the operation explicitly (disables the automatic choice). */
  operationLocked: boolean;
  /** Body face the sketch lies on (drives the automatic New/Join/Cut choice), else `null`. */
  contact: SketchContact | null;
}

/** `F` — fillets or chamfers the selected edges of one body. */
export interface EdgeBlendTool extends ToolSessionBase, KernelPreviewFields {
  kind: 'edgeBlend';
  blend: 'fillet' | 'chamfer';
  bodyId: string;
  edges: EdgeRef[];
  /** Fillet radius or chamfer distance, mm. */
  size: number;
}

/** `H` — hollows a body, opening the selected faces, walls grow inwards. */
export interface ShellTool extends ToolSessionBase, KernelPreviewFields {
  kind: 'shell';
  bodyId: string;
  faces: FaceRef[];
  thickness: number;
}

/** Union/Subtract/Intersect of the selected bodies; the first selected body is the target. */
export interface BooleanTool extends ToolSessionBase, KernelPreviewFields {
  kind: 'boolean';
  operation: BooleanFeature['operation'];
  targetBodyId: string;
  toolBodyIds: string[];
}

/** `C` — centre click + radius click on a plane or a planar body face. */
export interface SketchCircleTool extends ToolSessionBase {
  kind: 'sketchCircle';
  plane: SketchPlaneRef;
  frame: SketchFrame;
  /** Centre in sketch (u, v) coordinates once placed. */
  center: { u: number; v: number } | null;
  /** Radius once the cursor moved away from the centre (or typed). */
  radius: number | null;
  /** Which value the dimension chip shows and edits. */
  dimension: 'radius' | 'diameter';
}

/** `M` — translates a single body. */
export interface MoveTool extends ToolSessionBase {
  kind: 'move';
  bodyId: string;
  delta: { dx: number; dy: number; dz: number };
}

export type ToolSession =
  | SketchRectangleTool
  | SketchCircleTool
  | ExtrudeTool
  | MoveTool
  | EdgeBlendTool
  | ShellTool
  | BooleanTool;

/** Tools that show a live kernel preview. */
export type PreviewTool = ExtrudeTool | EdgeBlendTool | ShellTool | BooleanTool;

export function isPreviewTool(tool: ToolSession | null): tool is PreviewTool {
  return (
    tool?.kind === 'extrude' ||
    tool?.kind === 'edgeBlend' ||
    tool?.kind === 'shell' ||
    tool?.kind === 'boolean'
  );
}

/** Reserved feature id used only for the extrude tool's live preview; never committed. */
export const PREVIEW_EXTRUDE_FEATURE_ID = '__preview_extrude__';
/** Reserved feature id of the fillet/chamfer, shell and boolean tools' live previews; never committed. */
export const PREVIEW_FEATURE_ID = '__preview_feature__';

/** Default fillet radius / chamfer distance and shell thickness when a tool starts, mm. */
export const DEFAULT_BLEND_SIZE_MM = 1;
export const DEFAULT_SHELL_THICKNESS_MM = 1;

export type DisplayMode = 'shaded' | 'wireframe' | 'xray';
export type SectionAxis = 'X' | 'Y' | 'Z';
export type CameraPreset = 'iso' | 'front' | 'back' | 'top' | 'bottom' | 'left' | 'right' | 'fit';

export interface ViewState {
  displayMode: DisplayMode;
  sectionEnabled: boolean;
  sectionAxis: SectionAxis;
  /** Plane position along `sectionAxis`, world mm. Reset to the model's centre on enable/axis change. */
  sectionOffset: number;
  /** `false` keeps the material below the plane (`axis < offset`), `true` the material above it. */
  sectionFlipped: boolean;
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
  /** `C` — starts the circle tool on the XY plane or on a planar body face. */
  beginSketchCircle: (origin?: { bodyId: string; faceKey: string }) => void;
  /**
   * Moves the active sketch tool (rectangle or circle) onto a planar body
   * face — the first click on a face picks the sketch plane, like Shapr3D.
   * Only before the first point is placed; returns `false` if not applicable.
   */
  setSketchPlaneFace: (bodyId: string, faceKey: string) => boolean;
  setCircleCenter: (u: number, v: number) => void;
  /** Sets the circle radius (mm); a non-positive value clears it. */
  setCircleRadius: (radius: number) => void;
  setCircleDimension: (dimension: 'radius' | 'diameter') => void;
  /** Clears a placed centre (first Escape of the circle tool). `false` if there was none. */
  resetSketchCircle: () => boolean;
  /** `F` — starts the fillet/chamfer tool on the selected edges of one body (live preview). */
  beginEdgeBlend: (kind: 'fillet' | 'chamfer') => void;
  setBlendSize: (size: number) => void;
  setBlendKind: (kind: 'fillet' | 'chamfer') => void;
  /** Adds/removes an edge of the tool's body while the fillet/chamfer tool runs. */
  toggleBlendEdge: (bodyId: string, edgeKey: string) => void;
  /** `H` — starts the shell tool on the selected faces of one body (live preview). */
  beginShell: () => void;
  setShellThickness: (thickness: number) => void;
  /** Starts a Union/Subtract/Intersect preview of the selected bodies (first selected = target). */
  beginBoolean: (operation: BooleanFeature['operation']) => void;
  setBooleanOperation: (operation: BooleanFeature['operation']) => void;
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
  /**
   * Appends one "Import" history step producing a body from an already-read
   * STEP file (base64 `data`), as one undo step; selects the new feature.
   * Used by the File > Import > STEP flow (`model/project/`).
   */
  addImportedBody: (input: { data: string; fileName: string }) => void;

  editFeatureParams: (featureId: string, patch: FeaturePatch) => void;
  setSuppressed: (featureId: string, suppressed: boolean) => void;
  renameFeature: (featureId: string, name: string) => void;
  deleteFeature: (featureId: string) => void;

  viewState: ViewState;
  setDisplayMode: (mode: DisplayMode) => void;
  setSectionEnabled: (enabled: boolean) => void;
  setSectionAxis: (axis: SectionAxis) => void;
  setSectionOffset: (offset: number) => void;
  setSectionFlipped: (flipped: boolean) => void;
  setMeasureEnabled: (enabled: boolean) => void;
  /**
   * Explicit per-sketch viewport visibility (not undo-tracked). Sketches
   * without an entry are shown until an extrude consumes them.
   */
  sketchVisibility: Record<string, boolean>;
  setSketchVisible: (featureId: string, visible: boolean) => void;
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

  /**
   * Commits a complete next feature list as exactly one undo step, through
   * the same path every UI tool's Done uses (`commitFeatures`). Used by the
   * canonical agent command layer (`api/`) for created features and for
   * multi-command transactions. `evaluation`, when given, must be the kernel
   * result of exactly `nextFeatures` (seeds the result cache so the commit
   * does not re-evaluate). Rejected (returns `false`) while a UI tool is active.
   */
  commitDocumentChange: (
    nextFeatures: Feature[],
    options?: { selection?: SelectionItem[]; evaluation?: EvaluationResult },
  ) => boolean;
  /** A fresh feature id (`feature-<kind>-<n>`) from the same counter the UI tools use, unique in `features`. */
  allocateFeatureId: (kind: string, reserved?: ReadonlySet<string>) => string;
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

/** Provisional feature of a preview tool, or `null` when its parameters have no geometry yet. */
function buildProvisional(tool: PreviewTool): Feature | null {
  const base = { id: PREVIEW_FEATURE_ID, suppressed: false };
  switch (tool.kind) {
    case 'extrude':
      return tool.distance === 0 ? null : buildProvisionalExtrude(tool);
    case 'edgeBlend':
      return tool.blend === 'fillet'
        ? {
            ...base,
            name: 'Fillet (preview)',
            kind: 'fillet',
            edges: tool.edges,
            radius: tool.size,
          }
        : {
            ...base,
            name: 'Chamfer (preview)',
            kind: 'chamfer',
            edges: tool.edges,
            distance: tool.size,
          };
    case 'shell':
      return {
        ...base,
        name: 'Shell (preview)',
        kind: 'shell',
        bodyId: tool.bodyId,
        faces: tool.faces,
        thickness: tool.thickness,
      };
    case 'boolean':
      return {
        ...base,
        name: 'Boolean (preview)',
        kind: 'boolean',
        operation: tool.operation,
        targetBodyId: tool.targetBodyId,
        toolBodyIds: tool.toolBodyIds,
      };
  }
}

const BOOLEAN_LABEL: Record<BooleanFeature['operation'], string> = {
  union: 'Union',
  subtract: 'Subtract',
  intersect: 'Intersect',
};

const NO_PREVIEW: KernelPreviewFields = {
  previewEvaluation: null,
  previewPending: false,
  previewError: null,
};

export const useAssemblerStore = create<AssemblerState>((set, get) => {
  /** Undo/redo snapshots of `features`; only `history.canUndo/canRedo` are public. */
  let past: Feature[][] = [];
  let future: Feature[][] = [];

  let kernel: KernelAdapter | null = null;
  let unsubscribeKernel: (() => void) | null = null;
  /** Document revision: bumped on every `features` change. */
  let documentRevision = 0;
  let documentJob: KernelJob | null = null;
  /** Preview revision: bumped on every provisional change and tool start/end. */
  let previewRevision = 0;
  let previewJob: KernelJob | null = null;
  /** Tool session: bumped on every tool start/end; results of other sessions are dropped. */
  let toolSession = 0;
  /** Revision of the preview currently shown (results older than this are dropped). */
  let shownPreviewRevision = 0;
  /** Completed evaluations by feature-array identity (undo/redo reuse them instantly). */
  let resultCache = new WeakMap<Feature[], EvaluationResult>();
  let settledWaiters: (() => void)[] = [];

  function isSettled(): boolean {
    const state = get();
    const previewBusy = isPreviewTool(state.activeTool) && state.activeTool.previewPending;
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

  /**
   * Marks the tool's preview stale and requests a kernel evaluation of the
   * new parameters. Throttled: while one preview is in flight nothing else
   * is posted; when it returns, the newest parameters are sent (so a drag
   * produces a steady stream of previews at kernel speed, never a queue).
   * Returns the tool with `previewPending` set; the caller stores it.
   */
  function evaluatePreview<T extends PreviewTool>(tool: T): T {
    previewRevision += 1;
    if (!buildProvisional(tool)) {
      // Nothing to preview (e.g. zero distance): show the committed model.
      shownPreviewRevision = previewRevision;
      return { ...tool, previewEvaluation: null, previewPending: false, previewError: null };
    }
    if (kernel && !previewJob) queueMicrotask(startPreviewJob);
    return { ...tool, previewPending: true };
  }

  function startPreviewJob(): void {
    if (!kernel || previewJob) return;
    const tool = get().activeTool;
    if (!isPreviewTool(tool) || !tool.previewPending) return;
    const provisional = buildProvisional(tool);
    if (!provisional) return;
    const revision = previewRevision;
    const session = toolSession;
    const job = kernel.evaluate({
      channel: 'preview',
      revision,
      features: [...get().features, provisional],
    });
    previewJob = job;
    void job.outcome.then((outcome) => {
      if (previewJob === job) previewJob = null;
      if (session !== toolSession) return; // the tool ended; nothing to show
      const current = get().activeTool;
      if (!isPreviewTool(current)) return;
      if (outcome.kind === 'done' && revision > shownPreviewRevision) {
        shownPreviewRevision = revision;
        const error = outcome.result.errors[provisional.id] ?? null;
        const latest = revision === previewRevision;
        set({
          activeTool: {
            ...current,
            // An invalid parameter keeps the last valid preview on screen.
            previewEvaluation: error ? current.previewEvaluation : outcome.result,
            previewError: error,
            previewPending: !latest,
          },
        });
      } else if (outcome.kind === 'failed' && revision === previewRevision) {
        set({ activeTool: { ...current, previewPending: false, previewError: outcome.message } });
      }
      // Newer parameters arrived while this one was computing: send them now.
      if (revision !== previewRevision) startPreviewJob();
      notifySettled();
    });
  }

  function endPreview(): void {
    previewRevision += 1;
    toolSession += 1;
    shownPreviewRevision = previewRevision;
    if (previewJob) {
      kernel?.cancel(previewJob.id);
      previewJob = null;
    }
  }

  /** Stores an updated preview tool and requests its preview. */
  function updatePreviewTool(tool: PreviewTool): void {
    set({ activeTool: evaluatePreview(tool) });
    notifySettled();
  }

  function selectedEdgeRefs(): EdgeRef[] {
    const state = get();
    return state.selection
      .filter((item): item is Extract<SelectionItem, { kind: 'edge' }> => item.kind === 'edge')
      .map((item) => makeEdgeRef(state.evaluation, item.bodyId, item.edgeKey))
      .filter((ref): ref is EdgeRef => ref !== null);
  }

  function selectedFaceRefs(): FaceRef[] {
    const state = get();
    return state.selection
      .filter((item): item is Extract<SelectionItem, { kind: 'face' }> => item.kind === 'face')
      .map((item) => makeFaceRef(state.evaluation, item.bodyId, item.faceKey))
      .filter((ref): ref is FaceRef => ref !== null);
  }

  function selectedBodyIds(): string[] {
    return get()
      .selection.filter(
        (item): item is Extract<SelectionItem, { kind: 'body' }> => item.kind === 'body',
      )
      .map((item) => item.bodyId);
  }

  /** Frame of a planar body face, or `null` if it is not planar. */
  function facePlane(
    bodyId: string,
    faceKey: string,
  ): { plane: SketchPlaneRef; frame: SketchFrame } | null {
    const ref = makeFaceRef(get().evaluation, bodyId, faceKey);
    const normal = ref?.signature.normal;
    if (!ref || !normal || ref.signature.surface !== 'plane') return null;
    return {
      plane: { kind: 'face', face: ref },
      frame: frameForFace(normal, ref.signature.centroid),
    };
  }

  function sectionOffsetFor(axis: SectionAxis): number {
    const state = get();
    return defaultSectionOffset(
      visibleBounds(state.evaluation.bodies, state.hiddenBodyIds, state.isolatedBodyIds),
      axis,
    );
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
      if (isPreviewTool(tool)) updatePreviewTool(tool);
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
      let contact: SketchContact | null = null;
      if (profile.kind === 'sketch') {
        contact = findSketchContact(state.evaluation, profile.featureId, profile.profileIndex);
        if (!contact && !state.evaluation.sketches.some((s) => s.featureId === profile.featureId)) {
          // Not evaluated yet (just drawn): trust the sketch's own face reference.
          const sketch = state.features.find(
            (f): f is SketchFeature => f.id === profile.featureId && f.kind === 'sketch',
          );
          if (sketch?.plane.kind === 'face') {
            contact = { bodyId: sketch.plane.face.bodyId, faceKey: sketch.plane.face.key, sign: 1 };
          }
        }
      } else {
        contact = { bodyId: profile.face.bodyId, faceKey: profile.face.key, sign: 1 };
      }
      const tool: ExtrudeTool = {
        kind: 'extrude',
        phase: 'collectingReferences',
        profile,
        distance: 0,
        operation: autoExtrudeOperation(contact, 0),
        ...(contact ? { targetBodyId: contact.bodyId } : {}),
        operationLocked: false,
        contact,
        ...NO_PREVIEW,
      };
      endPreview();
      // A zero distance has no geometry to preview; the first drag/entry requests one.
      set({ activeTool: tool });
    },
    setDistance: (distanceMm) => {
      const tool = get().activeTool;
      if (!tool || tool.kind !== 'extrude') return;
      const operation =
        tool.operationLocked || tool.profile.kind === 'face'
          ? tool.profile.kind === 'face'
            ? distanceMm < 0
              ? 'cut'
              : 'join'
            : tool.operation
          : autoExtrudeOperation(tool.contact, distanceMm);
      updatePreviewTool({ ...tool, phase: 'preview', distance: distanceMm, operation });
    },
    setExtrudeOperation: (operation) => {
      const tool = get().activeTool;
      if (!tool || tool.kind !== 'extrude' || tool.profile.kind === 'face') return;
      // Join/Cut need a target: the touched body, else the most recently changed one.
      const targetBodyId = tool.contact?.bodyId ?? tool.targetBodyId;
      const next: ExtrudeTool = { ...tool, operation, operationLocked: true };
      if (operation === 'new') delete next.targetBodyId;
      else if (targetBodyId !== undefined) next.targetBodyId = targetBodyId;
      updatePreviewTool(next);
    },

    beginSketchCircle: (origin) => {
      const placed = origin ? facePlane(origin.bodyId, origin.faceKey) : null;
      endPreview();
      set({
        activeTool: {
          kind: 'sketchCircle',
          phase: 'collectingReferences',
          plane: placed?.plane ?? { kind: 'plane', plane: 'XY', offset: 0 },
          frame: placed?.frame ?? frameForPlane('XY', 0),
          center: null,
          radius: null,
          dimension: 'diameter',
        },
      });
    },
    setSketchPlaneFace: (bodyId, faceKey) => {
      const tool = get().activeTool;
      if (tool?.kind === 'sketchCircle' && tool.center) return false;
      if (tool?.kind === 'sketchRectangle' && tool.preview) return false;
      if (tool?.kind !== 'sketchCircle' && tool?.kind !== 'sketchRectangle') return false;
      const placed = facePlane(bodyId, faceKey);
      if (!placed) return false;
      set({ activeTool: { ...tool, plane: placed.plane, frame: placed.frame } });
      return true;
    },
    setCircleCenter: (u, v) => {
      const tool = get().activeTool;
      if (tool?.kind !== 'sketchCircle') return;
      set({ activeTool: { ...tool, phase: 'preview', center: { u, v }, radius: null } });
    },
    setCircleRadius: (radius) => {
      const tool = get().activeTool;
      if (tool?.kind !== 'sketchCircle' || !tool.center) return;
      set({ activeTool: { ...tool, radius: radius > 0 ? radius : null } });
    },
    setCircleDimension: (dimension) => {
      const tool = get().activeTool;
      if (tool?.kind !== 'sketchCircle') return;
      set({ activeTool: { ...tool, dimension } });
    },
    resetSketchCircle: () => {
      const tool = get().activeTool;
      if (tool?.kind !== 'sketchCircle' || !tool.center) return false;
      set({ activeTool: { ...tool, phase: 'collectingReferences', center: null, radius: null } });
      return true;
    },

    beginEdgeBlend: (kind) => {
      const edges = selectedEdgeRefs();
      if (edges.length === 0) return;
      const bodyId = edges[0]!.bodyId;
      endPreview();
      updatePreviewTool({
        kind: 'edgeBlend',
        phase: 'preview',
        blend: kind,
        bodyId,
        edges: edges.filter((e) => e.bodyId === bodyId),
        size: DEFAULT_BLEND_SIZE_MM,
        ...NO_PREVIEW,
      });
    },
    setBlendSize: (size) => {
      const tool = get().activeTool;
      if (tool?.kind !== 'edgeBlend' || !Number.isFinite(size)) return;
      updatePreviewTool({ ...tool, size });
    },
    setBlendKind: (kind) => {
      const tool = get().activeTool;
      if (tool?.kind !== 'edgeBlend' || tool.blend === kind) return;
      updatePreviewTool({ ...tool, blend: kind });
    },
    toggleBlendEdge: (bodyId, edgeKey) => {
      const tool = get().activeTool;
      if (tool?.kind !== 'edgeBlend' || bodyId !== tool.bodyId) return;
      const present = tool.edges.some((e) => e.key === edgeKey);
      if (present) {
        if (tool.edges.length === 1) return; // keep at least one edge
        updatePreviewTool({ ...tool, edges: tool.edges.filter((e) => e.key !== edgeKey) });
        return;
      }
      const ref = makeEdgeRef(get().evaluation, bodyId, edgeKey);
      if (ref) updatePreviewTool({ ...tool, edges: [...tool.edges, ref] });
    },

    beginShell: () => {
      const faces = selectedFaceRefs();
      if (faces.length === 0) return;
      const bodyId = faces[0]!.bodyId;
      endPreview();
      updatePreviewTool({
        kind: 'shell',
        phase: 'preview',
        bodyId,
        faces: faces.filter((f) => f.bodyId === bodyId),
        thickness: DEFAULT_SHELL_THICKNESS_MM,
        ...NO_PREVIEW,
      });
    },
    setShellThickness: (thickness) => {
      const tool = get().activeTool;
      if (tool?.kind !== 'shell' || !Number.isFinite(thickness)) return;
      updatePreviewTool({ ...tool, thickness });
    },

    beginBoolean: (operation) => {
      const bodyIds = selectedBodyIds();
      if (bodyIds.length < 2) return;
      endPreview();
      updatePreviewTool({
        kind: 'boolean',
        phase: 'preview',
        operation,
        targetBodyId: bodyIds[0]!,
        toolBodyIds: bodyIds.slice(1),
        ...NO_PREVIEW,
      });
    },
    setBooleanOperation: (operation) => {
      const tool = get().activeTool;
      if (tool?.kind !== 'boolean' || tool.operation === operation) return;
      updatePreviewTool({ ...tool, operation });
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

      if (tool.kind === 'sketchCircle') {
        if (!tool.center || tool.radius === null) {
          endPreview();
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
          profiles: [{ kind: 'circle', cx: tool.center.u, cy: tool.center.v, radius: tool.radius }],
        };
        commitFeatures([...state.features, feature], [{ kind: 'sketchProfile', featureId: id }]);
        return;
      }

      // A kernel error for the current parameters blocks Done (the tool stays open).
      if (isPreviewTool(tool) && tool.previewError !== null && !tool.previewPending) return;

      if (tool.kind === 'extrude') {
        const provisional = buildProvisionalExtrude(tool);
        const id = createFeatureId('extrude');
        const feature: ExtrudeFeature = {
          ...provisional,
          id,
          name: nextFeatureName('Extrude', state.features),
        };
        // The consumed profile is deselected (and so hidden again), like Shapr3D.
        commitFeatures([...state.features, feature], []);
        return;
      }

      if (tool.kind === 'edgeBlend' || tool.kind === 'shell' || tool.kind === 'boolean') {
        const provisional = buildProvisional(tool)!;
        const prefix =
          tool.kind === 'edgeBlend'
            ? tool.blend === 'fillet'
              ? 'Fillet'
              : 'Chamfer'
            : tool.kind === 'shell'
              ? 'Shell'
              : BOOLEAN_LABEL[tool.operation];
        const feature = {
          ...provisional,
          id: createFeatureId(provisional.kind),
          name: nextFeatureName(prefix, state.features),
        } as Feature;
        appendFeature(feature);
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
      const feature: BooleanFeature = {
        id: createFeatureId('boolean'),
        name: nextFeatureName(BOOLEAN_LABEL[operation], state.features),
        suppressed: false,
        kind: 'boolean',
        operation,
        targetBodyId: bodyIds[0]!,
        toolBodyIds: bodyIds.slice(1),
      };
      appendFeature(feature);
    },
    addImportedBody: (input) => {
      const state = get();
      const feature: ImportStepFeature = {
        id: createFeatureId('import'),
        name: nextFeatureName('Import', state.features),
        suppressed: false,
        kind: 'importStep',
        data: input.data,
        fileName: input.fileName,
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
      sectionFlipped: false,
      measureEnabled: false,
      gridVisible: true,
      snapToGrid: true,
      gridStep: 5,
      cameraRequest: null,
    },
    setDisplayMode: (mode) => set((s) => ({ viewState: { ...s.viewState, displayMode: mode } })),
    setSectionEnabled: (enabled) =>
      set((s) => ({
        viewState: {
          ...s.viewState,
          sectionEnabled: enabled,
          // Turning the section on starts at the centre of the visible model.
          ...(enabled && !s.viewState.sectionEnabled
            ? { sectionOffset: sectionOffsetFor(s.viewState.sectionAxis) }
            : {}),
        },
      })),
    setSectionAxis: (axis) =>
      set((s) => ({
        viewState: {
          ...s.viewState,
          sectionAxis: axis,
          ...(axis !== s.viewState.sectionAxis ? { sectionOffset: sectionOffsetFor(axis) } : {}),
        },
      })),
    setSectionOffset: (offset) =>
      set((s) => ({ viewState: { ...s.viewState, sectionOffset: offset } })),
    setSectionFlipped: (flipped) =>
      set((s) => ({ viewState: { ...s.viewState, sectionFlipped: flipped } })),
    sketchVisibility: {},
    setSketchVisible: (featureId, visible) =>
      set((s) => ({ sketchVisibility: { ...s.sketchVisibility, [featureId]: visible } })),
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
        sketchVisibility: {},
        evaluation: EMPTY_EVALUATION,
      });
      setFeatures(features);
    },

    commitDocumentChange: (nextFeatures, options) => {
      if (get().activeTool !== null) return false;
      if (options?.evaluation) resultCache.set(nextFeatures, options.evaluation);
      commitFeatures(nextFeatures, options?.selection);
      return true;
    },
    allocateFeatureId: (kind, reserved) => {
      const taken = new Set(get().features.map((f) => f.id));
      let id = createFeatureId(kind);
      while (taken.has(id) || reserved?.has(id)) id = createFeatureId(kind);
      return id;
    },
  };
});

export type { Body, EvaluationResult, ExtrudeProfileRef, Feature, Plane };
