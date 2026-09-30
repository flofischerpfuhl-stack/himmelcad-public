import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import type {
  Body,
  EvaluatedSketch,
  EvaluationResult,
} from '../../foundation/geometry-kernel/types.js';
import { MIN_FEATURE_SIZE_MM } from '../../foundation/document/document.js';
import { useSketchStore } from '../../modules/sketching/session.js';
import { SketchOverlay } from '../../modules/sketching/ui/SketchOverlay.js';
import { useSketchViewport } from '../../modules/sketching/ui/useSketchViewport.js';
import {
  consumedSketchIds,
  isSketchVisible,
  visibleBounds,
  type Bounds3,
} from '../../model/modeling.js';
import {
  isReferenceMeshBodyId,
  REFERENCE_MESH_ID_PREFIX,
  referenceMeshIdOf,
  referenceMeshToBody,
} from '../../foundation/commands/referenceMesh.js';
import {
  findFace,
  isPlanarFace,
  makeFaceRef,
  isPreviewTool,
  PREVIEW_FEATURE_ID,
  useAssemblerStore,
  type AssemblerState,
  type SelectionItem,
  type ToolSession,
} from '../../foundation/commands/store.js';
import { setViewportProbe } from './automation.js';
import { findAnchorPixel } from './automation.js';
import {
  BOX_FILTER_LABEL,
  BOX_FILTERS,
  boxFilterForKey,
  boxModeFor,
  mergeSelection,
  nextBoxFilter,
  normalizeRect,
  type BoxFilter,
} from './boxSelect.js';
import {
  DEFAULT_POSE,
  fitPose,
  isOrthographic,
  lerpPose,
  orbit as orbitPose,
  pan as panPose,
  poseFromDirection,
  presetPose,
  rollBy,
  viewProjectionMatrix,
  withFov,
  worldPerPixel as cameraWorldPerPixel,
  zoomTowards,
  type CameraPose,
  type CameraPresetName,
} from './camera.js';
import { cameraTargetBounds, faceFrameBounds } from './cameraTargets.js';
import { navigationPreset, resolveDrag } from '../input/navigation.js';
import { PickCandidatesPopup } from './PickCandidatesPopup.js';
import type { PickCandidate } from './pickCandidates.js';
import { SelectionBox } from './SelectionBox.js';
import { SelectThroughChip } from './SelectThroughChip.js';
import { boxSelectionIn, candidatesAt, type ViewportQueryContext } from './viewportQueries.js';
import { isAmbiguous } from './pickCandidates.js';
import { usePreferences } from '../input/preferences.js';
import {
  setCameraPoseProbe,
  useWorkspaceStore,
  type CameraCommand,
} from '../../interface/shell-ui/workspace.js';
import { displayBodyName, useItemsStore } from '../../foundation/commands/items.js';
import { subscribeViewportOverlays, viewportOverlayBatches } from './overlays.js';
import { DimensionLabel } from './DimensionLabel.js';
import { ViewportRenderer } from './gl.js';
import {
  closestPointOnLineToRay,
  projectToScreen,
  rayPlaneIntersect,
  unprojectRay,
  type Vec3,
} from './math.js';
import type { PickTarget, ToolHandleKind } from './picking.js';
import { buildScene, type BuiltScene, type SceneDatum, type SceneInput } from './scene.js';
import { encodePng } from '../../viewport/imageExport.js';
import { setImageRenderer, useViewportUi } from '../../model/viewportUi.js';
import { sectionAtFace } from '../../model/commands/displayCommands.js';
import { readViewportColors, type ViewportColors } from './theme.js';
import {
  blendHandle,
  handleTip,
  sectionClip,
  sectionHandle,
  sectionOffsetRange,
  shellHandle,
  type AxisHandle,
  type SectionView,
} from '../../viewport/toolAnchors.js';
import { bodyMaterials } from './displayModes.js';
import { MeasureOverlay } from '../../viewport/MeasureOverlay.js';
import { snapMeasurePoint, snapPoints, type Vec3 as MeasureVec3 } from '../../model/measure.js';
import { useMeasureStore } from '../../model/measureStore.js';
import { rayCastFaces } from './pickCandidates.js';
import { ViewCube } from './ViewCube.js';
import {
  ANGLE_SNAP_DEG,
  applyToolHandleValue,
  draftModifiedBodyIds,
  movePreviewBodies,
  pivotSnapPoint,
  toolHandleSet,
  type ToolChip,
  type ToolHandleSet,
} from '../../viewport/toolHandles.js';
import { acceptPick, draftDatumIds } from '../../model/featureTools.js';
import { applyFixPick, useFixStore } from '../../interface/shell-ui/fixReference.js';
import {
  WORLD_AXES,
  axesForPick,
  deltaAlong,
  isWorldAxes,
  withDeltaAlong,
} from '../../model/moveGizmo.js';
import { addPick } from '../../foundation/commands/pickSession.js';
import { emptyClickFinishes } from '../../foundation/commands/toolFinish.js';
import { adaptiveGridStep } from './gridResolution.js';

/**
 * The grid step to draw: the zoom-dependent resolution at the camera target
 * (published as `viewportUi.liveGridStep` for the read-out and sketch
 * snapping) unless the grid is locked (`viewState.gridAuto` off).
 */
function gridStepFor(
  view: { gridAuto: boolean; gridStep: number },
  pose: CameraPose,
  cssHeight: number,
): number {
  const live = adaptiveGridStep(cameraWorldPerPixel(pose, pose.distance, cssHeight));
  useViewportUi.getState().setLiveGridStep(live);
  return view.gridAuto ? live : view.gridStep;
}
import { errorHighlightOf } from './errorHighlight.js';
import type { AngleHandleState } from './scene.js';
import styles from './Viewport.module.css';

export interface ViewportProps {
  onContextMenu?: (e: { clientX: number; clientY: number; target: SelectionItem | null }) => void;
}

const CLICK_DRAG_THRESHOLD_PX = 4;
const DOUBLE_CLICK_MS = 400;
/** Matches `scene.ts`'s `MOVE_HANDLE_LENGTH_MM`. */
const HANDLE_LENGTH_MM = 40;
/** Drag values (fillet radius, shell thickness, section offset) snap to this step, mm. */
const HANDLE_STEP_MM = 0.1;
/** Pixel offsets probed when the gizmo centre is dragged (edges win within ~6 px). */
const PIVOT_PROBE: readonly [number, number][] = [
  [0, 0],
  ...[3, 6].flatMap((r) =>
    [0, 1, 2, 3, 4, 5, 6, 7].map((k): [number, number] => [
      Math.round(Math.cos((k * Math.PI) / 4) * r),
      Math.round(Math.sin((k * Math.PI) / 4) * r),
    ]),
  ),
];

function snap(value: number, step: number): number {
  return Math.round(value / step) * step;
}

/**
 * Pure (no React) extrude-anchor lookup, shared between the `extrudeAnchor`
 * memo (dimension label placement) and the render loop (arrow handle +
 * picking geometry), which reads fresh state every frame and must not rely
 * on a memoized value that could be stale relative to a `requestAnimationFrame`
 * closure captured before the tool/body changed.
 */
function computeExtrudeAnchor(
  tool: ToolSession | null,
  bodies: readonly Body[],
  sketches: readonly EvaluatedSketch[],
): { origin: Vec3; normal: Vec3 } | null {
  if (!tool || tool.kind !== 'extrude') return null;
  const { profile } = tool;
  // The arrow starts where the extrude starts (Start offset).
  const s = tool.startOffset ?? 0;
  const at = (p: Vec3, n: Vec3): Vec3 => [p[0] + n[0] * s, p[1] + n[1] * s, p[2] + n[2] * s];
  if (profile.kind === 'face') {
    const body = bodies.find((b) => b.id === profile.face.bodyId);
    const face = body ? findFace(body, profile.face.key) : undefined;
    if (!face?.normal) return null;
    return { origin: at(face.centroid, face.normal), normal: face.normal };
  }
  const sketch = sketches.find((s) => s.featureId === profile.featureId);
  if (!sketch) return null;
  const regions = profile.regions;
  const profiles = regions
    ? sketch.profiles.filter((p) => regions.includes(p.key))
    : sketch.profiles;
  if (profiles.length === 0) return null;
  const origin: [number, number, number] = [0, 0, 0];
  for (const p of profiles) {
    for (let i = 0; i < 3; i += 1) origin[i] = origin[i]! + p.center[i]! / profiles.length;
  }
  return { origin: at(origin, sketch.frame.normal), normal: sketch.frame.normal };
}

/** Pure (no React) move-anchor lookup (the gizmo centre before translation); see {@link computeExtrudeAnchor}. */
function computeMoveAnchor(tool: ToolSession | null, bodies: readonly Body[]): Vec3 | null {
  if (!tool || tool.kind !== 'move') return null;
  if (tool.sketch) return tool.pivot;
  if (!bodies.some((b) => b.id === tool.bodyId)) return null;
  return tool.pivot;
}

/** What the viewport shows for a store snapshot (committed model or the active tool's preview). */
interface SceneModel {
  bodies: readonly Body[];
  sketches: readonly EvaluatedSketch[];
  extrudePreviewBodyId: string | null;
  previewAccentBodyIds: string[];
  previewFaceKeyPrefix: string | null;
  ghostBodies: Body[];
  bounds: Bounds3 | null;
  handles: AxisHandle[];
  /** Feature-tool / Move-Rotate handles beyond the arrows (arcs, rings, chips, guides, pivot). */
  toolHandles: ToolHandleSet;
  previewNewBodyIds: string[];
  /** Construction planes/axes to draw (visible ones, with selection/hover state and Fix ghosts). */
  datums: SceneDatum[];
}

/** History "Fix…": the missing reference's last known place, drawn in the error colour. */
function fixGhostDatums(s: AssemblerState): SceneDatum[] {
  const session = useFixStore.getState().session;
  const ghost = session?.missing.ghost;
  if (!session || !ghost || s.activeTool) return [];
  const base = { featureId: `fix:${session.featureId}`, state: 'error' as const, ghost: true };
  if (ghost.kind === 'plane') {
    return [{ ...base, kind: 'plane', frame: ghost.frame, center: ghost.center, size: ghost.size }];
  }
  if (ghost.kind === 'axis') {
    const frame = { origin: ghost.point, u: ghost.dir, v: ghost.dir, normal: ghost.dir };
    return [{ ...base, kind: 'axis', frame, center: ghost.point, size: ghost.size }];
  }
  // A point: a small cross of two segments.
  const p = ghost.point;
  return (
    [
      [1, 0, 0],
      [0, 1, 0],
      [0, 0, 1],
    ] as Vec3[]
  ).map((dir, i) => ({
    ...base,
    featureId: `${base.featureId}:${i}`,
    kind: 'axis' as const,
    frame: { origin: p, u: dir, v: dir, normal: dir },
    center: p,
    size: 3,
  }));
}

/** Construction planes/axes of the shown evaluation, with their highlight state. */
function sceneDatums(s: AssemblerState, evaluation: EvaluationResult): SceneDatum[] {
  const items =
    s.activeTool?.kind === 'pick' ? [...s.selection, ...s.activeTool.picks.flat()] : s.selection;
  const selected = new Set(
    items.filter((i) => i.kind === 'datum').map((i) => (i as { featureId: string }).featureId),
  );
  // References a running feature tool holds (a mirror plane, a revolve axis) are highlighted too.
  if (s.activeTool?.kind === 'feature') {
    for (const id of draftDatumIds(s.activeTool.draft)) selected.add(id);
  }
  const hovered = s.hover?.kind === 'datum' ? s.hover.featureId : null;
  const out: SceneDatum[] = (evaluation.datums ?? [])
    .filter((d) => s.sketchVisibility[d.featureId] !== false || selected.has(d.featureId))
    .map((d) => ({
      featureId: d.featureId,
      kind: d.kind,
      frame: d.frame,
      center: d.center,
      size: d.size,
      state: selected.has(d.featureId)
        ? ('selected' as const)
        : hovered === d.featureId
          ? ('hovered' as const)
          : ('normal' as const),
    }));
  return [...out, ...fixGhostDatums(s)];
}

function sceneModel(s: AssemblerState): SceneModel {
  const tool = s.activeTool;
  const previewTool = isPreviewTool(tool) ? tool : null;
  const preview = previewTool?.previewEvaluation ?? null;
  let bodies = preview?.bodies ?? s.evaluation.bodies;
  // Reference meshes (imported STL) are never a kernel input — they are
  // appended straight onto the rendered body list here so the existing
  // draw/pick/hide pipeline (which operates generically on `Body[]`) shows
  // them, flat-shaded (their normals are per-triangle, not smoothed) and in
  // a visually distinct slate colour (`referenceMeshToBody`) — without
  // reaching into `gl.ts`'s shader.
  const visibleMeshBodies = s.referenceMeshes.filter((m) => !m.hidden).map(referenceMeshToBody);
  if (visibleMeshBodies.length > 0) bodies = [...bodies, ...visibleMeshBodies];
  let previewNewBodyIds: string[] = [];
  let moveGhosts: Body[] = [];
  if (tool?.kind === 'move') {
    const moved = movePreviewBodies(tool, bodies);
    bodies = moved.bodies;
    previewNewBodyIds = moved.newIds;
    moveGhosts = moved.ghosts;
  }
  let allSketches = preview?.sketches ?? s.evaluation.sketches;
  // Moving a sketch profile: its outline follows the gizmo (the commit re-evaluates it).
  if (tool?.kind === 'move' && tool.sketch) {
    const moved = tool.sketch;
    const d = tool.delta;
    const shift = (p: readonly number[]): [number, number, number] => [
      p[0]! + d.dx,
      p[1]! + d.dy,
      p[2]! + d.dz,
    ];
    allSketches = allSketches.map((sketch) => {
      if (sketch.featureId !== moved.featureId) return sketch;
      const hit = (key: string) => moved.regionKey === undefined || key === moved.regionKey;
      return {
        ...sketch,
        profiles: sketch.profiles.map((p) =>
          hit(p.key)
            ? {
                ...p,
                outline: p.outline.map(shift),
                holes: p.holes.map((h) => h.map(shift)),
                center: shift(p.center),
                triangles: p.triangles.map((v, i) =>
                  i % 3 === 0 ? v + d.dx : i % 3 === 1 ? v + d.dy : v + d.dz,
                ),
              }
            : p,
        ),
        curves:
          moved.regionKey === undefined
            ? sketch.curves.map((c) => ({ ...c, points: c.points.map(shift) }))
            : sketch.curves,
      };
    });
  }
  const consumed = consumedSketchIds(s.features);
  const extruding =
    tool?.kind === 'extrude' && tool.profile.kind === 'sketch' ? tool.profile.featureId : null;
  // The sketch being edited in sketch mode is drawn by the sketch overlay instead.
  const editing = useSketchStore.getState().session?.featureId ?? null;
  const sketches = allSketches.filter(
    (sketch) =>
      sketch.featureId !== editing &&
      (sketch.featureId === extruding ||
        isSketchVisible(sketch.featureId, consumed, s.sketchVisibility) ||
        s.selection.some((i) => i.kind === 'sketchProfile' && i.featureId === sketch.featureId) ||
        (s.hover?.kind === 'sketchProfile' && s.hover.featureId === sketch.featureId)),
  );

  let extrudePreviewBodyId: string | null = null;
  if (tool?.kind === 'extrude' && preview) {
    const before = new Set(s.evaluation.bodies.map((b) => b.id));
    const created = preview.bodies.find((b) => !before.has(b.id));
    extrudePreviewBodyId =
      created?.id ??
      (tool.profile.kind === 'face' ? tool.profile.face.bodyId : (tool.targetBodyId ?? null));
  }
  const previewAccentBodyIds: string[] = [];
  let previewFaceKeyPrefix: string | null = null;
  let ghostBodies: Body[] = [];
  if (preview && (tool?.kind === 'edgeBlend' || tool?.kind === 'shell')) {
    previewAccentBodyIds.push(tool.bodyId);
    previewFaceKeyPrefix = `${PREVIEW_FEATURE_ID}:`;
  } else if (preview && tool?.kind === 'boolean') {
    previewAccentBodyIds.push(tool.targetBodyId);
    ghostBodies = s.evaluation.bodies.filter((b) => tool.toolBodyIds.includes(b.id));
  } else if (preview && tool?.kind === 'feature') {
    const before = new Set(s.evaluation.bodies.map((b) => b.id));
    previewNewBodyIds = preview.bodies.filter((b) => !before.has(b.id)).map((b) => b.id);
    const modified = draftModifiedBodyIds(tool.draft);
    previewAccentBodyIds.push(...modified);
    previewFaceKeyPrefix = `${PREVIEW_FEATURE_ID}:`;
    // Bodies that move (align, mirror in place): their old place as a ghost.
    if (tool.draft.kind === 'align' || (tool.draft.kind === 'mirror' && !tool.draft.keepOriginal)) {
      ghostBodies = s.evaluation.bodies.filter((b) => modified.includes(b.id));
    }
  }
  if (moveGhosts.length > 0) ghostBodies = moveGhosts;

  const bounds = visibleBounds(s.evaluation.bodies, s.hiddenBodyIds, s.isolatedBodyIds);
  const handles: AxisHandle[] = [];
  if (tool?.kind === 'edgeBlend') {
    const handle = blendHandle(tool, s.evaluation.bodies);
    if (handle) handles.push(handle);
  } else if (tool?.kind === 'shell') {
    const handle = shellHandle(tool, s.evaluation.bodies);
    if (handle) handles.push(handle);
  }
  const toolHandles = toolHandleSet(s);
  handles.push(...toolHandles.axis);
  if (s.viewState.sectionEnabled && !s.viewState.sectionOnly) {
    handles.push(sectionHandle(sectionViewOf(s), bounds));
  }
  return {
    bodies,
    sketches,
    extrudePreviewBodyId,
    previewAccentBodyIds,
    previewFaceKeyPrefix,
    ghostBodies,
    bounds,
    handles,
    toolHandles,
    previewNewBodyIds,
    datums: sceneDatums(s, preview ?? s.evaluation),
  };
}

/** The section as `toolAnchors.ts` sees it (axis or face-aligned plane). */
function sectionViewOf(s: AssemblerState): SectionView {
  return {
    axis: s.viewState.sectionAxis,
    offset: s.viewState.sectionOffset,
    flipped: s.viewState.sectionFlipped,
    plane: s.viewState.sectionPlane,
  };
}

/** Features before the History rollback marker (the ones evaluated). */
function activeFeatureCount(s: AssemblerState): number {
  const index = s.rollbackBefore ? s.features.findIndex((f) => f.id === s.rollbackBefore) : -1;
  return index >= 0 ? index : s.features.length;
}

type DragMode =
  | { kind: 'none' }
  | { kind: 'orbit' }
  | { kind: 'pan' }
  | { kind: 'extrudeHandle'; origin: Vec3; normal: Vec3 }
  | {
      kind: 'moveAxis';
      origin: Vec3;
      axis: 0 | 1 | 2;
      /** The gizmo axis direction (world unless auto-oriented). */
      dir: Vec3;
      startDelta: { dx: number; dy: number; dz: number };
    }
  | {
      /** A plane tile: the move follows the pointer in the plane normal to `normal`. */
      kind: 'moveTile';
      origin: Vec3;
      normal: Vec3;
      hit0: Vec3;
      startDelta: { dx: number; dy: number; dz: number };
    }
  | {
      kind: 'axisHandle';
      handle: ToolHandleKind;
      origin: Vec3;
      dir: Vec3;
      t0: number;
      start: number;
    }
  | {
      /** Rotation ring / revolve or pattern arc: the value follows the pointer's angle about `axis`. */
      kind: 'angleHandle';
      handle: ToolHandleKind;
      center: Vec3;
      axis: Vec3;
      ref: Vec3;
      /** Pointer angle at the previous move (degrees), for unwrapping past ±180°. */
      last: number;
      /** Accumulated pointer rotation since the drag started (degrees). */
      turned: number;
      start: number;
    }
  | { kind: 'pivot' }
  /** Left drag from empty canvas: box selection (Shift adds). */
  | { kind: 'box'; additive: boolean };

interface PointerGesture {
  button: number;
  startX: number;
  startY: number;
  lastX: number;
  lastY: number;
  moved: boolean;
  mode: DragMode;
  pointerType: string;
}

/** Live box-selection rectangle (host-relative CSS px). */
interface BoxState {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  filter: BoxFilter;
}

/** Touch gesture: one finger orbits (long-press: menu, long-press + drag: box), two fingers pan and pinch-zoom. */
interface TouchGesture {
  mode: 'pending' | 'orbit' | 'pinch' | 'longPress' | 'box' | 'done';
  startX: number;
  startY: number;
  lastX: number;
  lastY: number;
  timer: ReturnType<typeof setTimeout> | null;
  pinch: { cx: number; cy: number; dist: number } | null;
}

const LONG_PRESS_MS = 500;
const TOUCH_SLOP_PX = 10;
/** Pointer radius for overlapping-pick candidates, CSS px (mouse / touch). */
const PICK_RADIUS_PX = 4;
const TOUCH_PICK_RADIUS_PX = 12;

function reduceMotion(): boolean {
  return (
    typeof window !== 'undefined' &&
    (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false)
  );
}

/** Centroid and spread of the first two touch points. */
function pinchOf(touches: Map<number, { x: number; y: number }>): {
  cx: number;
  cy: number;
  dist: number;
} {
  const [a, b] = [...touches.values()];
  if (!a || !b) return { cx: 0, cy: 0, dist: 0 };
  return { cx: (a.x + b.x) / 2, cy: (a.y + b.y) / 2, dist: Math.hypot(a.x - b.x, a.y - b.y) };
}

/** The pose projection settings ask for (`0` = orthographic). */
function preferredFov(): number {
  const prefs = usePreferences.getState();
  return prefs.projection === 'orthographic' ? 0 : prefs.fov;
}

type HandleHover =
  | { kind: 'extrudeHandle' }
  | { kind: 'moveHandle'; axis: 0 | 1 | 2 }
  | { kind: 'moveTile'; plane: 0 | 1 | 2 }
  | { kind: 'toolHandle'; handle: ToolHandleKind };

/** Angle (degrees) of the pointer ray's hit on the handle's plane, measured from `ref` about `axis`. */
function pointerAngle(
  h: { center: Vec3; axis: Vec3; ref: Vec3 },
  ray: { origin: Vec3; direction: Vec3 },
): number | null {
  const hit = rayPlaneIntersect(ray.origin, ray.direction, h.center, h.axis);
  if (!hit) return null;
  const rel: Vec3 = [hit[0] - h.center[0], hit[1] - h.center[1], hit[2] - h.center[2]];
  const u = h.ref;
  const v: Vec3 = [
    h.axis[1] * u[2] - h.axis[2] * u[1],
    h.axis[2] * u[0] - h.axis[0] * u[2],
    h.axis[0] * u[1] - h.axis[1] * u[0],
  ];
  const x = rel[0] * u[0] + rel[1] * u[1] + rel[2] * u[2];
  const y = rel[0] * v[0] + rel[1] * v[1] + rel[2] * v[2];
  if (Math.hypot(x, y) < 1e-9) return null;
  return (Math.atan2(y, x) * 180) / Math.PI;
}

/** Applies a dragged/typed handle value to the store (clamped, snapped). */
function applyHandleValue(handle: ToolHandleKind, raw: number, snapDrag = true): void {
  if (applyToolHandleValue(handle, raw, snapDrag)) return;
  const s = useAssemblerStore.getState();
  if (handle === 'blend') s.setBlendSize(Math.max(HANDLE_STEP_MM, snap(raw, HANDLE_STEP_MM)));
  else if (handle === 'shell')
    s.setShellThickness(Math.max(MIN_FEATURE_SIZE_MM, snap(raw, HANDLE_STEP_MM)));
  else {
    const bounds = visibleBounds(s.evaluation.bodies, s.hiddenBodyIds, s.isolatedBodyIds);
    const [lo, hi] = sectionOffsetRange(sectionViewOf(s), bounds);
    s.setSectionOffset(Math.min(hi, Math.max(lo, snap(raw, HANDLE_STEP_MM))));
  }
}

/**
 * The Assembler 3D viewport: WebGL2 scene (grid/axes/bodies/sketches),
 * Shapr3D-style orbit camera, click/hover picking, the view cube, and the
 * interactive tools' live previews and drag handles. Fills its parent
 * (`position: relative` host); the chrome places it full-bleed under the
 * floating islands.
 */
export function Viewport(props: ViewportProps): JSX.Element {
  const hostRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rendererRef = useRef<ViewportRenderer | null>(null);
  const colorsRef = useRef<ViewportColors | null>(null);
  const poseRef = useRef<CameraPose>(withFov(DEFAULT_POSE, preferredFov()));
  const animRef = useRef<{
    from: CameraPose;
    to: CameraPose;
    start: number;
    duration: number;
  } | null>(null);
  const dirtyRef = useRef(true);
  const sizeRef = useRef({ width: 1, height: 1, dpr: 1 });
  const gestureRef = useRef<PointerGesture | null>(null);
  const lastClickRef = useRef<{ time: number; x: number; y: number } | null>(null);
  const hoverRafRef = useRef<number | null>(null);
  const pendingHoverRef = useRef<{ x: number; y: number } | null>(null);
  const lastPickTableRef = useRef<BuiltScene['pickTable'] | null>(null);
  const didInitialFitRef = useRef(false);
  const frameWaitersRef = useRef<(() => void)[]>([]);
  /** CPU time of the last `buildScene` (DEV frame-time measurement). */
  const sceneMsRef = useRef(0);
  /** Handle hover state, set from the same hover-pick loop as body/face/edge hover but kept
   * out of the store (it's transient tool chrome, not a document selection concept). */
  const handleHoverRef = useRef<HandleHover | null>(null);
  /** Opens the active tool's value chip when the user starts typing a number. */
  const [editRequest, setEditRequest] = useState<{ nonce: number; text: string } | null>(null);

  const state = useAssemblerStore();
  const stateRef = useRef(state);
  stateRef.current = state;

  // Bumped once per drawn frame so JSX that reads camera/tool refs directly
  // (view cube orientation, dimension-label screen positions) re-renders in
  // step with the canvas instead of only on store changes.
  const [tick, setTick] = useState(0);

  useEffect(() => {
    dirtyRef.current = true;
  }, [state]);
  // The modules' overlays (Print mode: overhangs, thin walls, build volume) redraw on their own changes.
  useEffect(
    () =>
      subscribeViewportOverlays(() => {
        dirtyRef.current = true;
      }),
    [],
  );
  // History "Fix…" ghosts redraw with their session.
  useEffect(
    () =>
      useFixStore.subscribe(() => {
        dirtyRef.current = true;
      }),
    [],
  );

  // ---- GL lifecycle ---------------------------------------------------------
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    colorsRef.current = readViewportColors();
    try {
      rendererRef.current = new ViewportRenderer(canvas);
    } catch {
      rendererRef.current = null;
    }
    dirtyRef.current = true;
    return () => {
      rendererRef.current?.dispose();
      rendererRef.current = null;
    };
  }, []);

  // ---- Resize -------------------------------------------------------------
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const observer = new ResizeObserver(() => {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const width = Math.max(1, Math.round(host.clientWidth * dpr));
      const height = Math.max(1, Math.round(host.clientHeight * dpr));
      sizeRef.current = { width, height, dpr };
      rendererRef.current?.resize(width, height);
      // Frame the initial document once real viewport dimensions are known
      // (a "fit", 3/4 iso, comfortable margin) instead of opening on the
      // arbitrary fixed-distance `DEFAULT_POSE` — same framing math as
      // Ctrl+1 / "Zoom to fit" (`fitPose`), applied without an animation
      // so there's no pop on first paint.
      if (
        !didInitialFitRef.current &&
        host.clientWidth > 0 &&
        host.clientHeight > 0 &&
        stateRef.current.evaluation.bodies.length > 0
      ) {
        didInitialFitRef.current = true;
        const aspect = host.clientWidth / Math.max(1, host.clientHeight);
        poseRef.current = fitPose(
          stateRef.current.evaluation.bodies,
          withFov(DEFAULT_POSE, preferredFov()),
          aspect,
        );
      }
      dirtyRef.current = true;
    });
    observer.observe(host);
    return () => observer.disconnect();
  }, []);

  // The kernel evaluates asynchronously: frame the document once its first
  // bodies arrive (same "fit" framing as Ctrl+1, without animation).
  const firstBodies = state.evaluation.bodies;
  useEffect(() => {
    const host = hostRef.current;
    if (didInitialFitRef.current || !host || firstBodies.length === 0) return;
    if (host.clientWidth === 0 || host.clientHeight === 0) return;
    didInitialFitRef.current = true;
    poseRef.current = fitPose(
      firstBodies,
      withFov(DEFAULT_POSE, preferredFov()),
      host.clientWidth / host.clientHeight,
    );
    dirtyRef.current = true;
  }, [firstBodies]);

  // ---- Camera transitions ---------------------------------------------------
  /** Moves the camera to `next`: animated (ease-out, 300 ms) unless reduced motion or turned off. */
  const animateTo = useCallback((next: CameraPose, duration = 300) => {
    if (reduceMotion() || !usePreferences.getState().animateCamera) {
      animRef.current = null;
      poseRef.current = next;
    } else {
      animRef.current = { from: poseRef.current, to: next, start: performance.now(), duration };
    }
    dirtyRef.current = true;
  }, []);

  const hostAspect = useCallback((): number => {
    const host = hostRef.current;
    return host ? host.clientWidth / Math.max(1, host.clientHeight) : 1;
  }, []);

  /** Bodies drawn right now (hidden and isolated-away bodies excluded). */
  const visibleBodies = useCallback((): Body[] => {
    const s = useAssemblerStore.getState();
    const hidden = new Set(s.hiddenBodyIds);
    const isolated = s.isolatedBodyIds ? new Set(s.isolatedBodyIds) : null;
    return sceneModel(s).bodies.filter(
      (b) => !hidden.has(b.id) && (!isolated || isolated.has(b.id)),
    );
  }, []);

  // ---- Camera preset requests ----------------------------------------------
  const lastCameraNonce = useRef<number | null>(null);
  useEffect(() => {
    const request = state.viewState.cameraRequest;
    if (!request || request.nonce === lastCameraNonce.current) return;
    lastCameraNonce.current = request.nonce;
    const current = poseRef.current;
    const next =
      request.preset === 'fit'
        ? fitPose(visibleBodies(), current, hostAspect())
        : presetPose(request.preset, current);
    animateTo(next);
  }, [state.viewState.cameraRequest, animateTo, visibleBodies, hostAspect]);

  // ---- Workspace camera commands (home, fit selection, cube edges/corners, roll, saved views, look at face)
  const cameraCommand = useWorkspaceStore((s) => s.cameraCommand);
  const lastWorkspaceCameraNonce = useRef<number | null>(null);
  const applyCameraCommand = useCallback(
    (command: CameraCommand) => {
      const current = poseRef.current;
      const aspect = hostAspect();
      const s = useAssemblerStore.getState();
      let next: CameraPose | null = null;
      switch (command.kind) {
        case 'home':
          next = fitPose(visibleBodies(), presetPose('iso', current), aspect);
          break;
        case 'fitAll':
          next = fitPose(visibleBodies(), current, aspect);
          break;
        case 'fitSelection': {
          const bounds = cameraTargetBounds(sceneModel(s), s.selection);
          next = fitPose(bounds.length > 0 ? bounds : visibleBodies(), current, aspect);
          break;
        }
        case 'fitItems': {
          const bounds = cameraTargetBounds(sceneModel(s), command.items);
          if (bounds.length === 0) return;
          next = fitPose(bounds, current, aspect);
          break;
        }
        case 'direction':
          next = poseFromDirection(command.direction, current);
          break;
        case 'roll':
          next = rollBy(current, command.degrees);
          break;
        case 'pose':
          // A saved view keeps its framing; the projection stays the one chosen in Settings.
          next = withFov({ ...command.pose }, current.fov ?? preferredFov());
          break;
        case 'lookAlong':
          next = fitPose(visibleBodies(), poseFromDirection(command.direction, current), aspect);
          break;
        case 'lookAtFace': {
          const body = sceneModel(s).bodies.find((b) => b.id === command.bodyId);
          const face = body ? findFace(body, command.faceKey) : undefined;
          if (!body || !face) return;
          const oriented = face.normal ? poseFromDirection(face.normal, current) : current;
          const bounds = faceFrameBounds(body, face.key);
          next = bounds ? fitPose([bounds], oriented, aspect) : oriented;
          break;
        }
      }
      if (next) animateTo(next);
    },
    [animateTo, visibleBodies, hostAspect],
  );
  useEffect(() => {
    if (!cameraCommand || cameraCommand.nonce === lastWorkspaceCameraNonce.current) return;
    lastWorkspaceCameraNonce.current = cameraCommand.nonce;
    applyCameraCommand(cameraCommand.command);
  }, [cameraCommand, applyCameraCommand]);

  // ---- Projection / field of view / theme / pointer settings --------------------------------
  const projection = usePreferences((p) => p.projection);
  const fovSetting = usePreferences((p) => p.fov);
  const theme = usePreferences((p) => p.theme);
  useEffect(() => {
    const fov = projection === 'orthographic' ? 0 : fovSetting;
    if ((poseRef.current.fov ?? 45) === fov) return;
    animRef.current = null;
    poseRef.current = withFov(poseRef.current, fov);
    dirtyRef.current = true;
  }, [projection, fovSetting]);
  useEffect(() => {
    colorsRef.current = readViewportColors();
    dirtyRef.current = true;
  }, [theme]);
  const renderQuality = usePreferences((p) => p.renderQuality);
  useEffect(() => {
    dirtyRef.current = true;
  }, [renderQuality]);

  /** World point → host-relative CSS px (overlays), `null` behind the camera. */
  const projectHost = useCallback((point: readonly [number, number, number]) => {
    const host = hostRef.current;
    if (!host || host.clientWidth === 0 || host.clientHeight === 0) return null;
    const vp = viewProjectionMatrix(
      poseRef.current,
      host.clientWidth / Math.max(1, host.clientHeight),
    );
    return projectToScreen(vp, point, host.clientWidth, host.clientHeight);
  }, []);

  // The live camera, for "Save view".
  useEffect(() => {
    setCameraPoseProbe(() => poseRef.current);
    return () => setCameraPoseProbe(null);
  }, []);

  const selectThrough = useWorkspaceStore((s) => s.selectThrough);
  const [box, setBox] = useState<BoxState | null>(null);
  const boxRef = useRef<BoxState | null>(null);
  boxRef.current = box;
  const [popup, setPopup] = useState<{ x: number; y: number; candidates: PickCandidate[] } | null>(
    null,
  );
  /** Last pointer type seen: touch enlarges pick tolerances and edge hit ribbons. */
  const coarseRef = useRef(
    typeof window !== 'undefined' && (window.matchMedia?.('(pointer: coarse)').matches ?? false),
  );
  const touchesRef = useRef(new Map<number, { x: number; y: number }>());
  const touchRef = useRef<TouchGesture | null>(null);

  const activeTool = state.activeTool;
  const model = useMemo(() => sceneModel(state), [state]);

  /** The scene input of the current state for a drawing buffer of `size` (device px). */
  const sceneInputNow = useCallback(
    (size: { width: number; height: number; dpr: number }): SceneInput | null => {
      const colors = colorsRef.current;
      if (!colors) return null;
      const { width, height, dpr } = size;
      const aspect = width / Math.max(1, height);
      const current = useAssemblerStore.getState();
      const scene = sceneModel(current);
      const currentTool = current.activeTool;
      const handleHover = handleHoverRef.current;
      const extrudeAnchorNow = computeExtrudeAnchor(
        currentTool,
        current.evaluation.bodies,
        current.evaluation.sketches,
      );
      const moveAnchorNow = computeMoveAnchor(currentTool, current.evaluation.bodies);
      const extrudeHandle =
        currentTool?.kind === 'extrude' && extrudeAnchorNow
          ? {
              origin: extrudeAnchorNow.origin,
              normal: extrudeAnchorNow.normal,
              distance: currentTool.distance,
              hovered: handleHover?.kind === 'extrudeHandle',
            }
          : null;
      // While the gizmo centre is dragged onto geometry, arrows/rings step aside (not pickable).
      const pivotDragging = gestureRef.current?.mode.kind === 'pivot';
      const moveHandle =
        currentTool?.kind === 'move' && moveAnchorNow && !pivotDragging
          ? {
              origin: moveAnchorNow,
              delta: currentTool.delta,
              hoveredAxis: handleHover?.kind === 'moveHandle' ? handleHover.axis : null,
              ...(currentTool.axes ? { axes: currentTool.axes } : {}),
              // A sketch profile moves in its plane: no normal arrow, one tile (the sketch plane).
              ...(currentTool.sketch
                ? { hiddenAxes: [2] as (0 | 1 | 2)[], tiles: [2] as (0 | 1 | 2)[] }
                : { tiles: [0, 1, 2] as (0 | 1 | 2)[] }),
              hoveredTile: handleHover?.kind === 'moveTile' ? handleHover.plane : null,
            }
          : null;
      // The Move/Rotate preview body is already transformed in `sceneModel`.
      const movePreview = null;
      const ringColors = [colors.axisX, colors.axisY, colors.axisZ] as const;
      const angleHandles: AngleHandleState[] = (pivotDragging ? [] : scene.toolHandles.angles).map(
        (h) => ({
          ...h,
          color: h.handle.startsWith('ring:') ? ringColors[Number(h.handle.slice(5))]! : h.color,
          hovered: handleHover?.kind === 'toolHandle' && handleHover.handle === h.handle,
        }),
      );
      const moduleOverlays = viewportOverlayBatches({
        bodies: scene.bodies,
        hiddenBodyIds: current.hiddenBodyIds,
        isolatedBodyIds: current.isolatedBodyIds,
      });
      return {
        extraOverlays: moduleOverlays.surface,
        extraOverlaysLast: moduleOverlays.last,
        errorHighlight: errorHighlightOf(current),
        colors,
        pose: poseRef.current,
        aspect,
        viewportHeightPx: height,
        dpr,
        bodies: scene.bodies,
        sketches: scene.sketches,
        hiddenBodyIds: current.hiddenBodyIds,
        isolatedBodyIds: current.isolatedBodyIds,
        displayMode: current.viewState.displayMode,
        section: {
          enabled: current.viewState.sectionEnabled,
          axis: current.viewState.sectionAxis,
          offset: current.viewState.sectionOffset,
          flipped: current.viewState.sectionFlipped,
          bounds: scene.bounds,
          plane: current.viewState.sectionPlane,
          sectionOnly: current.viewState.sectionOnly,
        },
        edgesVisible: current.viewState.edgesVisible,
        hiddenEdgesVisible: current.viewState.hiddenEdgesVisible,
        axesVisible: current.viewState.axesVisible,
        materials: bodyMaterials(current.features, activeFeatureCount(current)),
        highQuality: usePreferences.getState().renderQuality === 'high',
        gridVisible: current.viewState.gridVisible,
        gridStep: gridStepFor(current.viewState, poseRef.current, height),
        // A pick session's references are shown like a selection.
        selection:
          currentTool?.kind === 'pick'
            ? [...current.selection, ...currentTool.picks.flat()]
            : current.selection,
        hover: current.hover,
        movePreview,
        extrudePreviewBodyId: scene.extrudePreviewBodyId,
        previewAccentBodyIds: scene.previewAccentBodyIds,
        previewFaceKeyPrefix: scene.previewFaceKeyPrefix,
        ghostBodies: scene.ghostBodies,
        extrudeHandle,
        moveHandle,
        axisHandles: scene.handles.map((h) => ({
          ...h,
          hovered: handleHover?.kind === 'toolHandle' && handleHover.handle === h.handle,
        })),
        // Sketch drawing previews are drawn by the sketch overlay (`sketch/ui/SketchOverlay.tsx`).
        sketchPreview: null,
        pickSketchLines:
          currentTool?.kind === 'feature' &&
          (currentTool.draft.kind === 'revolve' ||
            currentTool.draft.kind === 'rotateAxis' ||
            currentTool.draft.kind === 'pattern' ||
            currentTool.draft.kind === 'mirror' ||
            (currentTool.draft.kind === 'constructionPlane' &&
              currentTool.draft.mode === 'angle') ||
            currentTool.draft.kind === 'rib'),
        previewNewBodyIds: scene.previewNewBodyIds,
        angleHandles,
        guides: scene.toolHandles.guides,
        pivot: scene.toolHandles.pivot
          ? {
              point: scene.toolHandles.pivot,
              hovered:
                pivotDragging ||
                (handleHover?.kind === 'toolHandle' && handleHover.handle === 'pivot'),
              pickable: !pivotDragging,
            }
          : null,
        hitScale: coarseRef.current ? 2 : 1,
        datums: scene.datums,
      };
    },
    [],
  );

  // ---- Render loop ----------------------------------------------------------
  // Reads the store fresh on every dirty frame (no stale closures).
  useEffect(() => {
    let handle = 0;
    const loop = (now: number) => {
      handle = requestAnimationFrame(loop);
      const anim = animRef.current;
      if (anim) {
        const t = Math.min(1, (now - anim.start) / Math.max(1, anim.duration));
        const eased = 1 - Math.pow(1 - t, 3);
        poseRef.current = lerpPose(anim.from, anim.to, eased);
        dirtyRef.current = true;
        if (t >= 1) animRef.current = null;
      }
      if (!dirtyRef.current) return;
      dirtyRef.current = false;
      const renderer = rendererRef.current;
      const host = hostRef.current;
      const colors = colorsRef.current;
      if (!renderer || !host || !colors) return;
      const sceneStart = performance.now();
      const input = sceneInputNow(sizeRef.current);
      if (!input) return;
      const built = buildScene(input);
      const { dpr } = sizeRef.current;
      sceneMsRef.current = performance.now() - sceneStart;
      renderer.render(built.frame);
      renderer.renderPicking(
        built.frame.viewProj,
        built.idBatches,
        built.frame.clip,
        dpr,
        built.frame.depth?.lineBias ?? 5e-5,
      );
      lastPickTableRef.current = built.pickTable;
      setTick((v) => (v + 1) % 1_000_000);
      const waiters = frameWaitersRef.current;
      frameWaitersRef.current = [];
      for (const resolve of waiters) resolve();
    };
    handle = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(handle);
  }, [sceneInputNow]);

  // ---- Export image (File > Export image…) -------------------------------------
  useEffect(() => {
    setImageRenderer(
      async (request) => {
        const renderer = rendererRef.current;
        const host = hostRef.current;
        if (!renderer || !host) throw new Error('The 3D view is not available.');
        const max = renderer.maxImageSize();
        if (request.width > max || request.height > max) {
          throw new Error(`This graphics driver renders images up to ${max} × ${max} pixels.`);
        }
        // Line widths and handles keep their on-screen proportions: the image's
        // height is `dpr` × the viewport's height in CSS pixels.
        const dpr = request.height / Math.max(1, host.clientHeight);
        const input = sceneInputNow({ width: request.width, height: request.height, dpr });
        if (!input) throw new Error('The 3D view is not ready.');
        const built = buildScene({
          ...input,
          forExport: true,
          hover: null,
          gridVisible: input.gridVisible && request.grid,
          axesVisible: (input.axesVisible ?? true) && request.grid,
          extrudeHandle: null,
          moveHandle: null,
          axisHandles: [],
          angleHandles: [],
          guides: null,
          pivot: null,
        });
        const pixels = renderer.renderImage(
          built.frame,
          request.width,
          request.height,
          request.transparent,
        );
        dirtyRef.current = true;
        return { png: await encodePng(pixels, request.width, request.height), ...request };
      },
      () => {
        const { dpr } = sizeRef.current;
        const host = hostRef.current;
        return { width: host?.clientWidth ?? 0, height: host?.clientHeight ?? 0, dpr };
      },
    );
    return () => setImageRenderer(null, null);
  }, [sceneInputNow]);

  // ---- Picking helpers ------------------------------------------------------
  const pickAt = useCallback((clientX: number, clientY: number): PickTarget | null => {
    const renderer = rendererRef.current;
    const host = hostRef.current;
    const table = lastPickTableRef.current;
    if (!renderer || !host || !table) return null;
    const rect = host.getBoundingClientRect();
    const { dpr } = sizeRef.current;
    const px = (clientX - rect.left) * dpr;
    const py = (clientY - rect.top) * dpr;
    const id = renderer.readPickPixel(px, py);
    if (id === 0) return null;
    return table.resolve(id);
  }, []);

  const selectionFromPick = useCallback(
    (pick: PickTarget | null, wholeBody: boolean): SelectionItem | null => {
      if (!pick) return null;
      if (
        pick.kind === 'extrudeHandle' ||
        pick.kind === 'moveHandle' ||
        pick.kind === 'moveTile' ||
        pick.kind === 'toolHandle' ||
        pick.kind === 'sketchLine'
      )
        return null;
      if (pick.kind === 'sketchProfile') {
        return {
          kind: 'sketchProfile',
          featureId: pick.featureId,
          ...(pick.regionKey !== undefined && !wholeBody ? { regionKey: pick.regionKey } : {}),
        };
      }
      if (pick.kind === 'datum') return pick;
      // A reference mesh is always selected as a whole — never per-face
      // (it has exactly one synthetic whole-mesh "face" for picking, see
      // `referenceMeshToBody`, but that must never surface as a face
      // selection).
      if ('bodyId' in pick && isReferenceMeshBodyId(pick.bodyId)) {
        return { kind: 'mesh', meshId: pick.bodyId.slice(REFERENCE_MESH_ID_PREFIX.length) };
      }
      if (wholeBody) return { kind: 'body', bodyId: pick.bodyId };
      return pick;
    },
    [],
  );

  const rayAtClient = useCallback((clientX: number, clientY: number) => {
    const host = hostRef.current;
    if (!host) return null;
    const rect = host.getBoundingClientRect();
    const aspect = rect.width / Math.max(1, rect.height);
    const vp = viewProjectionMatrix(poseRef.current, aspect);
    return unprojectRay(vp, clientX - rect.left, clientY - rect.top, rect.width, rect.height);
  }, []);

  /** World point where the pointer ray meets a picked planar face's plane (hole placement). */
  const facePickPoint = useCallback(
    (item: { bodyId: string; faceKey: string }, clientX: number, clientY: number): Vec3 | null => {
      const face = useAssemblerStore
        .getState()
        .evaluation.bodies.find((b) => b.id === item.bodyId)
        ?.faces.find((f) => f.key === item.faceKey);
      const ray = rayAtClient(clientX, clientY);
      if (!face?.normal || !ray) return null;
      const n = face.normal;
      const denom = n[0] * ray.direction[0] + n[1] * ray.direction[1] + n[2] * ray.direction[2];
      if (Math.abs(denom) < 1e-9) return null;
      const rel: Vec3 = [
        face.centroid[0] - ray.origin[0],
        face.centroid[1] - ray.origin[1],
        face.centroid[2] - ray.origin[2],
      ];
      const t = (n[0] * rel[0] + n[1] * rel[1] + n[2] * rel[2]) / denom;
      return [
        ray.origin[0] + ray.direction[0] * t,
        ray.origin[1] + ray.direction[1] * t,
        ray.origin[2] + ray.direction[2] * t,
      ];
    },
    [rayAtClient],
  );

  // Sketch mode: camera normal to the sketch plane + the overlay's screen mapping.
  const sketch = useSketchViewport({ hostRef, poseRef, animRef, dirtyRef, rayAtClient, pickAt });

  const extrudeAnchor = useMemo(
    () => computeExtrudeAnchor(activeTool, state.evaluation.bodies, state.evaluation.sketches),
    [activeTool, state.evaluation.bodies, state.evaluation.sketches],
  );

  const moveAnchor = useMemo(
    () => computeMoveAnchor(activeTool, state.evaluation.bodies),
    [activeTool, state.evaluation.bodies],
  );

  /**
   * Handle drags are hit-tested via the picking buffer (the arrow's own
   * rendered geometry, registered in `scene.ts`'s id pass) rather than
   * screen-space proximity to the dimension-label tip — the handle is a
   * real draggable object, not just "near the number".
   */
  const findHandleHit = useCallback(
    (clientX: number, clientY: number): DragMode | null => {
      const current = useAssemblerStore.getState();
      const tool = current.activeTool;
      const pick = pickAt(clientX, clientY);
      if (!pick) return null;
      if (pick.kind === 'extrudeHandle' && tool?.kind === 'extrude' && extrudeAnchor) {
        return {
          kind: 'extrudeHandle',
          origin: extrudeAnchor.origin,
          normal: extrudeAnchor.normal,
        };
      }
      if (pick.kind === 'moveHandle' && tool?.kind === 'move' && moveAnchor) {
        const dir = (tool.axes ?? WORLD_AXES)[pick.axis]!;
        return {
          kind: 'moveAxis',
          origin: moveAnchor,
          axis: pick.axis,
          dir,
          startDelta: tool.delta,
        };
      }
      if (pick.kind === 'moveTile' && tool?.kind === 'move' && moveAnchor) {
        const normal = (tool.axes ?? WORLD_AXES)[pick.plane]!;
        const centre: Vec3 = [
          moveAnchor[0] + tool.delta.dx,
          moveAnchor[1] + tool.delta.dy,
          moveAnchor[2] + tool.delta.dz,
        ];
        const ray = rayAtClient(clientX, clientY);
        const hit0 = ray ? rayPlaneIntersect(ray.origin, ray.direction, centre, normal) : null;
        if (!hit0) return null;
        return { kind: 'moveTile', origin: centre, normal, hit0, startDelta: tool.delta };
      }
      if (pick.kind === 'toolHandle' && pick.handle === 'pivot') return { kind: 'pivot' };
      const angle =
        pick.kind === 'toolHandle'
          ? sceneModel(current).toolHandles.angles.find((h) => h.handle === pick.handle)
          : undefined;
      if (angle) {
        const ray = rayAtClient(clientX, clientY);
        const at = ray ? pointerAngle(angle, ray) : null;
        if (at === null) return null;
        return {
          kind: 'angleHandle',
          handle: angle.handle,
          center: angle.center,
          axis: angle.axis,
          ref: angle.ref,
          last: at,
          turned: 0,
          start: angle.value,
        };
      }
      if (pick.kind === 'toolHandle') {
        const handle = sceneModel(current).handles.find((h) => h.handle === pick.handle);
        const ray = rayAtClient(clientX, clientY);
        if (!handle || !ray) return null;
        const t0 = closestPointOnLineToRay(handle.base, handle.dragDir, ray.origin, ray.direction);
        return {
          kind: 'axisHandle',
          handle: handle.handle,
          origin: handle.base,
          dir: handle.dragDir,
          t0,
          start: handle.value,
        };
      }
      return null;
    },
    [extrudeAnchor, moveAnchor, pickAt, rayAtClient],
  );

  // ---- Selection helpers (box, overlapping picks) ------------------------------
  const queryContext = useCallback((): ViewportQueryContext | null => {
    const renderer = rendererRef.current;
    const host = hostRef.current;
    const table = lastPickTableRef.current;
    if (!renderer || !host || !table) return null;
    return {
      renderer,
      table,
      width: host.clientWidth,
      height: host.clientHeight,
      dpr: sizeRef.current.dpr,
      pose: poseRef.current,
      bodies: visibleBodies(),
      sketches: sceneModel(useAssemblerStore.getState()).sketches,
    };
  }, [visibleBodies]);

  const candidateNames = useCallback(() => {
    const s = useAssemblerStore.getState();
    const meta = useItemsStore.getState();
    return {
      bodyName: (bodyId: string) => {
        const meshId = referenceMeshIdOf(bodyId);
        if (meshId !== null) return s.referenceMeshes.find((m) => m.id === meshId)?.name ?? 'Mesh';
        const body = s.evaluation.bodies.find((b) => b.id === bodyId);
        return body ? displayBodyName(body, meta) : bodyId;
      },
      sketchName: (featureId: string) =>
        s.features.find((f) => f.id === featureId)?.name ?? 'Sketch',
    };
  }, []);

  const [popupAdditive, setPopupAdditive] = useState(false);

  /** Measure > Points: the snapped world point under the pointer becomes a measured point. */
  const pickMeasurePoint = useCallback(
    (clientX: number, clientY: number, touch: boolean) => {
      const host = hostRef.current;
      if (!host) return;
      const rect = host.getBoundingClientRect();
      const bodies = visibleBodies();
      const vp = viewProjectionMatrix(poseRef.current, rect.width / Math.max(1, rect.height));
      const project = (p: MeasureVec3): [number, number] | null => {
        const s = projectToScreen(vp, p, rect.width, rect.height);
        return s ? [s[0], s[1]] : null;
      };
      const ray = rayAtClient(clientX, clientY);
      let surface: MeasureVec3 | null = null;
      if (ray) {
        const s = useAssemblerStore.getState();
        const clip = s.viewState.sectionEnabled ? sectionClip(sectionViewOf(s)) : null;
        for (const hit of rayCastFaces(bodies, ray)) {
          const dir = ray.direction;
          const p: MeasureVec3 = [
            ray.origin[0] + dir[0] * hit.t,
            ray.origin[1] + dir[1] * hit.t,
            ray.origin[2] + dir[2] * hit.t,
          ];
          // Faces cut away by Section View are not there to click.
          if (
            clip &&
            p[0] * clip.normal[0] + p[1] * clip.normal[1] + p[2] * clip.normal[2] > clip.offset
          ) {
            continue;
          }
          surface = p;
          break;
        }
      }
      const snapped = snapMeasurePoint(
        snapPoints(bodies),
        project,
        [clientX - rect.left, clientY - rect.top],
        touch ? 20 : 10,
        surface,
      );
      if (snapped) useMeasureStore.getState().addPoint(snapped.point, snapped.label);
    },
    [visibleBodies, rayAtClient],
  );

  /** A click (mouse/pen button 0, or a touch tap) in the viewport. */
  const handleClick = useCallback(
    (clientX: number, clientY: number, additive: boolean, touch: boolean) => {
      const now = performance.now();
      const last = lastClickRef.current;
      const isDouble =
        !!last &&
        now - last.time < DOUBLE_CLICK_MS &&
        Math.hypot(clientX - last.x, clientY - last.y) < (touch ? 24 : 8);
      lastClickRef.current = { time: now, x: clientX, y: clientY };

      const store = useAssemblerStore.getState();
      const tool = store.activeTool;
      // Measure > Points: clicks place measured points (snapped to vertices,
      // midpoints and circle centres near the pointer, else on the face).
      if (!tool && store.viewState.measureEnabled && useMeasureStore.getState().pointMode) {
        pickMeasurePoint(clientX, clientY, touch);
        return;
      }
      const pick = pickAt(clientX, clientY);
      // Section > Face: the clicked planar face becomes the section plane.
      if (!tool && useViewportUi.getState().sectionFacePick) {
        if (pick?.kind === 'face' && isPlanarFace(store.evaluation, pick.bodyId, pick.faceKey)) {
          sectionAtFace(store, pick.bodyId, pick.faceKey);
          useViewportUi.getState().setSectionFacePick(false);
        } else {
          useWorkspaceStore.getState().notify('Click a planar face for the section plane.');
        }
        return;
      }
      // Tool before selection: clicks fill the pick session's reference steps.
      if (tool?.kind === 'pick') {
        const item = selectionFromPick(pick, isDouble);
        if (item && item.kind !== 'feature' && item.kind !== 'mesh') {
          store.updatePickSession((session) =>
            addPick(session, item, { evaluation: store.evaluation }),
          );
        }
        return;
      }
      // Extrude "To Object": a clicked face (double-click: body) becomes the object.
      if (tool?.kind === 'extrude' && tool.extent === 'toObject') {
        const item = selectionFromPick(pick, isDouble);
        if (item?.kind === 'face') {
          const face = makeFaceRef(store.evaluation, item.bodyId, item.faceKey);
          if (face) store.setExtrudeOptions({ extentTarget: { kind: 'face', face } });
        } else if (item?.kind === 'body') {
          store.setExtrudeOptions({ extentTarget: { kind: 'body', bodyId: item.bodyId } });
        }
        return;
      }
      // History "Fix…": the click is the replacement reference.
      if (!tool && useFixStore.getState().session) {
        const item = selectionFromPick(pick, isDouble);
        if (item) void applyFixPick(item);
        return;
      }
      if (tool?.kind === 'edgeBlend' || tool?.kind === 'shell' || tool?.kind === 'boolean') {
        // Adaptive tools: clicking empty space finishes (Shapr3D; `emptyClickFinishes`,
        // shown in the tool pill); edges add/remove.
        if (!pick) {
          if (emptyClickFinishes(tool)) store.commit();
        } else if (pick.kind === 'edge' && tool.kind === 'edgeBlend') {
          store.toggleBlendEdge(pick.bodyId, pick.edgeKey);
        } else if (pick.kind === 'face' && tool.kind === 'shell') {
          // Faces to open can be added/removed while the shell tool runs.
          store.toggleShellFace(pick.bodyId, pick.faceKey);
        } else if (tool.kind === 'boolean' && (pick.kind === 'face' || pick.kind === 'edge')) {
          store.toggleBooleanTool(pick.bodyId);
        }
        return;
      }
      if (tool?.kind === 'feature') {
        const ray = rayAtClient(clientX, clientY);
        const toolRay = ray
          ? {
              origin: [ray.origin[0], ray.origin[1], ray.origin[2]] as [number, number, number],
              direction: [ray.direction[0], ray.direction[1], ray.direction[2]] as [
                number,
                number,
                number,
              ],
            }
          : undefined;
        // Clicking empty space finishes (once complete); clicks edit the tool's references.
        if (!pick) {
          // …except a click into a through hole of the Hole tool, which removes that hole.
          const draft = tool.draft;
          if (draft.kind === 'hole' && draft.face && toolRay) {
            const face = draft.face;
            const before = draft;
            store.updateFeatureDraft((d, evaluation) =>
              acceptPick(
                d,
                { kind: 'face', bodyId: face.bodyId, faceKey: face.key, ray: toolRay },
                evaluation,
                store.features,
              ),
            );
            const after = useAssemblerStore.getState().activeTool;
            if (after?.kind === 'feature' && after.draft !== before) return;
          }
          if (emptyClickFinishes(tool)) store.commit();
          return;
        }
        if (pick.kind === 'sketchLine') {
          store.updateFeatureDraft((draft, evaluation) =>
            acceptPick(draft, pick, evaluation, store.features),
          );
          return;
        }
        const item = selectionFromPick(pick, isDouble);
        // A reference mesh is never a valid feature-tool reference (it has
        // no B-rep faces/edges for OCCT to consume — `apps/assembler/README.md`
        // "STL import": excluded from kernel operations).
        if (item && item.kind !== 'feature' && item.kind !== 'mesh') {
          // Where a face was clicked (e.g. a hole position): the ray on the face's plane.
          const point = item.kind === 'face' ? facePickPoint(item, clientX, clientY) : null;
          const toolPick =
            item.kind === 'face'
              ? {
                  ...item,
                  ...(point
                    ? { point: [point[0], point[1], point[2]] as [number, number, number] }
                    : {}),
                  ...(toolRay ? { ray: toolRay } : {}),
                }
              : item.kind === 'edge' && toolRay
                ? { ...item, ray: toolRay }
                : item;
          store.updateFeatureDraft((draft, evaluation) =>
            acceptPick(draft, toolPick, evaluation, store.features),
          );
        }
        return;
      }
      const ws = useWorkspaceStore.getState();
      if (!isDouble && !tool) {
        // Overlapping geometry (or Select Through): let the user choose.
        const ctx = queryContext();
        const host = hostRef.current;
        if (ctx && host) {
          const rect = host.getBoundingClientRect();
          const x = clientX - rect.left;
          const y = clientY - rect.top;
          const candidates = candidatesAt(ctx, x, y, {
            radius: touch ? TOUCH_PICK_RADIUS_PX : PICK_RADIUS_PX,
            selectThrough: ws.selectThrough,
            names: candidateNames(),
          });
          if (isAmbiguous(candidates, ws.selectThrough)) {
            setPopupAdditive(additive);
            setPopup({ x, y, candidates });
            return;
          }
          if (!pick && candidates.length === 1) {
            store.select(candidates[0]!.item, { additive });
            return;
          }
        }
      }
      if (!pick) {
        if (!additive) store.clearSelection();
        return;
      }
      // Double-clicking a sketch opens it in sketch mode (Shapr3D).
      if (isDouble && pick.kind === 'sketchProfile') {
        useSketchStore.getState().begin({ featureId: pick.featureId });
        return;
      }
      const item = selectionFromPick(pick, isDouble);
      if (!item) return;
      store.select(item, { additive });
    },
    [
      pickAt,
      selectionFromPick,
      queryContext,
      candidateNames,
      facePickPoint,
      rayAtClient,
      pickMeasurePoint,
    ],
  );

  const contextMenuAt = useCallback(
    (clientX: number, clientY: number) => {
      const pick = pickAt(clientX, clientY);
      props.onContextMenu?.({ clientX, clientY, target: selectionFromPick(pick, false) });
    },
    [pickAt, props, selectionFromPick],
  );

  /** Finishes a box drag: selects what the rectangle encloses (drag right) or touches (drag left). */
  const finishBox = useCallback(
    (additive: boolean) => {
      const current = boxRef.current;
      setBox(null);
      if (!current) return;
      const ctx = queryContext();
      if (!ctx) return;
      const rect = normalizeRect(current.x0, current.y0, current.x1, current.y1);
      const mode = boxModeFor(current.x0, current.x1);
      const result = boxSelectionIn(
        ctx,
        rect,
        mode,
        current.filter,
        useWorkspaceStore.getState().selectThrough,
      );
      const store = useAssemblerStore.getState();
      store.setSelection(mergeSelection(store.selection, result, additive));
    },
    [queryContext],
  );

  const updateBox = useCallback((startX: number, startY: number, x: number, y: number) => {
    const host = hostRef.current;
    if (!host) return;
    const rect = host.getBoundingClientRect();
    setBox((previous) => ({
      x0: startX - rect.left,
      y0: startY - rect.top,
      x1: x - rect.left,
      y1: y - rect.top,
      filter: previous?.filter ?? 'all',
    }));
  }, []);

  // While a box is dragged: Tab cycles the filter, A/B/F/E pick one, Escape cancels.
  const boxActive = box !== null;
  useEffect(() => {
    if (!boxActive) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopImmediatePropagation();
        gestureRef.current = null;
        if (touchRef.current) touchRef.current.mode = 'done';
        setBox(null);
        return;
      }
      const current = boxRef.current;
      if (!current) return;
      let next: BoxFilter | null = null;
      if (event.key === 'Tab') next = nextBoxFilter(current.filter, event.shiftKey);
      else if (!event.ctrlKey && !event.metaKey && !event.altKey) next = boxFilterForKey(event.key);
      if (!next) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      const filter = next;
      setBox((b) => (b ? { ...b, filter } : b));
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [boxActive]);

  // ---- Touch: one finger orbits, two fingers pan + pinch-zoom, tap selects (taps add up),
  // double tap selects the body, long press opens the context menu, long press + drag boxes.
  const onTouchDown = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    coarseRef.current = true;
    hostRef.current?.setPointerCapture(event.pointerId);
    animRef.current = null;
    const touches = touchesRef.current;
    touches.set(event.pointerId, { x: event.clientX, y: event.clientY });
    const current = touchRef.current;
    if (touches.size === 1) {
      const gesture: TouchGesture = {
        mode: 'pending',
        startX: event.clientX,
        startY: event.clientY,
        lastX: event.clientX,
        lastY: event.clientY,
        timer: null,
        pinch: null,
      };
      gesture.timer = setTimeout(() => {
        if (touchRef.current === gesture && gesture.mode === 'pending') gesture.mode = 'longPress';
      }, LONG_PRESS_MS);
      touchRef.current = gesture;
    } else if (touches.size === 2 && current) {
      if (current.timer) clearTimeout(current.timer);
      if (current.mode === 'box') setBox(null);
      current.mode = 'pinch';
      current.pinch = pinchOf(touches);
    }
  }, []);

  const onTouchMove = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      const touches = touchesRef.current;
      const gesture = touchRef.current;
      const host = hostRef.current;
      if (!touches.has(event.pointerId) || !gesture || !host) return;
      touches.set(event.pointerId, { x: event.clientX, y: event.clientY });
      if (gesture.mode === 'pinch' && touches.size >= 2 && gesture.pinch) {
        const next = pinchOf(touches);
        const previous = gesture.pinch;
        poseRef.current = panPose(
          poseRef.current,
          next.cx - previous.cx,
          next.cy - previous.cy,
          host.clientHeight,
        );
        if (previous.dist > 0 && next.dist > 0) {
          const ray = rayAtClient(next.cx, next.cy);
          const anchor = ray
            ? rayPlaneIntersect(ray.origin, ray.direction, poseRef.current.target, [0, 0, 1])
            : null;
          poseRef.current = zoomTowards(poseRef.current, previous.dist / next.dist, anchor);
        }
        gesture.pinch = next;
        dirtyRef.current = true;
        return;
      }
      if (touches.size !== 1) return;
      const dx = event.clientX - gesture.lastX;
      const dy = event.clientY - gesture.lastY;
      gesture.lastX = event.clientX;
      gesture.lastY = event.clientY;
      const moved =
        Math.hypot(event.clientX - gesture.startX, event.clientY - gesture.startY) > TOUCH_SLOP_PX;
      if (gesture.mode === 'pending' && moved) {
        if (gesture.timer) clearTimeout(gesture.timer);
        gesture.mode = 'orbit';
      } else if (gesture.mode === 'longPress' && moved) {
        gesture.mode = 'box';
      }
      if (gesture.mode === 'orbit') {
        poseRef.current = orbitPose(poseRef.current, dx, dy);
        dirtyRef.current = true;
      } else if (gesture.mode === 'box') {
        updateBox(gesture.startX, gesture.startY, event.clientX, event.clientY);
      }
    },
    [rayAtClient, updateBox],
  );

  const onTouchUp = useCallback(
    (event: React.PointerEvent<HTMLDivElement>, cancelled: boolean) => {
      const touches = touchesRef.current;
      touches.delete(event.pointerId);
      const gesture = touchRef.current;
      if (!gesture) return;
      if (touches.size > 0) {
        // Lifting one of two fingers ends the pinch; the remaining finger does nothing.
        if (gesture.mode === 'pinch') gesture.mode = 'done';
        return;
      }
      if (gesture.timer) clearTimeout(gesture.timer);
      touchRef.current = null;
      if (cancelled) {
        setBox(null);
        return;
      }
      if (gesture.mode === 'pending') handleClick(event.clientX, event.clientY, true, true);
      else if (gesture.mode === 'longPress') contextMenuAt(event.clientX, event.clientY);
      else if (gesture.mode === 'box') finishBox(true);
    },
    [contextMenuAt, finishBox, handleClick],
  );

  // ---- Pointer handlers -----------------------------------------------------
  const onPointerDown = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      const host = hostRef.current;
      if (!host) return;
      if (popup) setPopup(null);
      if (event.pointerType === 'touch') {
        onTouchDown(event);
        return;
      }
      coarseRef.current = false;
      host.setPointerCapture(event.pointerId);
      animRef.current = null;

      const preset = navigationPreset(usePreferences.getState().navigationPreset);
      const action = resolveDrag(preset, event.button, {
        shift: event.shiftKey,
        ctrl: event.ctrlKey || event.metaKey,
        alt: event.altKey,
      });
      let mode: DragMode = { kind: 'none' };
      if (action === 'orbit') mode = { kind: 'orbit' };
      else if (action === 'pan') mode = { kind: 'pan' };
      else if (event.button === 0) {
        const handleHit = findHandleHit(event.clientX, event.clientY);
        if (handleHit) mode = handleHit;
        else if (
          !useAssemblerStore.getState().activeTool &&
          pickAt(event.clientX, event.clientY) === null
        ) {
          // Dragging from empty canvas draws a selection box.
          mode = { kind: 'box', additive: event.shiftKey };
        }
      }
      gestureRef.current = {
        button: event.button,
        startX: event.clientX,
        startY: event.clientY,
        lastX: event.clientX,
        lastY: event.clientY,
        moved: false,
        mode,
        pointerType: event.pointerType,
      };
      if (mode.kind === 'pivot') dirtyRef.current = true;
    },
    [findHandleHit, pickAt, onTouchDown, popup],
  );

  const onPointerMove = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      if (event.pointerType === 'touch') {
        onTouchMove(event);
        return;
      }
      const store = useAssemblerStore.getState();
      const gesture = gestureRef.current;
      if (!gesture) {
        pendingHoverRef.current = { x: event.clientX, y: event.clientY };
        if (hoverRafRef.current === null) {
          hoverRafRef.current = requestAnimationFrame(() => {
            hoverRafRef.current = null;
            const pending = pendingHoverRef.current;
            if (!pending) return;
            const pick = pickAt(pending.x, pending.y);
            if (
              pick?.kind === 'extrudeHandle' ||
              pick?.kind === 'moveHandle' ||
              pick?.kind === 'moveTile' ||
              pick?.kind === 'toolHandle'
            ) {
              const nextHover: HandleHover =
                pick.kind === 'extrudeHandle' ? { kind: 'extrudeHandle' } : pick;
              if (JSON.stringify(handleHoverRef.current) !== JSON.stringify(nextHover)) {
                handleHoverRef.current = nextHover;
                dirtyRef.current = true;
              }
              if (stateRef.current.hover) stateRef.current.setHover(null);
              return;
            }
            if (handleHoverRef.current) {
              handleHoverRef.current = null;
              dirtyRef.current = true;
            }
            const item = selectionFromPick(pick, false);
            const current = stateRef.current.hover;
            const changed =
              (current === null) !== (item === null) ||
              (current !== null &&
                item !== null &&
                JSON.stringify(current) !== JSON.stringify(item));
            if (changed) stateRef.current.setHover(item);
          });
        }
        return;
      }

      const dx = event.clientX - gesture.lastX;
      const dy = event.clientY - gesture.lastY;
      gesture.lastX = event.clientX;
      gesture.lastY = event.clientY;
      if (
        !gesture.moved &&
        Math.hypot(event.clientX - gesture.startX, event.clientY - gesture.startY) >
          CLICK_DRAG_THRESHOLD_PX
      ) {
        gesture.moved = true;
      }
      if (!gesture.moved) return;

      const host = hostRef.current;
      const height = host?.clientHeight ?? 800;
      const mode = gesture.mode;
      if (mode.kind === 'box') {
        updateBox(gesture.startX, gesture.startY, event.clientX, event.clientY);
      } else if (mode.kind === 'orbit') {
        poseRef.current = orbitPose(poseRef.current, dx, dy);
        dirtyRef.current = true;
      } else if (mode.kind === 'pan') {
        poseRef.current = panPose(poseRef.current, dx, dy, height);
        dirtyRef.current = true;
      } else if (mode.kind === 'extrudeHandle') {
        const ray = rayAtClient(event.clientX, event.clientY);
        if (ray) {
          const t = closestPointOnLineToRay(mode.origin, mode.normal, ray.origin, ray.direction);
          store.setDistance(t);
          dirtyRef.current = true;
        }
      } else if (mode.kind === 'moveAxis') {
        const ray = rayAtClient(event.clientX, event.clientY);
        if (ray) {
          // The component along the (possibly oriented) axis follows the pointer; the rest stays.
          const unit = mode.dir;
          const t = closestPointOnLineToRay(mode.origin, unit, ray.origin, ray.direction);
          const d = mode.startDelta;
          const k = t - (d.dx * unit[0] + d.dy * unit[1] + d.dz * unit[2]);
          store.setDelta(d.dx + unit[0] * k, d.dy + unit[1] * k, d.dz + unit[2] * k);
          dirtyRef.current = true;
        }
      } else if (mode.kind === 'moveTile') {
        const ray = rayAtClient(event.clientX, event.clientY);
        const hit = ray
          ? rayPlaneIntersect(ray.origin, ray.direction, mode.origin, mode.normal)
          : null;
        if (hit) {
          const d = mode.startDelta;
          const step = (v: number) => Math.round(v * 1000) / 1000;
          store.setDelta(
            step(d.dx + hit[0] - mode.hit0[0]),
            step(d.dy + hit[1] - mode.hit0[1]),
            step(d.dz + hit[2] - mode.hit0[2]),
          );
          dirtyRef.current = true;
        }
      } else if (mode.kind === 'axisHandle') {
        const ray = rayAtClient(event.clientX, event.clientY);
        if (ray) {
          const t = closestPointOnLineToRay(mode.origin, mode.dir, ray.origin, ray.direction);
          applyHandleValue(mode.handle, mode.start + (t - mode.t0));
          dirtyRef.current = true;
        }
      } else if (mode.kind === 'angleHandle') {
        const ray = rayAtClient(event.clientX, event.clientY);
        const at = ray ? pointerAngle(mode, ray) : null;
        if (at !== null) {
          let step = at - mode.last;
          if (step > 180) step -= 360;
          if (step < -180) step += 360;
          mode.turned += step;
          mode.last = at;
          // 15° steps like Shapr3D's gizmo; Shift rotates freely (0.1°).
          const snapStep = event.shiftKey ? 0.1 : ANGLE_SNAP_DEG;
          const value = Math.round((mode.start + mode.turned) / snapStep) * snapStep;
          applyHandleValue(mode.handle, value, false);
          dirtyRef.current = true;
        }
      } else if (mode.kind === 'pivot') {
        const tool = store.activeTool;
        // Prefer an edge within a few pixels (circle centres, edge midpoints), else the face below.
        let target: PickTarget | null = null;
        for (const [ox, oy] of PIVOT_PROBE) {
          const pick = pickAt(event.clientX + ox, event.clientY + oy);
          if (pick?.kind === 'edge') {
            target = pick;
            break;
          }
          if (!target && pick?.kind === 'face') target = pick;
        }
        const point = pivotSnapPoint(target, store.evaluation.bodies);
        if (tool?.kind === 'move' && point) {
          store.setPivot([
            point[0] - tool.delta.dx,
            point[1] - tool.delta.dy,
            point[2] - tool.delta.dz,
          ]);
          // Auto-orientation (Shapr3D gizmo): the gizmo takes the axes of the geometry below it.
          if (tool.autoOrient !== false && !tool.sketch) {
            const axes = axesForPick(target, store.evaluation.bodies);
            if (axes) store.setMoveAxes(axes);
          }
          dirtyRef.current = true;
        }
      }
    },
    [pickAt, rayAtClient, selectionFromPick, onTouchMove, updateBox],
  );

  const onPointerUp = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      if (event.pointerType === 'touch') {
        onTouchUp(event, false);
        return;
      }
      const gesture = gestureRef.current;
      gestureRef.current = null;
      if (!gesture) return;
      if (gesture.mode.kind === 'pivot') dirtyRef.current = true; // gizmo handles come back

      if (gesture.mode.kind === 'box') {
        if (gesture.moved) {
          finishBox(gesture.mode.additive);
          return;
        }
        setBox(null);
      } else if (gesture.moved) {
        return; // a real drag never selects/opens the context menu
      }

      if (gesture.button === 2) {
        contextMenuAt(event.clientX, event.clientY);
        return;
      }
      if (gesture.button !== 0) return;
      if (gesture.mode.kind !== 'none' && gesture.mode.kind !== 'box') return; // a handle click

      // Settings › Selection extension: every click adds, like touch taps (Shapr3D, macOS).
      handleClick(
        event.clientX,
        event.clientY,
        event.shiftKey || usePreferences.getState().selectionExtension,
        false,
      );
    },
    [contextMenuAt, finishBox, handleClick, onTouchUp],
  );

  const onWheel = useCallback(
    (event: React.WheelEvent<HTMLDivElement>) => {
      animRef.current = null;
      const factor = Math.exp(event.deltaY * 0.0012);
      const ray = rayAtClient(event.clientX, event.clientY);
      const anchor = ray
        ? rayPlaneIntersect(ray.origin, ray.direction, poseRef.current.target, [0, 0, 1])
        : null;
      poseRef.current = zoomTowards(poseRef.current, factor, anchor);
      dirtyRef.current = true;
    },
    [rayAtClient],
  );

  const onCubePreset = useCallback((preset: CameraPresetName) => {
    stateRef.current.requestCamera(preset);
  }, []);
  const sendCamera = useCallback(
    (command: CameraCommand) => useWorkspaceStore.getState().sendCamera(command),
    [],
  );
  const onPopupHover = useCallback(
    (candidate: PickCandidate | null) =>
      useAssemblerStore.getState().setHover(candidate ? candidate.item : null),
    [],
  );
  const onPopupClose = useCallback(() => setPopup(null), []);

  // Space over a face (or with one face selected): look straight at it and frame it (Shapr3D).
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== ' ' || event.ctrlKey || event.metaKey || event.altKey || event.repeat) {
        return;
      }
      const target = event.target;
      if (
        target instanceof HTMLElement &&
        (target.isContentEditable ||
          ['INPUT', 'TEXTAREA', 'SELECT', 'BUTTON', 'A'].includes(target.tagName) ||
          target.closest('[role="menu"],[role="dialog"]'))
      ) {
        return;
      }
      if (useSketchStore.getState().session) return;
      const s = useAssemblerStore.getState();
      if (s.activeTool?.phase === 'numericEditing') return;
      const only = s.selection.length === 1 ? s.selection[0] : undefined;
      const face = s.hover?.kind === 'face' ? s.hover : only?.kind === 'face' ? only : null;
      if (!face || face.kind !== 'face') return;
      event.preventDefault();
      applyCameraCommand({ kind: 'lookAtFace', bodyId: face.bodyId, faceKey: face.faceKey });
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [applyCameraCommand]);

  const onCubeOrbitDrag = useCallback((dxPixels: number, dyPixels: number) => {
    animRef.current = null;
    poseRef.current = orbitPose(poseRef.current, dxPixels, dyPixels);
    dirtyRef.current = true;
  }, []);

  // Typing a number while a tool waits for a value opens its dimension chip.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      const target = event.target;
      if (
        target instanceof HTMLElement &&
        (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName))
      ) {
        return;
      }
      if (event.ctrlKey || event.metaKey || event.altKey || !/^[0-9.-]$/.test(event.key)) return;
      const tool = useAssemblerStore.getState().activeTool;
      // Only extrude and feature values (offsets, angles) take negatives.
      if (event.key === '-' && tool?.kind !== 'extrude' && tool?.kind !== 'feature') return;
      const handleSet =
        tool?.kind === 'feature' ? toolHandleSet(useAssemblerStore.getState()) : null;
      const featureValue = handleSet !== null && handleSet.axis.length + handleSet.chips.length > 0;
      const accepts =
        tool?.kind === 'edgeBlend' ||
        tool?.kind === 'shell' ||
        tool?.kind === 'extrude' ||
        featureValue;
      if (!accepts || !tool || tool.phase === 'numericEditing') return;
      event.preventDefault();
      setEditRequest((previous) => ({ nonce: (previous?.nonce ?? 0) + 1, text: event.key }));
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  // ---- Dev automation probe (see devtools/automationHook.ts) ------------------
  useEffect(() => {
    if (!import.meta.env.DEV) return;
    setViewportProbe({
      project: (point) => {
        const host = hostRef.current;
        if (!host) return null;
        const rect = host.getBoundingClientRect();
        const vp = viewProjectionMatrix(poseRef.current, rect.width / Math.max(1, rect.height));
        const screen = projectToScreen(vp, point, rect.width, rect.height);
        return screen ? { x: rect.left + screen[0], y: rect.top + screen[1] } : null;
      },
      anchor: (predicate) => {
        const renderer = rendererRef.current;
        const host = hostRef.current;
        const table = lastPickTableRef.current;
        if (!renderer || !host || !table) return null;
        const ids = new Set(table.findIds(predicate));
        if (ids.size === 0) return null;
        const buffer = renderer.readPickBuffer();
        const pixel = buffer ? findAnchorPixel(buffer, ids) : null;
        if (!pixel) return null;
        const rect = host.getBoundingClientRect();
        const { dpr } = sizeRef.current;
        return { x: rect.left + (pixel.x + 0.5) / dpr, y: rect.top + (pixel.y + 0.5) / dpr };
      },
      nextFrame: () =>
        new Promise<void>((resolve) => {
          frameWaitersRef.current.push(resolve);
          dirtyRef.current = true;
        }),
      stats: (finish) => {
        const renderer = rendererRef.current;
        if (renderer && finish !== undefined) renderer.finishEachFrame = finish;
        const stats = renderer?.renderStats() ?? {
          frames: 0,
          lastCpuMs: 0,
          uploadsLastFrame: 0,
          cachedBuffers: 0,
          cachedBytes: 0,
          drawCalls: 0,
          ambientOcclusion: false,
          shadowMap: false,
        };
        return { ...stats, sceneMs: sceneMsRef.current };
      },
      benchmark: (frames) => {
        // Back-to-back frames (scene build + render, orbiting 0.5° each) and
        // one GPU sync at the end: the sustained cost per frame without vsync.
        const renderer = rendererRef.current;
        if (!renderer) return null;
        const start = poseRef.current;
        renderer.sync();
        const t0 = performance.now();
        for (let i = 0; i < frames; i += 1) {
          poseRef.current = { ...start, yaw: start.yaw + (i * Math.PI) / 360 };
          const input = sceneInputNow(sizeRef.current);
          if (!input) break;
          renderer.render(buildScene(input).frame);
        }
        renderer.sync();
        const perFrame = (performance.now() - t0) / Math.max(1, frames);
        poseRef.current = start;
        dirtyRef.current = true;
        return perFrame;
      },
    });
    return () => setViewportProbe(null);
  }, [sceneInputNow]);

  // ---- Dimension chips (screen positions recomputed every drawn frame via `tick`) ----
  const overlay = useMemo(() => {
    void tick;
    const host = hostRef.current;
    if (!host) return null;
    const rect = { width: host.clientWidth, height: host.clientHeight };
    if (rect.width === 0 || rect.height === 0) return null;
    const aspect = rect.width / Math.max(1, rect.height);
    const vp = viewProjectionMatrix(poseRef.current, aspect);
    const project = (p: Vec3) => projectToScreen(vp, p, rect.width, rect.height);

    const handleChips = model.handles
      .filter((h) => !h.handle.startsWith('feature:') && h.handle !== 'extrude2')
      .map((h) => ({ handle: h, screen: project(handleTip(h)) }));

    if (activeTool?.kind === 'extrude' && extrudeAnchor) {
      const tip: Vec3 = [
        extrudeAnchor.origin[0] + extrudeAnchor.normal[0] * activeTool.distance,
        extrudeAnchor.origin[1] + extrudeAnchor.normal[1] * activeTool.distance,
        extrudeAnchor.origin[2] + extrudeAnchor.normal[2] * activeTool.distance,
      ];
      return {
        kind: 'extrude' as const,
        handleChips,
        screen: project(tip),
        distance: activeTool.distance,
        // Through All / To Object: the distance only gives the direction (no value chip).
        showDistance: (activeTool.extent ?? 'distance') === 'distance',
      };
    }
    if (activeTool?.kind === 'move' && moveAnchor) {
      const centre: Vec3 = [
        moveAnchor[0] + activeTool.delta.dx,
        moveAnchor[1] + activeTool.delta.dy,
        moveAnchor[2] + activeTool.delta.dz,
      ];
      const hiddenAxes: number[] = activeTool.sketch ? [2] : [];
      const oriented = !isWorldAxes(activeTool.axes);
      const axisLabels = ([0, 1, 2] as const)
        .filter((i) => !hiddenAxes.includes(i))
        .map((axisIndex) => {
          const unit = (activeTool.axes ?? WORLD_AXES)[axisIndex]!;
          const tip: Vec3 = [
            centre[0] + unit[0] * HANDLE_LENGTH_MM,
            centre[1] + unit[1] * HANDLE_LENGTH_MM,
            centre[2] + unit[2] * HANDLE_LENGTH_MM,
          ];
          return {
            axis: axisIndex,
            oriented,
            value: deltaAlong(activeTool, axisIndex),
            screen: project(tip),
          };
        });
      return { kind: 'move' as const, handleChips, axisLabels };
    }
    return { kind: 'handles' as const, handleChips };
  }, [tick, activeTool, extrudeAnchor, moveAnchor, model.handles]);

  // Feature-tool and rotation-ring chips (same per-frame screen projection).
  const toolChips = useMemo(() => {
    void tick;
    const host = hostRef.current;
    if (!host || host.clientWidth === 0 || host.clientHeight === 0) return [];
    const vp = viewProjectionMatrix(
      poseRef.current,
      host.clientWidth / Math.max(1, host.clientHeight),
    );
    return model.toolHandles.chips.map((chip) => ({
      chip,
      screen: projectToScreen(vp, chip.at, host.clientWidth, host.clientHeight),
    }));
  }, [tick, model.toolHandles]);

  const beginNumericEditing = useCallback(
    () => useAssemblerStore.getState().beginNumericEditing(),
    [],
  );
  const endNumericEditing = useCallback(() => useAssemblerStore.getState().endNumericEditing(), []);

  const previewError = isPreviewTool(activeTool) ? activeTool.previewError : null;
  const chipRequest = (kind: ToolSession['kind']) =>
    activeTool?.kind === kind ? editRequest : null;

  return (
    <div
      ref={hostRef}
      className={styles.host}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={(event) => {
        if (event.pointerType === 'touch') {
          onTouchUp(event, true);
          return;
        }
        gestureRef.current = null;
        setBox(null);
      }}
      onWheel={onWheel}
      onContextMenu={(event) => event.preventDefault()}
    >
      <canvas
        ref={canvasRef}
        className={styles.canvas}
        role="application"
        aria-label="3D modeling viewport"
      />
      <ViewCube
        pose={poseRef.current}
        onPreset={onCubePreset}
        onDirection={(direction) => sendCamera({ kind: 'direction', direction })}
        onHome={() => sendCamera({ kind: 'home' })}
        onFit={() => sendCamera({ kind: 'fitAll' })}
        onRoll={(degrees) => sendCamera({ kind: 'roll', degrees })}
        onOrbitDrag={onCubeOrbitDrag}
        orthographic={isOrthographic(poseRef.current)}
        onToggleProjection={() => {
          const prefs = usePreferences.getState();
          prefs.setPreference(
            'projection',
            prefs.projection === 'orthographic' ? 'perspective' : 'orthographic',
          );
        }}
        onSaveView={() => useWorkspaceStore.getState().saveCurrentView()}
      />
      {selectThrough ? (
        <SelectThroughChip onTurnOff={() => useWorkspaceStore.getState().setSelectThrough(false)} />
      ) : null}
      {box ? (
        <SelectionBox
          x0={box.x0}
          y0={box.y0}
          x1={box.x1}
          y1={box.y1}
          mode={boxModeFor(box.x0, box.x1)}
          filterLabel={BOX_FILTER_LABEL[box.filter]}
          filters={BOX_FILTERS.map((f) => ({
            label:
              f === 'all' ? 'All' : f === 'bodies' ? 'Bodies' : f === 'faces' ? 'Faces' : 'Edges',
            key: f === 'all' ? 'A' : f[0]!.toUpperCase(),
            active: f === box.filter,
          }))}
          hint="Tab cycles"
        />
      ) : null}
      {popup ? (
        <PickCandidatesPopup
          x={popup.x}
          y={popup.y}
          hostWidth={hostRef.current?.clientWidth ?? 0}
          hostHeight={hostRef.current?.clientHeight ?? 0}
          candidates={popup.candidates}
          onHover={onPopupHover}
          onChoose={(candidate) => {
            useAssemblerStore.getState().select(candidate.item, { additive: popupAdditive });
            setPopup(null);
          }}
          onClose={onPopupClose}
        />
      ) : null}
      {sketch.session ? <SketchOverlay api={sketch.api} tick={tick} /> : null}
      {state.viewState.measureEnabled ? <MeasureOverlay tick={tick} project={projectHost} /> : null}
      {overlay?.handleChips.map(({ handle, screen }) => {
        if (!screen) return null;
        const label =
          handle.handle === 'section'
            ? 'Section offset'
            : handle.handle === 'shell'
              ? 'Wall thickness'
              : activeTool?.kind === 'edgeBlend' && activeTool.blend === 'chamfer'
                ? 'Chamfer distance'
                : 'Fillet radius';
        const prefix =
          handle.handle === 'section'
            ? state.viewState.sectionPlane
              ? 'Offset'
              : `${state.viewState.sectionAxis} =`
            : handle.handle === 'blend' && activeTool?.kind === 'edgeBlend'
              ? activeTool.blend === 'fillet'
                ? 'R'
                : 'D'
              : 'T';
        return (
          <DimensionLabel
            key={handle.handle}
            label={label}
            prefix={prefix}
            value={handle.value}
            x={screen[0]}
            y={screen[1] - 18}
            invalid={handle.handle !== 'section' && previewError !== null}
            editRequest={
              handle.handle === 'blend'
                ? chipRequest('edgeBlend')
                : handle.handle === 'shell'
                  ? chipRequest('shell')
                  : null
            }
            onBeginEdit={beginNumericEditing}
            onCancelEdit={endNumericEditing}
            onCommit={(value) => applyHandleValue(handle.handle, value)}
          />
        );
      })}
      {overlay?.kind === 'extrude' && overlay.screen && overlay.showDistance && (
        <DimensionLabel
          label="Extrude distance"
          value={overlay.distance}
          x={overlay.screen[0]}
          y={overlay.screen[1] - 18}
          invalid={previewError !== null}
          editRequest={chipRequest('extrude')}
          onBeginEdit={beginNumericEditing}
          onCancelEdit={endNumericEditing}
          onCommit={(value) => useAssemblerStore.getState().setDistance(value)}
        />
      )}
      {overlay?.kind === 'move' &&
        overlay.axisLabels.map(
          (a) =>
            a.screen && (
              <DimensionLabel
                key={a.axis}
                label={
                  a.oriented
                    ? ['Axis 1 offset', 'Axis 2 offset', 'Normal offset'][a.axis]!
                    : ['X offset', 'Y offset', 'Z offset'][a.axis]!
                }
                value={a.value}
                x={a.screen[0]}
                y={a.screen[1] - 18}
                onBeginEdit={beginNumericEditing}
                onCancelEdit={endNumericEditing}
                onCommit={(value) => {
                  const s = useAssemblerStore.getState();
                  const tool = s.activeTool;
                  if (tool?.kind !== 'move') return;
                  const next = withDeltaAlong(tool, a.axis, value);
                  s.setDelta(next.dx, next.dy, next.dz);
                }}
              />
            ),
        )}
      {toolChips.map(({ chip, screen }, index) =>
        screen ? (
          <DimensionLabel
            key={chip.handle}
            label={chip.label}
            {...(chip.prefix ? { prefix: chip.prefix } : {})}
            unit={chip.unit === 'deg' ? '°' : chip.unit === 'count' ? '' : 'mm'}
            value={chip.value}
            x={screen[0]}
            y={screen[1] - 18}
            invalid={activeTool?.kind === 'feature' && previewError !== null}
            editRequest={index === 0 && activeTool?.kind === 'feature' ? editRequest : null}
            onBeginEdit={beginNumericEditing}
            onCancelEdit={endNumericEditing}
            onCommit={(value) => applyHandleValue(chip.handle, value, false)}
          />
        ) : null,
      )}
    </div>
  );
}

export type { ToolChip };
