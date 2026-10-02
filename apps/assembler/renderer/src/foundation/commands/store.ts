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
 *   with `cancel()` valid from any uncommitted state): the live kernel
 *   preview, Done (kernel-checked for boolean results) and Cancel every tool
 *   shares. The core runs the generic feature tool (drafts registered per
 *   kind, `featureDrafts.ts`) and the pick session; the modules add their
 *   own sessions (`ToolSessionMap`, {@link registerToolKind}) and actions
 *   (store slices, e.g. Extrude and Move/Rotate in `modules/modeling/tools.ts`).
 *
 * Built on zustand. Usable as a React hook (`useAssemblerStore()`) and
 * imperatively (`useAssemblerStore.getState()`), which is how
 * `commands/registry.ts` and the tests drive it.
 */
import { create } from 'zustand';

import type { KernelActivity, KernelAdapter, KernelJob } from '../geometry-kernel/adapter.js';
import {
  baseEdgeKey,
  baseFaceKey,
  edgeSignatureOf,
  faceSignatureOf,
} from '../geometry-kernel/naming.js';
import type { ProjectViewState } from '../document/format.js';
import type { ReferenceMesh, ReferenceMeshTransform } from './referenceMesh.js';
import {
  EMPTY_EVALUATION,
  type Body,
  type EvaluationOutcome,
  type EvaluationResult,
  type FeatureErrorRefs,
  type KernelStatus,
} from '../geometry-kernel/types.js';
import {
  isBooleanResult,
  type EdgeRef,
  type ExtrudeProfileRef,
  type FaceRef,
  type Feature,
  type ImportStepFeature,
  type Plane,
  type Vec3,
} from '../document/document.js';
import { createDemoDocument } from './demoDocument.js';
import { featureKindLabel } from '../document/featureKinds.js';

import { draftNamePrefix, draftToFeature, type FeatureDraft } from './featureDrafts.js';
import { readyToFinish, startSession, type PickSessionState } from './pickSession.js';

import { defaultSectionOffset, visibleBounds } from './viewBounds.js';
import {
  expressionFieldsOf,
  resolveFieldExpression,
  resolveParameterValues,
  type Parameter,
} from '../document/parameters.js';
import { setParameterValuesProvider } from '../sketch-solver/solverProvider.js';
import type { StoredCheck } from '../document/checks.js';

/** One selectable/hoverable thing in the viewport or a panel. */
export type SelectionItem =
  | { kind: 'body'; bodyId: string }
  | { kind: 'face'; bodyId: string; faceKey: string }
  | { kind: 'edge'; bodyId: string; edgeKey: string }
  /** A sketch's profiles: one region (`regionKey`) or, without it, every region. */
  | { kind: 'sketchProfile'; featureId: string; regionKey?: string }
  | { kind: 'feature'; featureId: string }
  /** A reference mesh (imported STL) — always selected as a whole, never per-triangle/per-face. */
  | { kind: 'mesh'; meshId: string }
  /** A construction plane or axis (`model/construction.ts`), by its feature id. */
  | { kind: 'datum'; featureId: string }
  /** One curve (line, arc, circle, spline, …) of a sketch, outside sketch mode (SEL-12). */
  | { kind: 'sketchCurve'; featureId: string; entityId: string };

/** Explicit lifecycle every tool session moves through. `cancel()` is valid from any of these except after commit. */
export type ToolPhase = 'collectingReferences' | 'preview' | 'numericEditing' | 'committing';

export interface ToolSessionBase {
  phase: ToolPhase;
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
  /** Geometry the preview error points at (e.g. the edge a fillet fails on), highlighted in the viewport. */
  previewErrorRefs?: FeatureErrorRefs | null;
}

/**
 * The generic feature tool (Revolve, Hole, Offset Face, construction
 * planes, …): one session whose references/parameters are a
 * {@link FeatureDraft} of a kind a module registered
 * (`featureDrafts.ts`), previewed like the other kernel tools.
 */
export interface FeatureTool extends ToolSessionBase, KernelPreviewFields {
  kind: 'feature';
  draft: FeatureDraft;
}

/**
 * Tool before selection (`pickSession.ts`): a command started without its
 * references asks for them step by step; when they are complete the
 * command starts as if they had been selected first (`pickSessionRunner.ts`).
 */
export interface PickTool extends ToolSessionBase, PickSessionState {
  kind: 'pick';
}

/**
 * Tool sessions by kind: the core's generic feature tool and pick session;
 * every module that owns a tool (Extrude, Move/Rotate, …) adds its session
 * type with a module augmentation and registers its behaviour with
 * {@link registerToolKind}:
 * `declare module '…/store.js' { interface ToolSessionMap { extrude: ExtrudeTool } }`.
 */
export interface ToolSessionMap {
  feature: FeatureTool;
  pick: PickTool;
}

/**
 * Tool sessions of the 3D modelling context. Sketching (Line, Arc, Circle,
 * Rectangle, …) happens in a sketch session instead (`sketch/session.ts`).
 */
export type ToolSession = ToolSessionMap[keyof ToolSessionMap];

/** Finishes a pick session (set by `pickSessionRunner.ts`: starts the command). */
let pickFinisher: (() => void) | null = null;
export function setPickFinisher(finish: (() => void) | null): void {
  pickFinisher = finish;
}

/** Tools that show a live kernel preview. */
export type PreviewTool = Extract<ToolSession, KernelPreviewFields>;

/** What a tool's Done can do (handed to {@link ToolKindDefinition.commit}). */
export interface ToolCommit {
  /** The document the tool edits. */
  features: readonly Feature[];
  /**
   * Appends `feature` as one undo step (a boolean result is kernel-checked
   * first and refused with the tool left open); `selection` replaces the
   * selection (default: kept).
   */
  commitFeature(feature: Feature, selection?: SelectionItem[]): void;
  /** Commits a complete next feature list as one undo step. */
  commitFeatures(next: Feature[], selection?: SelectionItem[]): void;
  /** Keeps the tool open with an updated session (e.g. the reason Done cannot apply). */
  update(tool: ToolSession): void;
}

/** A module's tool kind: what its session previews and commits. */
export interface ToolKindDefinition<K extends keyof ToolSessionMap = keyof ToolSessionMap> {
  kind: K;
  /** Owning module id (`apps/assembler/modules.json`), for diagnostics. */
  module: string;
  /**
   * Preview tools only (their session has {@link KernelPreviewFields}): the
   * provisional feature of the current parameters, `null` while there is
   * nothing to preview. It carries a reserved `__preview_*__` id.
   */
  provisional?(tool: ToolSessionMap[K]): Feature | null;
  /** Done: commit through `done`, or return and leave the tool open. */
  commit(tool: ToolSessionMap[K], done: ToolCommit): void;
  /** Whether a click on empty space finishes the tool (Shapr3D adaptive tools, `toolFinish.ts`). */
  emptyClickFinishes?: boolean;
}

const toolKinds = new Map<string, ToolKindDefinition>();

/** Registers a module's tool kind (once per kind; a second registration throws). */
export function registerToolKind<K extends keyof ToolSessionMap>(
  definition: ToolKindDefinition<K>,
): void {
  const existing = toolKinds.get(definition.kind);
  if (existing) {
    if (existing === (definition as unknown as ToolKindDefinition)) return;
    throw new Error(
      `Tool "${definition.kind}" is registered twice (${existing.module}, ${definition.module})`,
    );
  }
  toolKinds.set(definition.kind, definition as unknown as ToolKindDefinition);
}

/** The registered definition of a tool kind (not the core's `feature`/`pick`), or `undefined`. */
export function toolKindDefinition(kind: string): ToolKindDefinition | undefined {
  return toolKinds.get(kind);
}

export function isPreviewTool(tool: ToolSession | null): tool is PreviewTool {
  if (!tool) return false;
  return tool.kind === 'feature' || toolKinds.get(tool.kind)?.provisional !== undefined;
}

/** Reserved feature id of the tools' live previews; never committed. */
export const PREVIEW_FEATURE_ID = '__preview_feature__';

/** Viewport display mode (`viewport/displayModes.ts`); view state, never a geometry edit. */
export type DisplayMode = 'shaded' | 'wireframe' | 'xray' | 'visualized' | 'zebra' | 'curvature';
export type SectionAxis = 'X' | 'Y' | 'Z';
/**
 * A face-aligned section plane (picked from a planar face): replaces the
 * X/Y/Z axis while set; `sectionOffset` is then measured from `origin`
 * along `normal`.
 */
export interface SectionPlane {
  normal: Vec3;
  origin: Vec3;
  /** What it was taken from, for the Section controls ("Top face of Body 1"). */
  label: string;
}
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
  /** Locked grid resolution, mm (used while `gridAuto` is off). */
  gridStep: number;
  /** The grid follows the zoom (Shapr3D default); off = locked at `gridStep` (`model/gridResolution.ts`). */
  gridAuto: boolean;
  /** Bumping `nonce` is the signal to (re-)apply `preset`. */
  cameraRequest: { preset: CameraPreset; nonce: number } | null;
  /** B-rep edge lines on shaded bodies ("Shaded with edges"). */
  edgesVisible: boolean;
  /** Edges hidden behind geometry, dashed. */
  hiddenEdgesVisible: boolean;
  /** World axes through the origin. */
  axesVisible: boolean;
  /** Face-aligned section plane, or `null` for the X/Y/Z axis. */
  sectionPlane: SectionPlane | null;
  /** 2D "section only": just the cut regions and their outlines. */
  sectionOnly: boolean;
  /** Surface opacity of the X-Ray display mode, 0.05..0.95 (Shapr3D 26.90 "adjustable opacity"). */
  xrayOpacity: number;
  /** World plane the grid lies in (Shapr3D grid planes XY/YZ/ZX). */
  gridPlane: GridPlane;
}

/** World plane of the viewport grid. */
export type GridPlane = 'XY' | 'XZ' | 'YZ';

export function isGridPlane(value: unknown): value is GridPlane {
  return value === 'XY' || value === 'XZ' || value === 'YZ';
}

/** Default X-Ray surface opacity (the value the mode always had). */
export const DEFAULT_XRAY_OPACITY = 0.32;

/** An X-Ray opacity within the allowed range (`null` for a non-number). */
export function clampXrayOpacity(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  return Math.min(0.95, Math.max(0.05, value));
}

export interface PanelsState {
  items: boolean;
  history: boolean;
  /** Parameters ("variables") panel; hidden by default (Ctrl+Alt+P, command search, right dock). */
  parameters: boolean;
}

/**
 * Patch for {@link AssemblerState.editFeatureParams}. Callers pass a patch
 * shape that matches the feature they edit; never include `id` or `kind`.
 */
export type FeaturePatch = {
  [K in Feature['kind']]: Partial<Omit<Extract<Feature, { kind: K }>, 'id' | 'kind'>>;
}[Feature['kind']];

/**
 * State and actions the modules add to the store (`installStoreSlice`),
 * declared by each module with a module augmentation:
 * `declare module '…/store.js' { interface AssemblerStateExtensions extends MySlice {} }`.
 */
// eslint-disable-next-line @typescript-eslint/no-empty-interface, @typescript-eslint/no-empty-object-type
export interface AssemblerStateExtensions {}

export interface AssemblerState extends AssemblerStateExtensions {
  projectName: string;
  /** Sets the project's display name (not undo-tracked). Blank input is ignored. */
  setProjectName: (name: string) => void;
  features: Feature[];
  /** Last completed kernel evaluation (see `evaluationPending`). */
  evaluation: EvaluationResult;
  /** `true` while the kernel computes a newer document revision than `evaluation`. */
  evaluationPending: boolean;
  /**
   * A live preview of an uncommitted document change (a parameter slider
   * being dragged), shown by the viewport instead of `evaluation` while no
   * tool runs; `null` otherwise. Never committed, never saved.
   */
  documentPreview: EvaluationResult | null;

  kernelStatus: KernelStatus;
  kernelMessage: string;
  /** Kernel load progress 0..1 while loading, when known. */
  kernelProgress: number | null;
  /** Measured kernel load time once ready, ms. */
  kernelLoadMs: number | null;
  /**
   * The kernel computation running for longer than {@link LONG_OPERATION_MS}
   * (progress + Cancel are shown for it), else `null`.
   */
  kernelActivity: KernelActivity | null;
  /** One-off message for the user (kernel restarted after a crash, computation cancelled). */
  kernelNotice: string | null;
  dismissKernelNotice: () => void;
  /**
   * Cancels the long-running computation: a tool preview ends the tool; a
   * document evaluation is stopped and the last computed state restored
   * (the cancelled change stays available as Redo).
   */
  cancelKernelWork: () => void;
  /** Connects the store to a kernel and evaluates the current document. */
  attachKernel: (adapter: KernelAdapter) => void;
  /** Resolves once no document or preview evaluation is outstanding. */
  whenSettled: () => Promise<void>;

  history: { canUndo: boolean; canRedo: boolean };
  /**
   * Bumped by every {@link AssemblerState.loadDocument} (New, Open, template, recovery):
   * sessions tied to steps of the previous document (History "Fix…") end on a change —
   * feature ids are sequential, so the next document may reuse them.
   */
  documentGeneration: number;
  undo: () => void;
  redo: () => void;

  selection: SelectionItem[];
  hover: SelectionItem | null;
  select: (item: SelectionItem, options?: { additive?: boolean }) => void;
  /** Replaces the whole selection at once (box selection, pick lists). */
  setSelection: (items: SelectionItem[]) => void;
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
  // The modules' tools add their actions through slices (e.g. `beginExtrude`, `modules/modeling/tools.ts`).
  /** Starts a feature tool (a registered draft kind: Revolve, Hole, Offset Face, …) with a live preview. */
  beginFeatureTool: (draft: FeatureDraft) => void;
  /** Starts `commandId` before its selection: the pill asks for the references (`pickSession.ts`). */
  beginPickSession: (commandId: string) => void;
  /** Updates the running pick session (a click, a removed badge, Swap, Next). */
  updatePickSession: (update: (session: PickSessionState) => PickSessionState) => void;
  /** Updates the running feature tool's draft (references/parameters) and re-previews. */
  updateFeatureDraft: (
    update: (draft: FeatureDraft, evaluation: EvaluationResult) => FeatureDraft,
  ) => void;
  /** Enters the `numericEditing` phase (e.g. a dimension field gained focus). No-op without an active tool. */
  beginNumericEditing: () => void;
  /** Leaves `numericEditing` back to `preview`. No-op unless currently `numericEditing`. */
  endNumericEditing: () => void;
  /** Commits the active tool's provisional feature as exactly one undo step. No-op without an active tool. */
  commit: () => void;
  /** Cancels the active tool. `features` and the undo stack are left exactly as they were. */
  cancel: () => void;

  /**
   * Appends one "Import" history step producing a body from an already-read
   * STEP file (base64 `data`), as one undo step; selects the new feature.
   * Used by the File > Import > STEP flow (`model/project/`).
   */
  addImportedBody: (input: { data: string; fileName: string }) => void;
  /**
   * Appends a fully formed feature (e.g. a sketch finished in a sketch
   * session) as one undo step and selects `selection` (default: the feature).
   */
  addFeature: (feature: Feature, selection?: SelectionItem[]) => void;
  /**
   * Routes Undo/Redo to a nested editing session (a sketch session undoes
   * step by step inside the session) until reset with `null`. `history`
   * mirrors the delegate while it is set; call `syncHistory` after the
   * delegate's own stacks change.
   */
  setHistoryDelegate: (delegate: HistoryDelegate | null) => void;
  syncHistory: () => void;

  /**
   * History rollback marker: the id of the first feature that is rolled back
   * (not evaluated, greyed in History), or `null` when the whole history is
   * active. New features are inserted at the marker. View state: not saved,
   * not undo-tracked; cleared when its feature disappears (then the next
   * surviving feature takes over), on load and by agent commits.
   */
  rollbackBefore: string | null;
  /** Moves the rollback marker (`null` = roll forward to the end). Ignored while a tool runs. */
  setRollback: (featureId: string | null) => void;

  /**
   * Imported STL reference meshes: shown, measured, hidden and moved like a
   * body, but never a kernel/OCCT input (`apps/assembler/README.md` "STL
   * import"). Outside `features` / the undo-tracked history — import,
   * remove, hide and move are document-level edits, not modelling steps.
   */
  referenceMeshes: ReferenceMesh[];
  /** Adds an already-parsed reference mesh (one per STL import) and selects it. */
  importReferenceMesh: (mesh: ReferenceMesh) => void;
  removeReferenceMesh: (id: string) => void;
  /** Renames a reference mesh (blank names are ignored). */
  renameReferenceMesh: (id: string, name: string) => void;
  setReferenceMeshHidden: (id: string, hidden: boolean) => void;
  /** Absolute document-level translation (mm) applied on top of the mesh's own coordinates — the Move gizmo's reference-mesh path. */
  moveReferenceMesh: (id: string, transform: ReferenceMeshTransform) => void;

  editFeatureParams: (featureId: string, patch: FeaturePatch) => void;
  setSuppressed: (featureId: string, suppressed: boolean) => void;
  renameFeature: (featureId: string, name: string) => void;
  deleteFeature: (featureId: string) => void;

  /**
   * Document parameters ("variables", `model/parameters.ts`): named values
   * usable from sketch dimension expressions and extrude/fillet/chamfer/shell
   * size fields. Part of the undo-tracked document (one parameter edit is
   * exactly one undo step, alongside any feature whose `*Expression` field
   * it feeds re-resolves in the same commit).
   */
  parameters: Parameter[];

  /**
   * Stored checks (`document/checks.ts`, assembler/CHECKS.md): requirements
   * evaluated after every rebuild. Undo-tracked document state like
   * `parameters`; empty unless the user or an agent adds one.
   */
  checks: StoredCheck[];
  /**
   * Replaces the stored checks as exactly one undo step (the features are
   * not re-evaluated). Refused (`false`) while a tool or a sketch session
   * owns the undo history.
   */
  commitChecks: (checks: StoredCheck[]) => boolean;

  viewState: ViewState;
  setDisplayMode: (mode: DisplayMode) => void;
  setSectionEnabled: (enabled: boolean) => void;
  setSectionAxis: (axis: SectionAxis) => void;
  setSectionOffset: (offset: number) => void;
  setSectionFlipped: (flipped: boolean) => void;
  setMeasureEnabled: (enabled: boolean) => void;
  /** Display toggles (`ViewState.edgesVisible`, …); view state, not undo-tracked. */
  setViewToggle: (
    key: 'edgesVisible' | 'hiddenEdgesVisible' | 'axesVisible' | 'sectionOnly',
    value: boolean,
  ) => void;
  /** X-Ray surface opacity (clamped to 0.05..0.95); view state, not undo-tracked. */
  setXrayOpacity: (value: number) => void;
  setGridPlane: (plane: GridPlane) => void;
  /** Sets (or clears) the face-aligned section plane; the offset restarts at the face. */
  setSectionPlane: (plane: SectionPlane | null) => void;
  /**
   * Explicit per-sketch viewport visibility (not undo-tracked). Sketches
   * without an entry are shown until an extrude consumes them.
   */
  sketchVisibility: Record<string, boolean>;
  setSketchVisible: (featureId: string, visible: boolean) => void;
  setGridVisible: (visible: boolean) => void;
  setSnapToGrid: (enabled: boolean) => void;
  setGridStep: (step: number) => void;
  /** Grid resolution follows the zoom (`true`) or is locked at `gridStep`. */
  setGridAuto: (auto: boolean) => void;
  requestCamera: (preset: CameraPreset) => void;

  panels: PanelsState;
  togglePanel: (panel: keyof PanelsState) => void;
  setPanelVisible: (panel: keyof PanelsState, visible: boolean) => void;

  /**
   * Applies a project file's persisted view state (display mode, section,
   * grid, panels, last camera preset) on Open/recovery-restore. Never
   * undo-tracked; unspecified fields keep their current value so an older
   * or partial `viewState` still applies cleanly.
   */
  applyViewState: (view: ProjectViewState) => void;

  recentCommandIds: string[];
  pushRecentCommand: (commandId: string) => void;

  /**
   * Replaces the whole document (features + project name), resetting undo
   * history, selection, hover and visibility state.
   */
  loadDocument: (
    features: Feature[],
    options?: {
      projectName?: string;
      referenceMeshes?: ReferenceMesh[];
      parameters?: Parameter[];
      checks?: StoredCheck[];
    },
  ) => void;

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
    options?: {
      selection?: SelectionItem[];
      evaluation?: EvaluationResult;
      /** UI edits (colour, reorder) keep the History rollback marker; agent commits lift it. */
      keepRollback?: boolean;
    },
  ) => boolean;
  /** A fresh feature id (`feature-<kind>-<n>`) from the same counter the UI tools use, unique in `features`. */
  allocateFeatureId: (kind: string, reserved?: ReadonlySet<string>) => string;
}

/** A nested undo scope (see {@link AssemblerState.setHistoryDelegate}). */
export interface HistoryDelegate {
  undo: () => void;
  redo: () => void;
  canUndo: () => boolean;
  canRedo: () => boolean;
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
      return (
        b.kind === 'sketchProfile' && a.featureId === b.featureId && a.regionKey === b.regionKey
      );
    case 'feature':
      return b.kind === 'feature' && a.featureId === b.featureId;
    case 'mesh':
      return b.kind === 'mesh' && a.meshId === b.meshId;
    case 'datum':
      return b.kind === 'datum' && a.featureId === b.featureId;
    case 'sketchCurve':
      return b.kind === 'sketchCurve' && a.featureId === b.featureId && a.entityId === b.entityId;
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
      return evaluation.sketches.some(
        (s) =>
          s.featureId === item.featureId &&
          (item.regionKey === undefined || s.profiles.some((p) => p.key === item.regionKey)),
      )
        ? item
        : null;
    case 'feature':
      return featureIds.has(item.featureId) ? item : null;
    // Reference meshes live outside kernel evaluation entirely (never
    // consumed as a kernel input), so their selection is never remapped by
    // a re-evaluation; removal is handled explicitly by `removeReferenceMesh`.
    case 'mesh':
      return item;
    case 'datum':
      return evaluation.datums?.some((d) => d.featureId === item.featureId) ? item : null;
    case 'sketchCurve':
      return evaluation.sketches.some(
        (s) =>
          s.featureId === item.featureId &&
          (s.curves ?? []).some((curve) => curve.entityId === item.entityId),
      )
        ? item
        : null;
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

/** A new, never reused feature id `feature-<kind>-<n>`. */
export function createFeatureId(kind: string): string {
  featureIdCounter += 1;
  return `feature-${kind}-${featureIdCounter}`;
}

/** Next free display name `"<prefix> <n>"`, e.g. `"Sketch 3"`. */
export function nextFeatureName(prefix: string, features: readonly Feature[]): string {
  const count = features.filter((f) => f.name.startsWith(`${prefix} `)).length;
  return `${prefix} ${count + 1}`;
}

/** Provisional feature of a preview tool, or `null` when its parameters have no geometry yet. */
function buildProvisional(tool: PreviewTool): Feature | null {
  if (tool.kind === 'feature') {
    return draftToFeature(tool.draft, { id: PREVIEW_FEATURE_ID, name: 'Preview' });
  }
  const provisional = toolKinds.get(tool.kind)?.provisional as
    | ((tool: PreviewTool) => Feature | null)
    | undefined;
  return provisional ? provisional(tool) : null;
}
function featureToolPhase(draft: FeatureDraft): ToolPhase {
  return draftToFeature(draft, { id: PREVIEW_FEATURE_ID, name: '' })
    ? 'preview'
    : 'collectingReferences';
}

const NO_PREVIEW: KernelPreviewFields = {
  previewEvaluation: null,
  previewPending: false,
  previewError: null,
};

/** A kernel computation running longer than this shows progress and a Cancel button, ms. */
export let LONG_OPERATION_MS = 2000;

/** Test hook: shortens the delay before a long computation is shown. */
export function setLongOperationDelay(ms: number): void {
  LONG_OPERATION_MS = ms;
}

/** What the store core offers a module's slice (see {@link installStoreSlice}). */
export interface StoreCore {
  getState: () => AssemblerState;
  /** Whether a kernel is attached. */
  hasKernel(): boolean;
  /** The attached kernel for one-off queries (document checks), or `null`. */
  kernel(): KernelAdapter | null;
  /**
   * Commits a complete next document (features, and parameters when given)
   * as exactly one undo step, through the path every tool's Done uses.
   */
  commitDocument(next: {
    features: Feature[];
    parameters?: Parameter[];
    selection?: SelectionItem[];
  }): void;
  /** Records `evaluation` as the kernel result of exactly `features` (no re-evaluation on commit). */
  seedEvaluation(features: Feature[], evaluation: EvaluationResult): void;
  /**
   * Evaluates `features` on the kernel's preview channel without touching the
   * document (retried while UI previews supersede it).
   */
  evaluateCheck(
    features: Feature[],
  ): Promise<
    | { kind: 'done'; result: EvaluationResult }
    | { kind: 'failed'; message: string }
    | { kind: 'busy' }
  >;
  /**
   * Starts an evaluation of `features` without touching the document: on the
   * `background` channel (default; lowest priority, never superseded by tool
   * previews — a parameter sweep's samples) or the `preview` channel with
   * preview tessellation (a slider's live preview; a newer request
   * supersedes a waiting one). `null` without a kernel. `cancel` resolves the
   * job `cancelled` at once (the kernel finishes the running operation and
   * drops it).
   */
  evaluateDetached(
    features: Feature[],
    options?: { channel?: 'background' | 'preview' },
  ): {
    outcome: Promise<EvaluationOutcome>;
    cancel: () => void;
  } | null;
  /**
   * A live preview of a document change that is not committed (a parameter
   * slider being dragged): the viewport shows `evaluation` instead of the
   * committed one while no tool runs; `null` ends it.
   */
  setDocumentPreview(evaluation: EvaluationResult | null): void;
  /** The tool-session lifecycle for a module's tool actions (`registerToolKind`). */
  tools: {
    /** Ends the running tool's preview (call before starting a new session). */
    endPreview(): void;
    /** Stores an updated preview tool and requests its kernel preview (throttled). */
    updatePreviewTool(tool: PreviewTool): void;
  };
}

type SetState = (partial: Partial<AssemblerState>) => void;

/** A module's slice: its initial state and actions, merged into the store once. */
export type StoreSliceCreator<T = Partial<AssemblerState>> = (
  set: SetState,
  get: () => AssemblerState,
  core: StoreCore,
) => T;

let storeCore: StoreCore | null = null;
const installedSlices = new Set<string>();

/** The core part of the state: everything but the modules' slices. */
type CoreState = Omit<AssemblerState, keyof AssemblerStateExtensions>;

export const useAssemblerStore = create<AssemblerState>((set, get) => {
  /**
   * Undo/redo snapshots of `features` + `parameters` (one committed tool
   * operation or one parameter edit = exactly one entry); only
   * `history.canUndo/canRedo` are public.
   */
  interface HistorySnapshot {
    features: Feature[];
    parameters: Parameter[];
    /** Stored checks (`document/checks.ts`): document state, undone with the features. */
    checks: StoredCheck[];
  }
  function historySnapshot(state: AssemblerState): HistorySnapshot {
    return { features: state.features, parameters: state.parameters, checks: state.checks };
  }
  let past: HistorySnapshot[] = [];
  let future: HistorySnapshot[] = [];

  // The sketch solver (any transport: UI tool, headless, agent API) always
  // reads the document's *current* parameter values for a name a sketch's
  // own dimensions do not resolve (`sketch/solverProvider.ts`).
  setParameterValuesProvider(() => {
    const resolved = resolveParameterValues(get().parameters);
    return resolved.ok ? resolved.values : new Map();
  });

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
  /** Nested undo scope (a sketch session) while set; see `setHistoryDelegate`. */
  let historyDelegate: HistoryDelegate | null = null;
  /**
   * The document the shown `evaluation` belongs to (restored by `cancelKernelWork`):
   * the full feature list and the History rollback marker (the evaluated array itself
   * is only the slice above the marker, so it must never be committed as the document).
   */
  let lastEvaluatedDocument: {
    features: Feature[];
    rollbackBefore: string | null;
    /** Parameters of that document (a parameter edit re-solves sketches: restored together). */
    parameters: Parameter[];
  } | null = null;
  function recordEvaluatedDocument(): void {
    const { features, rollbackBefore, parameters } = get();
    lastEvaluatedDocument = { features, rollbackBefore, parameters };
  }
  let unsubscribeActivity: (() => void) | null = null;
  let activityTimer: ReturnType<typeof setTimeout> | null = null;
  /** The running job's activity, published to the state only once it runs long. */
  let runningActivity: KernelActivity | null = null;
  let lastActivityPublish = 0;

  /** Tracks the adapter's running job; shows it (progress + Cancel) after `LONG_OPERATION_MS`. */
  function onKernelActivity(activity: KernelActivity | null): void {
    const previous = runningActivity;
    runningActivity = activity;
    if (!activity) {
      if (activityTimer) clearTimeout(activityTimer);
      activityTimer = null;
      if (get().kernelActivity) set({ kernelActivity: null });
      return;
    }
    if (previous?.jobId !== activity.jobId) {
      if (activityTimer) clearTimeout(activityTimer);
      if (get().kernelActivity) set({ kernelActivity: null });
      const jobId = activity.jobId;
      activityTimer = setTimeout(() => {
        activityTimer = null;
        if (runningActivity?.jobId === jobId) set({ kernelActivity: runningActivity });
      }, LONG_OPERATION_MS);
      return;
    }
    // Progress of a job already shown: at most ~10 updates a second.
    const now = Date.now();
    if (get().kernelActivity && now - lastActivityPublish > 100) {
      lastActivityPublish = now;
      set({ kernelActivity: activity });
    }
  }

  function isSettled(): boolean {
    const state = get();
    const previewBusy = isPreviewTool(state.activeTool) && state.activeTool.previewPending;
    return !state.evaluationPending && !previewBusy && !commitCheckPending;
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

  /**
   * `features` up to the rollback marker, identity-stable per (features, marker) so
   * the result cache also answers a bar moved back to a position seen before. The
   * kernel's prefix cache keys on feature content and order, so a rolled-back or
   * reordered list never reuses a checkpoint of another order.
   */
  const activeSlices = new WeakMap<Feature[], Map<string, Feature[]>>();
  function activeFeatures(): Feature[] {
    const { features, rollbackBefore } = get();
    if (!rollbackBefore) return features;
    const index = features.findIndex((f) => f.id === rollbackBefore);
    if (index < 0) return features;
    let slices = activeSlices.get(features);
    if (!slices) {
      slices = new Map();
      activeSlices.set(features, slices);
    }
    let slice = slices.get(rollbackBefore);
    if (!slice) {
      slice = features.slice(0, index);
      slices.set(rollbackBefore, slice);
    }
    return slice;
  }

  /** Revisions of {@link checkParameterPlan}'s kernel checks (their own sequence on the preview channel). */
  let planCheckRevision = 0;
  /** A tool's Done is being checked by the kernel ({@link commitChecked}); Done is ignored meanwhile. */
  let commitCheckPending = false;

  /**
   * Done of a tool whose new feature is a boolean of solids (`isBooleanResult`):
   * the document with the feature is evaluated with the commit check first (full
   * B-rep check of the result; previews only run the cheap one). An invalid
   * result is refused — the tool stays open with the kernel's message, nothing is
   * committed. Otherwise the feature is committed with that evaluation, so the
   * commit costs one evaluation as before (plus the check).
   */
  function commitChecked(feature: Feature, selection?: SelectionItem[]): void {
    const next = [...get().features, feature];
    if (!kernel || !isBooleanResult(feature)) {
      commitFeatures(next, selection);
      return;
    }
    const adapter = kernel;
    const session = toolSession;
    const features = [...activeFeatures(), feature];
    commitCheckPending = true;
    void (async () => {
      let result: EvaluationResult | null = null;
      try {
        for (let attempt = 0; attempt < 20 && !result; attempt += 1) {
          planCheckRevision += 1;
          const outcome = await adapter.evaluate({
            channel: 'preview',
            revision: planCheckRevision,
            features,
            commitCheck: [feature.id],
          }).outcome;
          if (outcome.kind === 'done') result = outcome.result;
          else if (outcome.kind === 'failed') break; // the document evaluation reports it
          // superseded by a preview: try again.
        }
      } finally {
        commitCheckPending = false;
      }
      const tool = get().activeTool;
      if (session !== toolSession || !tool) {
        notifySettled(); // the tool was cancelled meanwhile
        return;
      }
      const error = result?.errors[feature.id];
      if (error) {
        if (isPreviewTool(tool)) {
          set({
            activeTool: {
              ...tool,
              previewError: error,
              previewErrorRefs: result?.errorRefs?.[feature.id] ?? null,
              previewPending: false,
            },
          });
        }
        notifySettled();
        return;
      }
      commitFeatures(next, selection, undefined, result ?? undefined);
    })();
  }

  /** Requests evaluation of the current `features`. Stale results (older revisions) are dropped. */
  function evaluateDocument(): void {
    documentRevision += 1;
    const revision = documentRevision;
    const features = activeFeatures();
    if (documentJob) {
      kernel?.cancel(documentJob.id);
      documentJob = null;
    }
    const cached = resultCache.get(features);
    if (cached) {
      recordEvaluatedDocument();
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
        recordEvaluatedDocument();
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
      return {
        ...tool,
        previewEvaluation: null,
        previewPending: false,
        previewError: null,
        previewErrorRefs: null,
      };
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
      features: [...activeFeatures(), provisional],
      quality: 'preview',
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
            previewErrorRefs: error ? (outcome.result.errorRefs?.[provisional.id] ?? null) : null,
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

  function sectionOffsetFor(axis: SectionAxis): number {
    const state = get();
    return defaultSectionOffset(
      visibleBounds(state.evaluation.bodies, state.hiddenBodyIds, state.isolatedBodyIds),
      axis,
    );
  }

  /** `evaluation`: already computed for the new document (its active steps); reused, not re-evaluated. */
  function setFeatures(
    nextFeatures: Feature[],
    extra: Partial<AssemblerState> = {},
    evaluation?: EvaluationResult,
  ): void {
    const previous = get();
    let rollbackBefore = previous.rollbackBefore;
    if (rollbackBefore && !nextFeatures.some((f) => f.id === rollbackBefore)) {
      // The marker's feature is gone: the next surviving later feature takes over.
      const ids = new Set(nextFeatures.map((f) => f.id));
      const from = previous.features.findIndex((f) => f.id === rollbackBefore);
      rollbackBefore =
        (from >= 0 ? previous.features.slice(from + 1).find((f) => ids.has(f.id))?.id : null) ??
        null;
    }
    // Any document change ends a live preview of an uncommitted one (a slider drag).
    set({ features: nextFeatures, rollbackBefore, documentPreview: null, ...extra });
    if (evaluation) resultCache.set(activeFeatures(), evaluation);
    evaluateDocument();
    notifySettled();
  }

  function commitFeatures(
    nextFeatures: Feature[],
    selectionOverride?: SelectionItem[],
    nextParameters?: Parameter[],
    evaluation?: EvaluationResult,
  ): void {
    const state = get();
    past = [...past, historySnapshot(state)];
    future = [];
    endPreview();
    const marker = state.rollbackBefore;
    const prev = state.features;
    const markerIndex = marker ? prev.findIndex((f) => f.id === marker) : -1;
    if (
      markerIndex >= 0 &&
      nextFeatures.length > prev.length &&
      prev.every((f, i) => nextFeatures[i] === f)
    ) {
      // Rolled back: appended features go in at the marker, before the rolled-back steps.
      nextFeatures = [
        ...prev.slice(0, markerIndex),
        ...nextFeatures.slice(prev.length),
        ...prev.slice(markerIndex),
      ];
    }
    setFeatures(
      nextFeatures,
      {
        ...(selectionOverride ? { selection: selectionOverride } : {}),
        ...(nextParameters ? { parameters: nextParameters } : {}),
        history: { canUndo: true, canRedo: false },
        activeTool: null,
      },
      evaluation,
    );
  }

  function appendFeature(feature: Feature): void {
    commitFeatures([...get().features, feature], [{ kind: 'feature', featureId: feature.id }]);
  }

  storeCore = {
    getState: get,
    hasKernel: () => kernel !== null,
    kernel: () => kernel,
    commitDocument: (next) => commitFeatures(next.features, next.selection, next.parameters),
    seedEvaluation: (features, evaluation) => resultCache.set(features, evaluation),
    evaluateCheck: async (features) => {
      if (!kernel) return { kind: 'busy' };
      for (let attempt = 0; attempt < 20; attempt += 1) {
        planCheckRevision += 1;
        const outcome = await kernel.evaluate({
          channel: 'preview',
          revision: planCheckRevision,
          features,
        }).outcome;
        if (outcome.kind === 'done') return { kind: 'done', result: outcome.result };
        if (outcome.kind === 'failed') return { kind: 'failed', message: outcome.message };
        // superseded by a tool preview: try again.
      }
      return { kind: 'busy' };
    },
    evaluateDetached: (features, options) => {
      if (!kernel) return null;
      const adapter = kernel;
      planCheckRevision += 1;
      const channel = options?.channel ?? 'background';
      const job = adapter.evaluate({
        channel,
        revision: planCheckRevision,
        features,
        ...(channel === 'preview' ? { quality: 'preview' as const } : {}),
      });
      return { outcome: job.outcome, cancel: () => adapter.cancel(job.id) };
    },
    setDocumentPreview: (evaluation) => {
      if (get().documentPreview !== evaluation) set({ documentPreview: evaluation });
    },
    tools: { endPreview, updatePreviewTool },
  };

  const core: CoreState = {
    projectName: 'Bracket',
    setProjectName: (name) => {
      const trimmed = name.trim();
      if (!trimmed) return;
      set({ projectName: trimmed });
    },
    features: createDemoDocument(),
    evaluation: EMPTY_EVALUATION,
    evaluationPending: true,
    documentPreview: null,

    kernelStatus: 'loading',
    kernelMessage: 'Loading CAD kernel…',
    kernelProgress: null,
    kernelLoadMs: null,
    kernelActivity: null,
    kernelNotice: null,
    dismissKernelNotice: () => set({ kernelNotice: null }),
    cancelKernelWork: () => {
      const activity = runningActivity;
      if (!kernel || !activity) return;
      if (activity.channel === 'preview') {
        kernel.cancel(activity.jobId, { hard: true });
        // A tool's preview: cancelling the computation cancels the tool.
        if (previewJob?.id === activity.jobId) get().cancel();
        return;
      }
      if (activity.channel === 'background') {
        // A sweep's sample: it sees `cancelled` and stops; the document is untouched.
        kernel.cancel(activity.jobId, { hard: true });
        return;
      }
      kernel.cancel(activity.jobId, { hard: true });
      if (documentJob?.id === activity.jobId) documentJob = null;
      const restore = lastEvaluatedDocument;
      const state = get();
      if (!historyDelegate && restore && !state.activeTool) {
        const featuresChanged = restore.features !== state.features;
        const markerChanged = restore.rollbackBefore !== state.rollbackBefore;
        if (featuresChanged || markerChanged) {
          // Restore features and marker together (not via `commitFeatures`, whose
          // insert-at-marker rule would misplace a restored list while rolled back).
          const viaUndo = featuresChanged && past[past.length - 1]?.features === restore.features;
          // Undoing the cancelled step also restores the checks it was taken with.
          const restoredChecks = viaUndo ? past[past.length - 1]!.checks : state.checks;
          if (viaUndo) {
            past = past.slice(0, -1);
            future = [...future, historySnapshot(state)];
          } else if (featuresChanged) {
            past = [...past, historySnapshot(state)];
            future = [];
          }
          const marker =
            restore.rollbackBefore && restore.features.some((f) => f.id === restore.rollbackBefore)
              ? restore.rollbackBefore
              : null;
          set({
            features: restore.features,
            parameters: restore.parameters,
            checks: restoredChecks,
            rollbackBefore: marker,
            history: { canUndo: past.length > 0, canRedo: future.length > 0 },
            kernelNotice: featuresChanged
              ? `Computation cancelled: the last computed state was restored. ${
                  viaUndo ? 'Redo' : 'Undo'
                } applies the change again.`
              : 'Computation cancelled: the History rollback bar was moved back.',
          });
          evaluateDocument();
          notifySettled();
          return;
        }
      }
      set({
        evaluationPending: false,
        kernelNotice: 'Computation cancelled: the model shows the last computed state.',
      });
      notifySettled();
    },
    attachKernel: (adapter) => {
      unsubscribeKernel?.();
      unsubscribeActivity?.();
      kernel = adapter;
      resultCache = new WeakMap();
      unsubscribeActivity = adapter.onActivity(onKernelActivity);
      unsubscribeKernel = adapter.onStatus((status) => {
        const wasReady = get().kernelStatus === 'ready';
        set({
          kernelStatus: status.status,
          kernelMessage: status.message,
          kernelProgress: status.progress,
          kernelLoadMs: status.loadMs,
          ...(status.notice ? { kernelNotice: status.notice } : {}),
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
    documentGeneration: 0,
    undo: () => {
      if (historyDelegate) {
        historyDelegate.undo();
        return;
      }
      const state = get();
      if (past.length === 0) return;
      const previous = past[past.length - 1]!;
      past = past.slice(0, -1);
      future = [...future, historySnapshot(state)];
      setFeatures(previous.features, {
        parameters: previous.parameters,
        checks: previous.checks,
        history: { canUndo: past.length > 0, canRedo: future.length > 0 },
      });
    },
    redo: () => {
      if (historyDelegate) {
        historyDelegate.redo();
        return;
      }
      const state = get();
      if (future.length === 0) return;
      const next = future[future.length - 1]!;
      future = future.slice(0, -1);
      past = [...past, historySnapshot(state)];
      setFeatures(next.features, {
        parameters: next.parameters,
        checks: next.checks,
        history: { canUndo: past.length > 0, canRedo: future.length > 0 },
      });
    },
    checks: [],
    commitChecks: (checks) => {
      const state = get();
      // A tool or a sketch session owns the undo history meanwhile.
      if (state.activeTool || historyDelegate) return false;
      if (checks === state.checks) return true;
      past = [...past, historySnapshot(state)];
      future = [];
      // The features do not change: nothing is re-evaluated.
      set({ checks, history: { canUndo: true, canRedo: false } });
      return true;
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
    setSelection: (items) => set({ selection: [...items] }),
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
    beginFeatureTool: (draft) => {
      endPreview();
      updatePreviewTool({ kind: 'feature', phase: featureToolPhase(draft), draft, ...NO_PREVIEW });
    },
    beginPickSession: (commandId) => {
      const state = get();
      const session = startSession(commandId, state.selection, { evaluation: state.evaluation });
      if (!session) return;
      endPreview();
      set({
        activeTool: { kind: 'pick', phase: 'collectingReferences', ...session },
        selection: [],
      });
      // The selection already held everything: start right away.
      if (readyToFinish(session)) get().commit();
    },
    updatePickSession: (update) => {
      const tool = get().activeTool;
      if (tool?.kind !== 'pick') return;
      const { kind: _kind, phase, ...session } = tool;
      const next = update(session);
      if (next === session) return;
      set({ activeTool: { kind: 'pick', phase, ...next } });
      if (readyToFinish(next)) get().commit();
    },
    updateFeatureDraft: (update) => {
      const state = get();
      const tool = state.activeTool;
      if (tool?.kind !== 'feature') return;
      const draft = update(tool.draft, state.evaluation);
      if (draft === tool.draft) return;
      updatePreviewTool({ ...tool, draft, phase: featureToolPhase(draft) });
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
      if (!tool || commitCheckPending) return;

      // A kernel error for the current parameters blocks Done (the tool stays open).
      if (isPreviewTool(tool) && tool.previewError !== null && !tool.previewPending) return;

      if (tool.kind === 'pick') {
        // Next step, or (all references there) start the command.
        pickFinisher?.();
        return;
      }

      if (tool.kind === 'feature') {
        const kind = tool.draft.kind;
        const feature = draftToFeature(tool.draft, {
          id: createFeatureId(kind),
          name: nextFeatureName(
            draftNamePrefix(tool.draft) ?? featureKindLabel(kind),
            state.features,
          ),
        });
        if (!feature) return; // references still missing: the tool stays open
        commitChecked(feature, [{ kind: 'feature', featureId: feature.id }]);
        return;
      }

      // A module's tool (Extrude, Move/Rotate, …): its own Done.
      toolKinds.get(tool.kind)?.commit(tool, {
        features: state.features,
        commitFeature: (feature, selection) => commitChecked(feature, selection),
        commitFeatures: (next, selection) => commitFeatures(next, selection),
        update: (next) => set({ activeTool: next }),
      });
    },
    cancel: () => {
      endPreview();
      set({ activeTool: null });
      notifySettled();
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
    addFeature: (feature, selection) => {
      commitFeatures(
        [...get().features, feature],
        selection ?? [{ kind: 'feature', featureId: feature.id }],
      );
    },
    setHistoryDelegate: (delegate) => {
      historyDelegate = delegate;
      get().syncHistory();
    },
    syncHistory: () => {
      set({
        history: historyDelegate
          ? { canUndo: historyDelegate.canUndo(), canRedo: historyDelegate.canRedo() }
          : { canUndo: past.length > 0, canRedo: future.length > 0 },
      });
    },

    rollbackBefore: null,
    setRollback: (featureId) => {
      const state = get();
      if (state.activeTool) return;
      const next = featureId && state.features.some((f) => f.id === featureId) ? featureId : null;
      if (next === state.rollbackBefore) return;
      set({ rollbackBefore: next });
      evaluateDocument();
      notifySettled();
    },

    referenceMeshes: [],
    importReferenceMesh: (mesh) => {
      set((s) => ({ referenceMeshes: [...s.referenceMeshes, mesh] }));
      get().select({ kind: 'mesh', meshId: mesh.id });
    },
    removeReferenceMesh: (id) => {
      set((s) => ({
        referenceMeshes: s.referenceMeshes.filter((m) => m.id !== id),
        selection: s.selection.filter((item) => !(item.kind === 'mesh' && item.meshId === id)),
      }));
    },
    renameReferenceMesh: (id, name) => {
      const trimmed = name.trim();
      if (!trimmed) return;
      set((s) => ({
        referenceMeshes: s.referenceMeshes.map((m) => (m.id === id ? { ...m, name: trimmed } : m)),
      }));
    },
    setReferenceMeshHidden: (id, hidden) => {
      set((s) => ({
        referenceMeshes: s.referenceMeshes.map((m) => (m.id === id ? { ...m, hidden } : m)),
      }));
    },
    moveReferenceMesh: (id, transform) => {
      set((s) => ({
        referenceMeshes: s.referenceMeshes.map((m) => (m.id === id ? { ...m, transform } : m)),
      }));
    },

    editFeatureParams: (featureId, patch) => {
      const state = get();
      const paramValues = resolveParameterValues(state.parameters);
      const values = paramValues.ok ? paramValues.values : new Map<string, number>();
      const next = state.features.map((f) => {
        if (f.id !== featureId) return f;
        let merged = { ...f, ...patch } as Feature;
        // A field's own `*Expression` in this patch is resolved immediately
        // (the History card's expression input), like a sketch dimension.
        for (const field of expressionFieldsOf(merged.kind)) {
          const exprField = `${field}Expression`;
          if (!(exprField in patch)) continue;
          const expression = (patch as unknown as Record<string, unknown>)[exprField];
          if (typeof expression === 'string') {
            const resolved = resolveFieldExpression(merged.kind, field, expression, values);
            if (resolved.ok) merged = { ...merged, [field]: resolved.value } as Feature;
          } else if (expression === undefined) {
            const { [exprField]: _drop, ...rest } = merged as unknown as Record<string, unknown>;
            merged = rest as unknown as Feature;
          }
        }
        return merged;
      });
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

    parameters: [],
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
      gridAuto: true,
      cameraRequest: null,
      edgesVisible: true,
      hiddenEdgesVisible: false,
      axesVisible: true,
      sectionPlane: null,
      sectionOnly: false,
      xrayOpacity: DEFAULT_XRAY_OPACITY,
      gridPlane: 'XY',
    },
    setDisplayMode: (mode) => set((s) => ({ viewState: { ...s.viewState, displayMode: mode } })),
    setViewToggle: (key, value) => set((s) => ({ viewState: { ...s.viewState, [key]: value } })),
    setGridPlane: (gridPlane) => set((s) => ({ viewState: { ...s.viewState, gridPlane } })),
    setXrayOpacity: (value) => {
      const xrayOpacity = clampXrayOpacity(value);
      if (xrayOpacity === null) return;
      set((s) => ({ viewState: { ...s.viewState, xrayOpacity } }));
    },
    setSectionPlane: (plane) =>
      set((s) => ({
        viewState: {
          ...s.viewState,
          sectionPlane: plane,
          sectionOffset: plane ? 0 : sectionOffsetFor(s.viewState.sectionAxis),
        },
      })),
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
          sectionPlane: null,
          ...(axis !== s.viewState.sectionAxis || s.viewState.sectionPlane
            ? { sectionOffset: sectionOffsetFor(axis) }
            : {}),
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
    setGridAuto: (auto) => set((s) => ({ viewState: { ...s.viewState, gridAuto: auto } })),
    requestCamera: (preset) =>
      set((s) => ({
        viewState: {
          ...s.viewState,
          cameraRequest: { preset, nonce: (s.viewState.cameraRequest?.nonce ?? 0) + 1 },
        },
      })),

    panels: { items: true, history: true, parameters: false },
    togglePanel: (panel) => set((s) => ({ panels: { ...s.panels, [panel]: !s.panels[panel] } })),
    setPanelVisible: (panel, visible) =>
      set((s) => ({ panels: { ...s.panels, [panel]: visible } })),

    applyViewState: (view) => {
      const validPresets: readonly CameraPreset[] = [
        'iso',
        'front',
        'back',
        'top',
        'bottom',
        'left',
        'right',
        'fit',
      ];
      const validAxes: readonly SectionAxis[] = ['X', 'Y', 'Z'];
      set((s) => {
        const next: ViewState = {
          ...s.viewState,
          ...(view.section?.enabled !== undefined ? { sectionEnabled: view.section.enabled } : {}),
          ...(view.section?.axis && validAxes.includes(view.section.axis)
            ? { sectionAxis: view.section.axis }
            : {}),
          ...(typeof view.section?.offset === 'number'
            ? { sectionOffset: view.section.offset }
            : {}),
          ...(view.section?.flipped !== undefined ? { sectionFlipped: view.section.flipped } : {}),
          ...(view.grid?.visible !== undefined ? { gridVisible: view.grid.visible } : {}),
          ...(view.grid?.snap !== undefined ? { snapToGrid: view.grid.snap } : {}),
          ...(typeof view.grid?.step === 'number' ? { gridStep: view.grid.step } : {}),
          // Projects written before the zoom-dependent grid kept a fixed step: they reopen locked.
          ...(typeof view.grid?.auto === 'boolean'
            ? { gridAuto: view.grid.auto }
            : typeof view.grid?.step === 'number'
              ? { gridAuto: false }
              : {}),
        };
        const preset = view.camera?.preset;
        if (preset && (validPresets as readonly string[]).includes(preset)) {
          next.cameraRequest = {
            preset: preset as CameraPreset,
            nonce: (s.viewState.cameraRequest?.nonce ?? 0) + 1,
          };
        }
        return {
          viewState: next,
          panels: {
            items: view.panels?.items ?? s.panels.items,
            history: view.panels?.history ?? s.panels.history,
            parameters: view.panels?.parameters ?? s.panels.parameters,
          },
        };
      });
    },

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
      // Reseed the module-level id counter from the loaded document rather
      // than leaving it at whatever it reached in the previous session (or
      // the demo document's count): otherwise a freshly created feature can
      // collide with an id already present in the file just opened, since
      // most call sites mint ids via `createFeatureId` directly rather than
      // through `allocateFeatureId`'s collision-checked loop.
      featureIdCounter = highestFeatureIdSuffix(features);
      set({
        projectName: options?.projectName ?? previous.projectName,
        history: { canUndo: false, canRedo: false },
        documentGeneration: previous.documentGeneration + 1,
        activeTool: null,
        selection: [],
        hover: null,
        hiddenBodyIds: [],
        isolatedBodyIds: null,
        sketchVisibility: {},
        evaluation: EMPTY_EVALUATION,
        documentPreview: null,
        rollbackBefore: null,
        referenceMeshes: options?.referenceMeshes ?? [],
        parameters: options?.parameters ?? [],
        // A loaded project's checks come with its file section (`modules/checks`), after this.
        checks: options?.checks ?? [],
      });
      setFeatures(features);
    },

    commitDocumentChange: (nextFeatures, options) => {
      if (get().activeTool !== null) return false;
      // Agent commands always act on the full history: a UI rollback marker is lifted first.
      if (get().rollbackBefore !== null && !options?.keepRollback) set({ rollbackBefore: null });
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
  // The modules' slices are merged in by `installStoreSlice` (the product composition).
  return core as AssemblerState;
});

/**
 * Merges a module's slice (state and actions) into the store, once per
 * module (`defineAssemblerModule({ storeSlice })`, installed by the product
 * composition before anything reads it).
 */
export function installStoreSlice(module: string, creator: StoreSliceCreator): void {
  if (installedSlices.has(module)) return;
  installedSlices.add(module);
  const slice = creator(
    (partial) => useAssemblerStore.setState(partial),
    useAssemblerStore.getState,
    storeCore!,
  );
  useAssemblerStore.setState(slice);
}

/**
 * The steps the viewport shows: above the History rollback bar when rolled back, else all.
 * Exports use them too, so an export is what the user sees (a STEP/IGES/fine-mesh export
 * while rolled back used to contain the rolled-back steps, the display-mesh STL did not;
 * fuzzer finding F12, `assembler/ROBUSTNESS.md`).
 */
export function shownFeatures(state: {
  features: Feature[];
  rollbackBefore: string | null;
}): Feature[] {
  const index = state.rollbackBefore
    ? state.features.findIndex((f) => f.id === state.rollbackBefore)
    : -1;
  return index >= 0 ? state.features.slice(0, index) : state.features;
}
export type { Body, EvaluationResult, ExtrudeProfileRef, Feature, Plane };
