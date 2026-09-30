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
 *   tools `extrude`, `move` and the generic feature tool, plus one-step commands for
 *   fillet/chamfer, shell and body booleans.
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
import { viewDisplayFromProject } from '../../model/viewDisplay.js';
import { setSectionAccess } from '../../interface/shell-ui/workspace.js';
import {
  EMPTY_EVALUATION,
  type Body,
  type EvaluationResult,
  type FeatureErrorRefs,
  type KernelStatus,
} from '../geometry-kernel/types.js';
import {
  edgeRuleBodyId,
  type ChamferMode,
  type EdgeRule,
  type ShellDirection,
} from '../document/blendOptions.js';
import {
  frameForPlane,
  isBooleanResult,
  MIN_FEATURE_SIZE_MM,
  type BooleanFeature,
  type ChamferFeature,
  type EdgeRef,
  type ExtrudeFeature,
  type ExtrudeObjectRef,
  type ExtrudeOperation,
  type ExtrudeProfileRef,
  type FaceRef,
  type Feature,
  type FilletFeature,
  type ImportStepFeature,
  type MoveFeature,
  type Plane,
  type ShellFeature,
  type SketchFrame,
  type Vec3,
} from '../document/document.js';
import { createDemoDocument } from './demoDocument.js';
import type { SketchFeature } from '../sketch-solver/sketchFeature.js';
import type { TransformFeature } from '../../modules/modeling/features.js';
import { featureKindLabel } from '../document/featureKinds.js';

import { draftToFeature, type FeatureDraft } from './featureDrafts.js';
import { readyToFinish, startSession, type PickSessionState } from './pickSession.js';
import { gizmoTransformFields } from '../../modules/modeling/moveGizmo.js';
import { regionCentre, translateSketchRegion } from '../sketch-solver/moveRegion.js';
import {
  autoExtrudeOperation,
  extrudeStartDepth,
  findSketchContact,
  type SketchContact,
} from '../../modules/modeling/modeling.js';
import { defaultSectionOffset, visibleBounds } from './viewBounds.js';
import {
  expressionFieldsOf,
  resolveFieldExpression,
  resolveParameterValues,
  type Parameter,
} from '../document/parameters.js';
import { setParameterValuesProvider } from '../sketch-solver/solverProvider.js';

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
  | { kind: 'datum'; featureId: string };

/** Explicit lifecycle every tool session moves through. `cancel()` is valid from any of these except after commit. */
export type ToolPhase = 'collectingReferences' | 'preview' | 'numericEditing' | 'committing';

interface ToolSessionBase {
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
  /** Extent (Shapr3D "Distance / To Object / Through All"); absent = distance. */
  extent?: 'distance' | 'throughAll' | 'toObject';
  /** The object a "To Object" extrude runs up to (picked while the tool runs). */
  extentTarget?: ExtrudeObjectRef;
  /** One side (default), symmetric, or two sides with `distance2` on the other side. */
  sides?: 'one' | 'symmetric' | 'two';
  distance2?: number;
  /** Start offset from the profile along its normal, mm. */
  startOffset?: number;
}

/** The extrude options a tool/History card can change (`setExtrudeOptions`); `undefined` clears one. */
export type ExtrudeToolOptions = {
  [K in 'extent' | 'extentTarget' | 'sides' | 'distance2' | 'startOffset']?:
    | ExtrudeTool[K]
    | undefined;
};

/** `F` — fillets or chamfers the selected edges of one body. */
export interface EdgeBlendTool extends ToolSessionBase, KernelPreviewFields {
  kind: 'edgeBlend';
  blend: 'fillet' | 'chamfer';
  bodyId: string;
  edges: EdgeRef[];
  /** Fillet radius or chamfer distance, mm. */
  size: number;
  /** Variants (`model/blendOptions.ts`): end radius of a variable fillet, chamfer mode and its second value. */
  radius2?: number;
  chamferMode?: ChamferMode;
  distance2?: number;
  angle?: number;
  flip?: boolean;
  /** Edges chosen by rule (all edges of a face, all concave/convex edges). */
  rules?: EdgeRule[];
}

/** `H` — hollows a body, opening the selected faces, walls grow inwards (or outwards). */
export interface ShellTool extends ToolSessionBase, KernelPreviewFields {
  kind: 'shell';
  bodyId: string;
  faces: FaceRef[];
  thickness: number;
  direction?: ShellDirection;
  /** Outward only: gap between the body and the shell's cavity, mm. */
  clearance?: number;
}

/** Union/Subtract/Intersect of the selected bodies; the first selected body is the target. */
export interface BooleanTool extends ToolSessionBase, KernelPreviewFields {
  kind: 'boolean';
  operation: BooleanFeature['operation'];
  targetBodyId: string;
  toolBodyIds: string[];
  /** Keep the tool bodies instead of consuming them. */
  keepTools?: boolean;
  /** Keep the target as it was; the result becomes a new body. */
  keepTarget?: boolean;
}

/**
 * `M` — the Move/Rotate gizmo on a single body: translate along the axis
 * arrows, rotate with the rings (degrees about world X, then Y, then Z,
 * through `pivot`), optionally as a copy. Commits a `move` feature for a
 * plain translation, else a `transform` feature.
 */
export interface MoveTool extends ToolSessionBase {
  kind: 'move';
  /** The moved body (`''` while a sketch profile is moved). */
  bodyId: string;
  delta: { dx: number; dy: number; dz: number };
  /**
   * Degrees about the gizmo axes (`axes`, default world X, Y, Z), applied
   * in that order through `pivot` — for world axes exactly the `transform`
   * feature's rx/ry/rz.
   */
  rotation: { rx: number; ry: number; rz: number };
  /** Rotation centre (world, before the translation). Defaults to the body's box centre. */
  pivot: Vec3;
  /** Creates a copy instead of moving the body. */
  copy: boolean;
  /**
   * Gizmo orientation (unit axes; absent = world X, Y, Z). Set when the
   * centre snaps to geometry with auto-orientation on (Shapr3D, int §4).
   */
  axes?: [Vec3, Vec3, Vec3];
  /** Orient the gizmo to the geometry its centre is dropped on. */
  autoOrient?: boolean;
  /**
   * Moving a sketch profile (Shapr3D Move/Rotate on sketch regions): the
   * profile's curves translate in the sketch plane (`sketch/moveRegion.ts`).
   */
  sketch?: { featureId: string; regionKey?: string; frame: SketchFrame };
  /** Why Done cannot apply the move (shown in the pill), else absent. */
  problem?: string;
}

/**
 * The sketch feature after moving a profile with the gizmo: the move's
 * in-plane part translates the curves; the part along the normal moves a
 * whole sketch on a world plane (its offset); rotations are refused (they
 * would break horizontal/vertical constraints).
 */
export function moveSketchResult(
  features: readonly Feature[],
  tool: MoveTool,
): { ok: true; feature: SketchFeature } | { ok: false; reason: string } {
  const target = tool.sketch;
  if (!target) return { ok: false, reason: 'Not a sketch move.' };
  const feature = features.find(
    (f): f is SketchFeature => f.id === target.featureId && f.kind === 'sketch',
  );
  if (!feature) return { ok: false, reason: 'The sketch no longer exists.' };
  const { rx, ry, rz } = tool.rotation;
  if (rx !== 0 || ry !== 0 || rz !== 0) {
    return {
      ok: false,
      reason:
        'Sketch profiles move, they do not rotate here (it would break horizontal/vertical constraints); rotate the body, or the curves in sketch mode.',
    };
  }
  const { u, v, normal } = target.frame;
  const d: Vec3 = [tool.delta.dx, tool.delta.dy, tool.delta.dz];
  const along = (a: Vec3) => a[0] * d[0] + a[1] * d[1] + a[2] * d[2];
  const du = along(u);
  const dv = along(v);
  const dn = along(normal);
  let plane = feature.plane;
  if (Math.abs(dn) > 1e-9) {
    if (target.regionKey !== undefined || plane.kind !== 'plane') {
      return {
        ok: false,
        reason:
          target.regionKey !== undefined
            ? 'A profile moves within its sketch plane; move the whole sketch (double-click it) to lift it.'
            : 'Only a sketch on a world plane can be lifted off its plane; move it within the plane.',
      };
    }
    const k = frameForPlane(plane.plane, 0).normal;
    plane = {
      ...plane,
      offset: plane.offset + dn * (k[0] * normal[0] + k[1] * normal[1] + k[2] * normal[2]),
    };
  }
  const moved =
    Math.abs(du) > 1e-12 || Math.abs(dv) > 1e-12
      ? translateSketchRegion(feature, target.regionKey, du, dv)
      : ({ ok: true, sketch: feature } as const);
  if (!moved.ok) return moved;
  return { ok: true, feature: { ...feature, ...moved.sketch, plane } };
}

/**
 * Revolve, Sweep, Loft, Mirror, Pattern, Split, Align, Offset Face and
 * Delete Face: one generic session whose references/parameters are a
 * {@link FeatureDraft} (see `featureTools.ts`), previewed like the other
 * kernel tools.
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
 * Tool sessions of the 3D modelling context. Sketching (Line, Arc, Circle,
 * Rectangle, …) happens in a sketch session instead (`sketch/session.ts`).
 */
export type ToolSession =
  | ExtrudeTool
  | MoveTool
  | EdgeBlendTool
  | ShellTool
  | BooleanTool
  | FeatureTool
  | PickTool;

/** Finishes a pick session (set by `pickSessionRunner.ts`: starts the command). */
let pickFinisher: (() => void) | null = null;
export function setPickFinisher(finish: (() => void) | null): void {
  pickFinisher = finish;
}

/** Tools that show a live kernel preview. */
export type PreviewTool = ExtrudeTool | EdgeBlendTool | ShellTool | BooleanTool | FeatureTool;

export function isPreviewTool(tool: ToolSession | null): tool is PreviewTool {
  return (
    tool?.kind === 'extrude' ||
    tool?.kind === 'edgeBlend' ||
    tool?.kind === 'shell' ||
    tool?.kind === 'boolean' ||
    tool?.kind === 'feature'
  );
}

/** Reserved feature id used only for the extrude tool's live preview; never committed. */
export const PREVIEW_EXTRUDE_FEATURE_ID = '__preview_extrude__';
/** Reserved feature id of the fillet/chamfer, shell and boolean tools' live previews; never committed. */
export const PREVIEW_FEATURE_ID = '__preview_feature__';

/** Default fillet radius / chamfer distance and shell thickness when a tool starts, mm. */
export const DEFAULT_BLEND_SIZE_MM = 1;
export const DEFAULT_SHELL_THICKNESS_MM = 1;

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
  beginExtrude: (profile: ExtrudeProfileRef) => void;
  setDistance: (distanceMm: number) => void;
  setExtrudeOperation: (operation: ExtrudeOperation) => void;
  /** Extent, sides, second distance, start offset, To Object target of the running Extrude. */
  setExtrudeOptions: (options: ExtrudeToolOptions) => void;
  beginMove: (bodyId: string) => void;
  setDelta: (dx: number, dy: number, dz: number) => void;
  /** Move/Rotate gizmo rings: degrees about world X, Y, Z through the pivot. */
  setRotation: (rx: number, ry: number, rz: number) => void;
  /** Moves the gizmo centre (rotation pivot). */
  setPivot: (pivot: Vec3) => void;
  /** Copy badge of the Move/Rotate tool. */
  setMoveCopy: (copy: boolean) => void;
  /** Gizmo orientation: unit axes, or `null` for world X/Y/Z. Keeps the move so far. */
  setMoveAxes: (axes: [Vec3, Vec3, Vec3] | null) => void;
  setMoveAutoOrient: (on: boolean) => void;
  /** Move/Rotate on a sketch profile (a region, or the whole sketch without `regionKey`). */
  beginMoveSketch: (featureId: string, regionKey?: string) => boolean;
  /** Starts a modelling-feature tool (Revolve, Sweep, Loft, …) with a live preview. */
  beginFeatureTool: (draft: FeatureDraft) => void;
  /** Starts `commandId` before its selection: the pill asks for the references (`pickSession.ts`). */
  beginPickSession: (commandId: string) => void;
  /** Updates the running pick session (a click, a removed badge, Swap, Next). */
  updatePickSession: (update: (session: PickSessionState) => PickSessionState) => void;
  /** Updates the running feature tool's draft (references/parameters) and re-previews. */
  updateFeatureDraft: (
    update: (draft: FeatureDraft, evaluation: EvaluationResult) => FeatureDraft,
  ) => void;
  /** `F` — starts the fillet/chamfer tool on the selected edges of one body (live preview). */
  beginEdgeBlend: (kind: 'fillet' | 'chamfer') => void;
  setBlendSize: (size: number) => void;
  setBlendKind: (kind: 'fillet' | 'chamfer') => void;
  /** Starts the fillet/chamfer tool on edges chosen by rule (face edges, concave/convex edges). */
  beginEdgeBlendByRule: (kind: 'fillet' | 'chamfer', rules: EdgeRule[]) => void;
  /** Variable radius, chamfer mode and second value of the running fillet/chamfer tool. */
  setBlendOptions: (options: {
    [K in 'radius2' | 'chamferMode' | 'distance2' | 'angle' | 'flip']?:
      | EdgeBlendTool[K]
      | undefined;
  }) => void;
  /** Inward/outward walls of the running shell tool. */
  setShellDirection: (direction: ShellDirection) => void;
  /** Printing clearance of an outward shell (the cavity is the body grown by it); 0 removes it. */
  setShellClearance: (clearance: number) => void;
  /** Adds/removes an open face while the shell tool runs. */
  toggleShellFace: (bodyId: string, faceKey: string) => void;
  /** Keep or consume the tool bodies of the running boolean tool. */
  setBooleanKeepTools: (keep: boolean) => void;
  /** Keep the target unchanged (result as a new body) in the running boolean tool. */
  setBooleanKeepTarget: (keep: boolean) => void;
  /** Swaps the target with the first tool body of the running boolean tool. */
  swapBooleanTarget: () => void;
  /** Adds/removes a tool body while the boolean tool runs. */
  toggleBooleanTool: (bodyId: string) => void;
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
    options?: { projectName?: string; referenceMeshes?: ReferenceMesh[]; parameters?: Parameter[] },
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

function buildProvisionalExtrude(
  tool: {
    profile: ExtrudeProfileRef;
    distance: number;
    operation: ExtrudeOperation;
    targetBodyId?: string;
  } & ExtrudeToolOptions,
): ExtrudeFeature {
  const extent =
    tool.extent === 'throughAll'
      ? { kind: 'throughAll' as const }
      : tool.extent === 'toObject' && tool.extentTarget
        ? { kind: 'toObject' as const, target: tool.extentTarget }
        : null;
  return {
    id: PREVIEW_EXTRUDE_FEATURE_ID,
    name: 'Extrude (preview)',
    suppressed: false,
    kind: 'extrude',
    profile: tool.profile,
    distance: tool.distance,
    symmetric: tool.sides === 'symmetric',
    operation: tool.operation,
    ...(tool.targetBodyId !== undefined ? { targetBodyId: tool.targetBodyId } : {}),
    ...(extent ? { extent } : {}),
    ...(tool.sides === 'two' && tool.distance2 !== undefined && tool.distance2 > 0
      ? { distance2: tool.distance2 }
      : {}),
    ...(tool.startOffset ? { startOffset: tool.startOffset } : {}),
  };
}

/** `false` while an extrude has nothing to build yet (zero distance, To Object without a target). */
function extrudeReady(tool: ExtrudeTool): boolean {
  if (tool.extent === 'toObject') return tool.extentTarget !== undefined;
  if (tool.extent === 'throughAll') return true;
  return tool.distance !== 0;
}

/** Provisional feature of a preview tool, or `null` when its parameters have no geometry yet. */
function buildProvisional(tool: PreviewTool): Feature | null {
  const base = { id: PREVIEW_FEATURE_ID, suppressed: false };
  switch (tool.kind) {
    case 'extrude':
      return extrudeReady(tool) ? buildProvisionalExtrude(tool) : null;
    case 'edgeBlend': {
      const rules = tool.rules && tool.rules.length > 0 ? { rules: tool.rules } : {};
      if (tool.blend === 'fillet') {
        return {
          ...base,
          name: 'Fillet (preview)',
          kind: 'fillet',
          edges: tool.edges,
          radius: tool.size,
          ...(tool.radius2 !== undefined ? { radius2: tool.radius2 } : {}),
          ...rules,
        };
      }
      const mode = tool.chamferMode ?? 'equal';
      return {
        ...base,
        name: 'Chamfer (preview)',
        kind: 'chamfer',
        edges: tool.edges,
        distance: tool.size,
        ...(mode !== 'equal' ? { mode } : {}),
        ...(mode === 'twoDistances' ? { distance2: tool.distance2 ?? tool.size * 2 } : {}),
        ...(mode === 'distanceAngle' ? { angle: tool.angle ?? 45 } : {}),
        ...(mode !== 'equal' && tool.flip ? { flip: true } : {}),
        ...rules,
      };
    }
    case 'shell':
      return {
        ...base,
        name: 'Shell (preview)',
        kind: 'shell',
        bodyId: tool.bodyId,
        faces: tool.faces,
        thickness: tool.thickness,
        ...(tool.direction === 'outside' ? { direction: 'outside' as const } : {}),
        ...(tool.direction === 'outside' && tool.clearance ? { clearance: tool.clearance } : {}),
      };
    case 'boolean':
      return {
        ...base,
        name: 'Boolean (preview)',
        kind: 'boolean',
        operation: tool.operation,
        targetBodyId: tool.targetBodyId,
        toolBodyIds: tool.toolBodyIds,
        ...(tool.keepTools ? { keepTools: true } : {}),
        ...(tool.keepTarget ? { keepTarget: true } : {}),
      };
    case 'feature':
      return draftToFeature(tool.draft, { id: PREVIEW_FEATURE_ID, name: 'Preview' });
  }
}

function featureToolPhase(draft: FeatureDraft): ToolPhase {
  return draftToFeature(draft, { id: PREVIEW_FEATURE_ID, name: '' })
    ? 'preview'
    : 'collectingReferences';
}

/** Box centre of a body, or the origin. */
function bodyCentre(evaluation: EvaluationResult, bodyId: string): Vec3 {
  const body = evaluation.bodies.find((b) => b.id === bodyId);
  if (!body) return [0, 0, 0];
  return [
    (body.min[0] + body.max[0]) / 2,
    (body.min[1] + body.max[1]) / 2,
    (body.min[2] + body.max[2]) / 2,
  ];
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
    set({ features: nextFeatures, rollbackBefore, ...extra });
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
    past = [...past, { features: state.features, parameters: state.parameters }];
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
          if (viaUndo) {
            past = past.slice(0, -1);
            future = [...future, { features: state.features, parameters: state.parameters }];
          } else if (featuresChanged) {
            past = [...past, { features: state.features, parameters: state.parameters }];
            future = [];
          }
          const marker =
            restore.rollbackBefore && restore.features.some((f) => f.id === restore.rollbackBefore)
              ? restore.rollbackBefore
              : null;
          set({
            features: restore.features,
            parameters: restore.parameters,
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
      future = [...future, { features: state.features, parameters: state.parameters }];
      setFeatures(previous.features, {
        parameters: previous.parameters,
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
      past = [...past, { features: state.features, parameters: state.parameters }];
      setFeatures(next.features, {
        parameters: next.parameters,
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
    beginExtrude: (profile) => {
      const state = get();
      let contact: SketchContact | null = null;
      if (profile.kind === 'sketch') {
        contact = findSketchContact(state.evaluation, profile.featureId, profile.regions);
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
      // A closed profile inside a body face starts as a through-cut (Shapr3D), previewed at once.
      const cutDepth =
        profile.kind === 'sketch' && contact
          ? extrudeStartDepth(
              state.evaluation,
              state.features,
              profile.featureId,
              profile.regions,
              contact,
            )
          : null;
      if (cutDepth !== null) {
        updatePreviewTool({ ...tool, phase: 'preview', distance: cutDepth, operation: 'cut' });
        return;
      }
      // A zero distance has no geometry to preview; the first drag/entry requests one.
      set({ activeTool: tool });
    },
    setDistance: (distanceMm) => {
      const tool = get().activeTool;
      if (!tool || tool.kind !== 'extrude') return;
      const operation =
        tool.operationLocked || tool.profile.kind === 'face'
          ? tool.profile.kind === 'face' && tool.operation !== 'intersect'
            ? distanceMm < 0
              ? 'cut'
              : 'join'
            : tool.operation
          : autoExtrudeOperation(tool.contact, distanceMm);
      updatePreviewTool({ ...tool, phase: 'preview', distance: distanceMm, operation });
    },
    setExtrudeOptions: (options) => {
      const tool = get().activeTool;
      if (tool?.kind !== 'extrude') return;
      const next: ExtrudeTool = { ...tool, ...options } as ExtrudeTool;
      for (const key of Object.keys(options) as (keyof ExtrudeToolOptions)[]) {
        if (options[key] === undefined) delete next[key];
      }
      if (next.extent !== 'toObject') delete next.extentTarget;
      if (next.sides === 'two' && next.distance2 === undefined) {
        next.distance2 = Math.max(MIN_FEATURE_SIZE_MM, Math.abs(next.distance) || 5);
      }
      // Through All / To Object need a direction: keep the sign, default into the material for a cut.
      if (next.extent && next.extent !== 'distance' && next.distance === 0) {
        next.distance = next.operation === 'cut' && next.contact ? -next.contact.sign : 1;
      }
      updatePreviewTool({ ...next, phase: 'preview' });
    },
    setExtrudeOperation: (operation) => {
      const tool = get().activeTool;
      if (!tool || tool.kind !== 'extrude') return;
      if (tool.profile.kind === 'face') {
        // Push/pull stays automatic except for Intersect.
        const next: ExtrudeTool = {
          ...tool,
          operation: operation === 'intersect' ? 'intersect' : tool.distance < 0 ? 'cut' : 'join',
          operationLocked: operation === 'intersect',
        };
        updatePreviewTool(next);
        return;
      }
      // Join/Cut need a target: the touched body, else the most recently changed one.
      const targetBodyId = tool.contact?.bodyId ?? tool.targetBodyId;
      const next: ExtrudeTool = { ...tool, operation, operationLocked: true };
      if (operation === 'new') delete next.targetBodyId;
      else if (targetBodyId !== undefined) next.targetBodyId = targetBodyId;
      updatePreviewTool(next);
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
        // Keep at least one edge (or rule).
        if (tool.edges.length === 1 && !(tool.rules && tool.rules.length > 0)) return;
        updatePreviewTool({ ...tool, edges: tool.edges.filter((e) => e.key !== edgeKey) });
        return;
      }
      const ref = makeEdgeRef(get().evaluation, bodyId, edgeKey);
      if (ref) updatePreviewTool({ ...tool, edges: [...tool.edges, ref] });
    },
    beginEdgeBlendByRule: (kind, rules) => {
      if (rules.length === 0) return;
      endPreview();
      updatePreviewTool({
        kind: 'edgeBlend',
        phase: 'preview',
        blend: kind,
        bodyId: edgeRuleBodyId(rules[0]!),
        edges: [],
        rules,
        size: DEFAULT_BLEND_SIZE_MM,
        ...NO_PREVIEW,
      });
    },
    setBlendOptions: (options) => {
      const tool = get().activeTool;
      if (tool?.kind !== 'edgeBlend') return;
      const next = { ...tool, ...options } as EdgeBlendTool;
      for (const key of Object.keys(options) as (keyof typeof options)[]) {
        if (options[key] === undefined) delete next[key];
      }
      updatePreviewTool(next);
    },
    setShellDirection: (direction) => {
      const tool = get().activeTool;
      if (tool?.kind !== 'shell') return;
      const next: ShellTool = { ...tool, direction };
      if (direction === 'inside') {
        delete next.direction;
        delete next.clearance; // a clearance only applies outwards
      }
      updatePreviewTool(next);
    },
    setShellClearance: (clearance) => {
      const tool = get().activeTool;
      if (tool?.kind !== 'shell' || !Number.isFinite(clearance)) return;
      const next: ShellTool = { ...tool, direction: 'outside', clearance };
      if (clearance <= 0) delete next.clearance;
      updatePreviewTool(next);
    },
    toggleShellFace: (bodyId, faceKey) => {
      const tool = get().activeTool;
      if (tool?.kind !== 'shell' || bodyId !== tool.bodyId) return;
      const present = tool.faces.some((f) => f.key === faceKey);
      if (present) {
        if (tool.faces.length === 1) return; // keep at least one open face
        updatePreviewTool({ ...tool, faces: tool.faces.filter((f) => f.key !== faceKey) });
        return;
      }
      const ref = makeFaceRef(get().evaluation, bodyId, faceKey);
      if (ref) updatePreviewTool({ ...tool, faces: [...tool.faces, ref] });
    },
    setBooleanKeepTools: (keep) => {
      const tool = get().activeTool;
      if (tool?.kind !== 'boolean') return;
      const next: BooleanTool = { ...tool, keepTools: keep };
      if (!keep) delete next.keepTools;
      updatePreviewTool(next);
    },
    setBooleanKeepTarget: (keep) => {
      const tool = get().activeTool;
      if (tool?.kind !== 'boolean') return;
      const next: BooleanTool = { ...tool, keepTarget: keep };
      if (!keep) delete next.keepTarget;
      updatePreviewTool(next);
    },
    swapBooleanTarget: () => {
      const tool = get().activeTool;
      if (tool?.kind !== 'boolean' || tool.toolBodyIds.length === 0) return;
      const [first, ...rest] = tool.toolBodyIds;
      updatePreviewTool({
        ...tool,
        targetBodyId: first!,
        toolBodyIds: [tool.targetBodyId, ...rest],
      });
    },
    toggleBooleanTool: (bodyId) => {
      const tool = get().activeTool;
      if (tool?.kind !== 'boolean' || bodyId === tool.targetBodyId) return;
      const present = tool.toolBodyIds.includes(bodyId);
      if (present && tool.toolBodyIds.length === 1) return; // keep at least one tool body
      updatePreviewTool({
        ...tool,
        toolBodyIds: present
          ? tool.toolBodyIds.filter((id) => id !== bodyId)
          : [...tool.toolBodyIds, bodyId],
      });
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
          rotation: { rx: 0, ry: 0, rz: 0 },
          pivot: bodyCentre(get().evaluation, bodyId),
          copy: false,
        },
      });
    },
    setDelta: (dx, dy, dz) => {
      const tool = get().activeTool;
      if (!tool || tool.kind !== 'move') return;
      const { problem: _problem, ...rest } = tool;
      set({ activeTool: { ...rest, phase: 'preview', delta: { dx, dy, dz } } });
    },
    setRotation: (rx, ry, rz) => {
      const tool = get().activeTool;
      if (tool?.kind !== 'move' || ![rx, ry, rz].every(Number.isFinite)) return;
      set({ activeTool: { ...tool, phase: 'preview', rotation: { rx, ry, rz } } });
    },
    setPivot: (pivot) => {
      const tool = get().activeTool;
      if (tool?.kind !== 'move' || !pivot.every(Number.isFinite)) return;
      set({ activeTool: { ...tool, pivot: [...pivot] } });
    },
    setMoveCopy: (copy) => {
      const tool = get().activeTool;
      if (tool?.kind !== 'move' || tool.sketch) return;
      set({ activeTool: { ...tool, copy } });
    },
    setMoveAxes: (axes) => {
      const tool = get().activeTool;
      if (tool?.kind !== 'move' || tool.sketch) return;
      const next: MoveTool = { ...tool };
      if (axes) next.axes = axes;
      else delete next.axes;
      // Rotations so far are kept as the transform they make (re-expressed about the new axes
      // only when none were made yet; otherwise the orientation waits for the next tool).
      if (tool.rotation.rx !== 0 || tool.rotation.ry !== 0 || tool.rotation.rz !== 0) return;
      set({ activeTool: next });
    },
    setMoveAutoOrient: (on) => {
      const tool = get().activeTool;
      if (tool?.kind !== 'move') return;
      set({ activeTool: { ...tool, autoOrient: on } });
    },
    beginMoveSketch: (featureId, regionKey) => {
      const state = get();
      const feature = state.features.find(
        (f): f is SketchFeature => f.id === featureId && f.kind === 'sketch',
      );
      const evaluated = state.evaluation.sketches.find((s) => s.featureId === featureId);
      if (!feature || !evaluated) return false;
      const frame = evaluated.frame;
      const centre = regionCentre(feature, regionKey);
      if (!centre) return false;
      endPreview();
      set({
        activeTool: {
          kind: 'move',
          phase: 'collectingReferences',
          bodyId: '',
          delta: { dx: 0, dy: 0, dz: 0 },
          rotation: { rx: 0, ry: 0, rz: 0 },
          pivot: [
            frame.origin[0] + frame.u[0] * centre[0] + frame.v[0] * centre[1],
            frame.origin[1] + frame.u[1] * centre[0] + frame.v[1] * centre[1],
            frame.origin[2] + frame.u[2] * centre[0] + frame.v[2] * centre[1],
          ],
          copy: false,
          // The gizmo lies in the sketch plane: u, v and the normal.
          axes: [frame.u, frame.v, frame.normal],
          sketch: { featureId, ...(regionKey !== undefined ? { regionKey } : {}), frame },
        },
      });
      return true;
    },
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

      if (tool.kind === 'extrude') {
        // "To Object" without its object (or a zero distance) has nothing to commit yet.
        if (!extrudeReady(tool)) return;
        const provisional = buildProvisionalExtrude(tool);
        const id = createFeatureId('extrude');
        const feature: ExtrudeFeature = {
          ...provisional,
          id,
          name: nextFeatureName('Extrude', state.features),
        };
        // The consumed profile is deselected (and so hidden again), like Shapr3D.
        commitChecked(feature, []);
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
        commitChecked(feature, [{ kind: 'feature', featureId: feature.id }]);
        return;
      }

      if (tool.kind === 'feature') {
        const kind = tool.draft.kind;
        const feature = draftToFeature(tool.draft, {
          id: createFeatureId(kind),
          name: nextFeatureName(featureKindLabel(kind), state.features),
        });
        if (!feature) return; // references still missing: the tool stays open
        commitChecked(feature, [{ kind: 'feature', featureId: feature.id }]);
        return;
      }

      const { rotation } = tool;
      if (tool.sketch) {
        const result = moveSketchResult(state.features, tool);
        if (!result.ok) {
          set({ activeTool: { ...tool, problem: result.reason } });
          return;
        }
        commitFeatures(
          state.features.map((f) => (f.id === result.feature.id ? result.feature : f)),
          [{ kind: 'sketchProfile', featureId: result.feature.id }],
        );
        return;
      }
      if (tool.copy || rotation.rx !== 0 || rotation.ry !== 0 || rotation.rz !== 0) {
        const transform: TransformFeature = {
          id: createFeatureId('transform'),
          name: nextFeatureName(featureKindLabel('transform'), state.features),
          suppressed: false,
          kind: 'transform',
          bodyId: tool.bodyId,
          // Rotations about an oriented gizmo become the equivalent world rotations.
          ...gizmoTransformFields(tool),
          copy: tool.copy,
        };
        commitFeatures([...state.features, transform]);
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
    },
    setDisplayMode: (mode) => set((s) => ({ viewState: { ...s.viewState, displayMode: mode } })),
    setViewToggle: (key, value) => set((s) => ({ viewState: { ...s.viewState, [key]: value } })),
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
          ...viewDisplayFromProject(view),
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
        rollbackBefore: null,
        referenceMeshes: options?.referenceMeshes ?? [],
        parameters: options?.parameters ?? [],
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

// Saved views carry the section state (`workspace.ts` `SavedSection`).
setSectionAccess({
  read: () => {
    const v = useAssemblerStore.getState().viewState;
    return {
      enabled: v.sectionEnabled,
      axis: v.sectionAxis,
      offset: v.sectionOffset,
      flipped: v.sectionFlipped,
      plane: v.sectionPlane,
      sectionOnly: v.sectionOnly,
    };
  },
  apply: (section) =>
    useAssemblerStore.setState((s) => ({
      viewState: {
        ...s.viewState,
        sectionEnabled: section.enabled,
        sectionAxis: section.axis,
        sectionOffset: section.offset,
        sectionFlipped: section.flipped,
        sectionPlane: section.plane,
        sectionOnly: section.enabled && section.sectionOnly,
      },
    })),
});

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
