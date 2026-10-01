import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import type {
  Body,
  EvaluatedSketch,
  EvaluationResult,
} from '../../foundation/geometry-kernel/types.js';
import {
  modeDrawingPlaneNormal,
  modeHiddenFeatureIds,
  modeOwnsKeyboard,
  offerModeBox,
  offerModeTap,
  openPickInMode,
  viewportDomOverlays,
  type ViewportDomHost,
} from './domOverlays.js';
import type { CameraCommand } from './cameraChannel.js';
import {
  extraViewportDatums,
  offerViewportClick,
  subscribeViewportDatums,
  viewportShell,
} from './viewportHooks.js';

import { consumedSketchIds, isSketchVisible } from '../../foundation/document/sketchVisibility.js';
import { visibleBounds, type Bounds3 } from '../../foundation/commands/viewBounds.js';
import {
  isReferenceMeshBodyId,
  REFERENCE_MESH_ID_PREFIX,
  referenceMeshIdOf,
  referenceMeshToBody,
} from '../../foundation/commands/referenceMesh.js';
import {
  findFace,
  isPreviewTool,
  useAssemblerStore,
  type AssemblerState,
  type SelectionItem,
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
  orbitAbout,
  pan as panPose,
  pointAtViewDepth,
  poseFromDirection,
  presetPose,
  rollBy,
  viewDepthOf,
  viewProjectionMatrix,
  withFov,
  withFovAt,
  worldPerPixel as cameraWorldPerPixel,
  zoomAtRay,
  type CameraPose,
  type CameraPresetName,
} from './camera.js';
import { cameraTargetBounds, faceFrameBounds } from './cameraTargets.js';
import { blendFov, PROJECTION_BLEND_MS, wantedFov, type ProjectionBlend } from './projection.js';
import {
  PIVOT_SEARCH_RADIUS_PX,
  pivotDepth,
  type DepthProjection,
  type PivotRule,
} from './orbitPivot.js';
import { navigationPreset, penNavigation, resolveDrag } from '../input/navigation.js';
import {
  INERTIA_MIN_START,
  inertiaStep,
  TouchGestureRecognizer,
  type GestureEvent,
} from '../input/gestures.js';
import { penPresence, samplePointer } from '../input/pointer.js';
import { useTabletLayout } from '../input/tabletLayout.js';
import { findCommand } from '../../foundation/commands/registry.js';
import { notify } from '../../foundation/commands/notices.js';
import { PickCandidatesPopup } from './PickCandidatesPopup.js';
import type { PickCandidate } from './pickCandidates.js';
import { SelectionBox } from './SelectionBox.js';
import { SelectThroughChip } from './SelectThroughChip.js';
import { boxSelectionIn, candidatesAt, type ViewportQueryContext } from './viewportQueries.js';
import { isAmbiguous } from './pickCandidates.js';
import { usePreferences } from '../input/preferences.js';
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
import { encodePng } from './imageExport.js';
import { setImageRenderer, useViewportUi } from './viewportUi.js';
import { readViewportColors, type ViewportColors } from './theme.js';
import {
  handleTip,
  sectionClip,
  sectionHandle,
  sectionOffsetRange,
  type AxisHandle,
  type SectionView,
} from './section.js';
import { bodyMaterials } from './displayModes.js';
import { rayCastFaces } from './pickCandidates.js';
import { ViewCube } from './ViewCube.js';
import { applyFeatureHandleValue, featureToolView } from './featureToolView.js';
import {
  EMPTY_TOOL_HANDLES,
  viewportToolFor,
  type ToolDrag,
  type ToolHandleSet,
  type ToolLabel,
  type ToolPointer,
  type ToolView,
} from './toolViews.js';
import { acceptPick, draftAcceptEmptyClick } from '../../foundation/commands/featureDrafts.js';

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
/** Section offset drags snap to this step, mm. */
const HANDLE_STEP_MM = 0.1;
/** Angle drags snap to this unless Shift is held (then 0.1°). */
const ANGLE_SNAP_DEG = 15;
function snap(value: number, step: number): number {
  return Math.round(value / step) * step;
}

/** The running tool's view: the core feature tool's (drafts), else its module's provider. */
function toolViewOf(s: AssemblerState, preview: EvaluationResult | null): ToolView {
  const tool = s.activeTool;
  if (!tool) return {};
  if (tool.kind === 'feature') return featureToolView({ state: s, preview });
  return viewportToolFor(tool.kind)?.view({ state: s, preview }) ?? {};
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
  /** The running tool's handles beyond the arrows (arcs, rings, chips, guides, pivot). */
  toolHandles: ToolHandleSet;
  /** What the running tool shows (`toolViews.ts`). */
  toolView: ToolView;
  previewNewBodyIds: string[];
  /** Construction planes/axes to draw (visible ones, with selection/hover state and Fix ghosts). */
  datums: SceneDatum[];
}

/** Construction planes/axes of the shown evaluation, with their highlight state. */
function sceneDatums(
  s: AssemblerState,
  evaluation: EvaluationResult,
  toolDatumIds: readonly string[],
): SceneDatum[] {
  const items =
    s.activeTool?.kind === 'pick' ? [...s.selection, ...s.activeTool.picks.flat()] : s.selection;
  const selected = new Set(
    items.filter((i) => i.kind === 'datum').map((i) => (i as { featureId: string }).featureId),
  );
  // References a running tool holds (a mirror plane, a revolve axis) are highlighted too.
  for (const id of toolDatumIds) selected.add(id);
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
  return [...out, ...extraViewportDatums(s)];
}

function sceneModel(s: AssemblerState): SceneModel {
  const tool = s.activeTool;
  const previewTool = isPreviewTool(tool) ? tool : null;
  const preview = previewTool?.previewEvaluation ?? null;
  const view = toolViewOf(s, preview);
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
  let movedGhosts: Body[] = [];
  // The tool's own body transform (the Move/Rotate preview).
  if (view.bodies) {
    const moved = view.bodies(bodies);
    bodies = moved.bodies;
    previewNewBodyIds = moved.newIds;
    movedGhosts = moved.ghosts;
  }
  let allSketches = preview?.sketches ?? s.evaluation.sketches;
  if (view.sketches) allSketches = view.sketches(allSketches);
  const consumed = consumedSketchIds(s.features);
  const shown = new Set(view.shownSketchIds ?? []);
  // The sketch being edited in sketch mode is drawn by the sketch overlay instead.
  const editing = new Set(modeHiddenFeatureIds());
  const sketches = allSketches.filter(
    (sketch) =>
      !editing.has(sketch.featureId) &&
      (shown.has(sketch.featureId) ||
        isSketchVisible(sketch.featureId, consumed, s.sketchVisibility) ||
        s.selection.some((i) => i.kind === 'sketchProfile' && i.featureId === sketch.featureId) ||
        (s.hover?.kind === 'sketchProfile' && s.hover.featureId === sketch.featureId)),
  );

  if (view.previewNewBodyIds) previewNewBodyIds = view.previewNewBodyIds;
  let ghostBodies: Body[] = view.ghostBodies ?? [];
  if (movedGhosts.length > 0) ghostBodies = movedGhosts;

  const bounds = visibleBounds(s.evaluation.bodies, s.hiddenBodyIds, s.isolatedBodyIds);
  const toolHandles = view.handles ?? EMPTY_TOOL_HANDLES;
  const handles: AxisHandle[] = [...toolHandles.axis];
  if (s.viewState.sectionEnabled && !s.viewState.sectionOnly) {
    handles.push(sectionHandle(sectionViewOf(s), bounds));
  }
  return {
    bodies,
    sketches,
    extrudePreviewBodyId: view.extrudePreviewBodyId ?? null,
    previewAccentBodyIds: view.previewAccentBodyIds ?? [],
    previewFaceKeyPrefix: view.previewFaceKeyPrefix ?? null,
    ghostBodies,
    bounds,
    handles,
    toolHandles,
    toolView: view,
    previewNewBodyIds,
    datums: sceneDatums(s, preview ?? s.evaluation, view.datumIds ?? []),
  };
}
/** The section as `section.ts` sees it (axis or face-aligned plane). */
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
  /** `started`: the drag passed the click threshold and the pivot is set. */
  | { kind: 'orbit'; started?: boolean }
  | { kind: 'pan' }
  /** Pen + Alt drag: vertical movement zooms towards where the drag started. */
  | {
      kind: 'zoom';
      /** The pixel the zoom stays anchored at (where the pen went down). */
      x: number;
      y: number;
      /** Perspective: the point whose depth sets the step (pivot rules), or `null`. */
      depthPoint: Vec3 | null;
    }
  /** A drag the running tool started on its own handle (arrow, gizmo, centre). */
  | { kind: 'tool'; drag: ToolDrag }
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
      /** Snapping step of the handle (degrees), when not the default. */
      snapDeg?: number;
      start: number;
    }
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
  /** A pen drag with a navigation modifier (Shift/Ctrl/Alt): without movement it is a click. */
  penNav: boolean;
  shiftKey: boolean;
}

/** Live box-selection rectangle (host-relative CSS px). */
interface BoxState {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  filter: BoxFilter;
}

/** A glide after a flick (Settings › Touch and pen › Inertia). */
interface Glide {
  kind: 'orbit' | 'pan';
  vx: number;
  vy: number;
  last: number;
}

/** Twist before two fingers roll the view (Settings › Touch and pen › Twist to roll). */
const TWIST_DEAD_ZONE_DEG = 12;
/** Pen + Alt drag: zoom factor per pixel of vertical movement. */
const PEN_ZOOM_PER_PX = 0.005;
/** Pointer radius for overlapping-pick candidates, CSS px (mouse / touch). */
const PICK_RADIUS_PX = 4;
const TOUCH_PICK_RADIUS_PX = 12;

function reduceMotion(): boolean {
  return (
    typeof window !== 'undefined' &&
    (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false)
  );
}

/** The field of view the projection setting gives a free 3D view (`0` = orthographic). */
function preferredFov(): number {
  const prefs = usePreferences.getState();
  return wantedFov(prefs.projection, prefs.fov, { sketching: false, standardView: false });
}

/** A wheel burst keeps its depth point (perspective step) while the cursor stays within this (CSS px) … */
const WHEEL_PIVOT_SLOP_PX = 4;
/** … and the wheel pauses for less than this (ms). */
const WHEEL_BURST_MS = 300;

/** What the last recorded id pass was drawn with (the pivot reads its depth). */
interface PickFrame {
  pose: CameraPose;
  depth: DepthProjection;
}

/** The last pivot determination (DEV probe and measurement). */
export interface PivotProbe {
  point: Vec3;
  rule: PivotRule;
  /** Whole determination, ms (read + rules). */
  ms: number;
  /** The depth-window read alone (includes drawing a stale id pass), ms. */
  readMs: number;
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
  if (applyFeatureHandleValue(handle, raw, snapDrag)) return;
  const s = useAssemblerStore.getState();
  if (viewportToolFor(s.activeTool?.kind)?.applyHandleValue?.(handle, raw, snapDrag)) return;
  if (handle !== 'section') return;
  const bounds = visibleBounds(s.evaluation.bodies, s.hiddenBodyIds, s.isolatedBodyIds);
  const [lo, hi] = sectionOffsetRange(sectionViewOf(s), bounds);
  s.setSectionOffset(Math.min(hi, Math.max(lo, snap(raw, HANDLE_STEP_MM))));
}
/**
 * The orbit pivot, a small dot drawn while an orbit runs (re-projected every
 * frame). `data-pivot`/`data-pivot-rule` let end-to-end tests read it.
 */
function PivotDot(props: {
  point: Vec3;
  rule: PivotRule;
  project: (point: Vec3) => readonly [number, number] | null;
  tick: number;
}): JSX.Element | null {
  const screen = props.project(props.point);
  if (!screen) return null;
  return (
    <div
      className={styles.pivotDot}
      style={{ left: screen[0], top: screen[1] }}
      data-pivot={props.point.map((v) => v.toFixed(3)).join(',')}
      data-pivot-rule={props.rule}
      aria-hidden
    />
  );
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
  /**
   * Adaptive projection: the camera went to a standard view (view-cube face,
   * edge or corner, a named or saved view, Home, Look at face) and was not
   * orbited since. Tracked in every mode so switching to Adaptive fits.
   */
  const standardViewRef = useRef(false);
  /** A running change of the field of view outside a camera animation. */
  const projectionBlendRef = useRef<ProjectionBlend | null>(null);
  /** The pivot of the running orbit (and its glide); `null` = the target. */
  const pivotRef = useRef<Vec3 | null>(null);
  /** An orbit gesture is running (its pivot anchors projection blends). */
  const orbitActiveRef = useRef(false);
  /** The pivot dot, shown while an orbit runs. */
  const [orbitDot, setOrbitDot] = useState<{ point: Vec3; rule: PivotRule } | null>(null);
  const pickFrameRef = useRef<PickFrame | null>(null);
  /** The current wheel burst: where it started and the point setting its perspective step. */
  const wheelBurstRef = useRef<{
    x: number;
    y: number;
    time: number;
    depthPoint: Vec3 | null;
  } | null>(null);
  /** A pen navigation by hover (Shift/Alt + hover): its modifier, start pixel and depth point. */
  const penHoverNavRef = useRef<{
    nav: string;
    x: number;
    y: number;
    depthPoint: Vec3 | null;
  } | null>(null);
  const lastPivotRef = useRef<PivotProbe | null>(null);

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
  // Datums the modules and the shell add (History "Fix…" ghosts) redraw on their own changes.
  useEffect(
    () =>
      subscribeViewportDatums(() => {
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
    // A camera command ends a touch glide (declared below; set by then).
    glideRef.current = null;
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
    // A named view (Front, Top, … from the cube, menus or Ctrl+2…7) is a standard view.
    if (request.preset !== 'fit') standardViewRef.current = true;
    const next =
      request.preset === 'fit'
        ? fitPose(visibleBodies(), current, hostAspect())
        : presetPose(request.preset, current);
    animateTo(next);
  }, [state.viewState.cameraRequest, animateTo, visibleBodies, hostAspect]);

  // ---- Workspace camera commands (home, fit selection, cube edges/corners, roll, saved views, look at face)
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
      if (!next) return;
      // Home, cube edges/corners, saved views and Look at face are standard views (Adaptive:
      // parallel until the next orbit); fits and the 90° roll keep the current state.
      if (
        command.kind === 'home' ||
        command.kind === 'direction' ||
        command.kind === 'pose' ||
        command.kind === 'lookAlong' ||
        command.kind === 'lookAtFace'
      ) {
        standardViewRef.current = true;
      }
      animateTo(next);
    },
    [animateTo, visibleBodies, hostAspect],
  );
  useEffect(() => {
    const shell = viewportShell();
    const apply = () => {
      const cameraCommand = shell.cameraCommand();
      if (!cameraCommand || cameraCommand.nonce === lastWorkspaceCameraNonce.current) return;
      lastWorkspaceCameraNonce.current = cameraCommand.nonce;
      applyCameraCommand(cameraCommand.command);
    };
    apply();
    return shell.subscribeCameraCommand(apply);
  }, [applyCameraCommand]);

  // ---- Projection / field of view / theme / pointer settings --------------------------------
  const projection = usePreferences((p) => p.projection);
  const fovSetting = usePreferences((p) => p.fov);
  const theme = usePreferences((p) => p.theme);
  // The render loop blends to the projection the setting asks for (`wantedFovNow`).
  useEffect(() => {
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
    viewportShell().setCameraPoseProbe(() => poseRef.current);
    return () => viewportShell().setCameraPoseProbe(null);
  }, []);

  const selectThrough = viewportShell().useSelectThrough();
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
  /** Touch gestures (`input/gestures.ts`): the fingers fed to it, its long-press timer, a box it started. */
  const gesturesRef = useRef<TouchGestureRecognizer | null>(null);
  gesturesRef.current ??= new TouchGestureRecognizer({ twistDeg: TWIST_DEAD_ZONE_DEG });
  const touchIdsRef = useRef(new Set<number>());
  const longPressTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const touchBoxRef = useRef(false);
  /** Camera glide after a flick. */
  const glideRef = useRef<Glide | null>(null);
  /** Zoom anchor of the running two-finger gesture. */
  const pinchDepthRef = useRef<Vec3 | null>(null);
  /** Where the pen hovered last (pen + modifier hover navigates). */
  const penHoverRef = useRef<{ x: number; y: number } | null>(null);
  /** Long-press feedback ring (host px) until the finger moves or lifts. */
  const [pressRing, setPressRing] = useState<{ x: number; y: number } | null>(null);
  // The tablet layout enlarges handles: redraw when it changes.
  useEffect(
    () =>
      useTabletLayout.subscribe(() => {
        dirtyRef.current = true;
      }),
    [],
  );

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
      const toolView = scene.toolView;
      const extrudeHandle = toolView.arrow
        ? { ...toolView.arrow, hovered: handleHover?.kind === 'extrudeHandle' }
        : null;
      // While the gizmo centre is dragged onto geometry, arrows/rings step aside (not pickable).
      const mode = gestureRef.current?.mode;
      const pivotDragging = mode?.kind === 'tool' && mode.drag.hidesGizmo === true;
      const gizmo = toolView.gizmo;
      const moveHandle =
        gizmo && !pivotDragging
          ? {
              ...gizmo,
              hoveredAxis: handleHover?.kind === 'moveHandle' ? handleHover.axis : null,
              hoveredTile: handleHover?.kind === 'moveTile' ? handleHover.plane : null,
            }
          : null; // The Move/Rotate preview body is already transformed in `sceneModel`.
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
        sketchNormal: modeDrawingPlaneNormal(),
        xrayOpacity: current.viewState.xrayOpacity,
        gridPlane: current.viewState.gridPlane,
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
        pickSketchLines: toolView.pickSketchLines ?? false,
        // SEL-12: sketch curves are selectable while no tool runs.
        pickSketchCurves: !currentTool,
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
        // Finger-sized pick areas and handles: touch input or the tablet layout.
        hitScale: coarseRef.current || useTabletLayout.getState().tablet ? 2 : 1,
        handleScale: useTabletLayout.getState().tablet ? 1.5 : 1,
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
      // The projection the setting asks for now (Adaptive: sketch open, standard view).
      const prefs = usePreferences.getState();
      const want = wantedFov(prefs.projection, prefs.fov, {
        sketching: modeDrawingPlaneNormal() !== null,
        standardView: standardViewRef.current,
      });
      let anim = animRef.current;
      if (anim && (anim.to.fov ?? 45) !== want) {
        // A camera animation carries the projection change (lerpPose blends it).
        anim = { ...anim, to: withFovAt(anim.to, want) };
        animRef.current = anim;
        projectionBlendRef.current = null;
      }
      if (anim) {
        const t = Math.min(1, (now - anim.start) / Math.max(1, anim.duration));
        const eased = 1 - Math.pow(1 - t, 3);
        poseRef.current = lerpPose(anim.from, anim.to, eased);
        dirtyRef.current = true;
        if (t >= 1) animRef.current = null;
      } else if ((poseRef.current.fov ?? 45) !== want) {
        // A short blend about the orbit pivot (or the target): no jump in apparent size.
        let blend = projectionBlendRef.current;
        if (!blend || blend.toFov !== want) {
          blend = {
            fromFov: poseRef.current.fov ?? 45,
            toFov: want,
            start: now,
            duration: reduceMotion() || !prefs.animateCamera ? 0 : PROJECTION_BLEND_MS,
          };
          projectionBlendRef.current = blend;
        }
        const step = blendFov(blend, now);
        // While orbiting (or gliding after it) the pivot keeps its place, else the target plane.
        const orbiting = orbitActiveRef.current || glideRef.current?.kind === 'orbit';
        poseRef.current = withFovAt(poseRef.current, step.fov, orbiting ? pivotRef.current : null);
        if (step.done) projectionBlendRef.current = null;
        dirtyRef.current = true;
      }
      const glide = glideRef.current;
      if (glide) {
        // Inertia: the camera keeps the flick's velocity and slows down.
        const dt = Math.min(50, Math.max(0, now - glide.last));
        glide.last = now;
        const step = inertiaStep(glide, dt);
        poseRef.current =
          glide.kind === 'orbit'
            ? orbitAbout(poseRef.current, step.dx, step.dy, pivotRef.current)
            : panPose(poseRef.current, step.dx, step.dy, hostRef.current?.clientHeight ?? 800);
        if (step.next) {
          glide.vx = step.next.vx;
          glide.vy = step.next.vy;
        } else glideRef.current = null;
        dirtyRef.current = true;
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
      if (built.frame.depth) {
        const { near, far, orthographic } = built.frame.depth;
        pickFrameRef.current = { pose: input.pose, depth: { near, far, orthographic } };
      } else pickFrameRef.current = null;
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
          ...(request.edges !== undefined ? { edgesVisible: request.edges } : {}),
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
      if (pick.kind === 'datum' || pick.kind === 'sketchCurve') return pick;
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

  /** The pointer ray at a client point for `pose` (default: the current camera). */
  const rayAtClient = useCallback((clientX: number, clientY: number, pose?: CameraPose) => {
    const host = hostRef.current;
    if (!host) return null;
    const rect = host.getBoundingClientRect();
    const aspect = rect.width / Math.max(1, rect.height);
    const vp = viewProjectionMatrix(pose ?? poseRef.current, aspect);
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

  /**
   * The orbit/zoom pivot under a client point (`orbitPivot.ts`): the surface
   * under the cursor, else the drawn depths around it (a bore: its rim depth),
   * else the visible model's centre depth — always on the cursor ray. Reads
   * one small window of the id pass's depth; without one (no frame yet, the
   * camera moved since the last frame) it goes straight to the model rule.
   */
  const cursorPivot = useCallback(
    (clientX: number, clientY: number): { point: Vec3; rule: PivotRule } | null => {
      const t0 = performance.now();
      const pose = poseRef.current;
      const ray = rayAtClient(clientX, clientY);
      if (!ray) return null;
      let point: Vec3 | null = null;
      let rule: PivotRule = 'model';
      let readMs = 0;
      const host = hostRef.current;
      const renderer = rendererRef.current;
      const frame = pickFrameRef.current;
      if (host && renderer && frame && frame.pose === pose) {
        const rect = host.getBoundingClientRect();
        const { dpr } = sizeRef.current;
        const px = (clientX - rect.left) * dpr;
        const py = (clientY - rect.top) * dpr;
        const r0 = performance.now();
        const win = renderer.readPickDepthWindow(px, py, PIVOT_SEARCH_RADIUS_PX * dpr);
        readMs = performance.now() - r0;
        const found = win
          ? pivotDepth(
              {
                width: win.width,
                height: win.height,
                z: win.z,
                cx: px - win.x0,
                cy: py - win.y0,
                cssPerSample: 1 / dpr,
              },
              frame.depth,
            )
          : null;
        if (found) {
          point = pointAtViewDepth(pose, ray, found.depth);
          rule = found.rule;
        }
      }
      if (!point) {
        // Rule 3: on the cursor ray at the depth of the visible model's centre.
        const s = useAssemblerStore.getState();
        const bounds = visibleBounds(sceneModel(s).bodies, s.hiddenBodyIds, s.isolatedBodyIds);
        const depth = bounds
          ? viewDepthOf(pose, [
              (bounds.min[0] + bounds.max[0]) / 2,
              (bounds.min[1] + bounds.max[1]) / 2,
              (bounds.min[2] + bounds.max[2]) / 2,
            ])
          : pose.distance;
        point = pointAtViewDepth(pose, ray, depth);
        rule = bounds ? 'model' : 'target';
      }
      if (!point) return null;
      lastPivotRef.current = { point, rule, ms: performance.now() - t0, readMs };
      return { point, rule };
    },
    [rayAtClient],
  );

  /**
   * The point whose depth sets a perspective zoom step at a client point (the
   * pivot rules on the depth window), or `null` in orthographic views — they
   * scale about the cursor's pixel and need no depth, so nothing is read.
   */
  const zoomDepthPointAt = useCallback(
    (clientX: number, clientY: number): Vec3 | null =>
      isOrthographic(poseRef.current) ? null : (cursorPivot(clientX, clientY)?.point ?? null),
    [cursorPivot],
  );

  /** The pivot an orbit starting at a client point turns about (Settings › Navigation › Orbit around). */
  const orbitPivotAt = useCallback(
    (clientX: number, clientY: number): { point: Vec3; rule: PivotRule } | null => {
      const around = usePreferences.getState().orbitAround;
      if (around === 'centre') return null;
      if (around === 'selection') {
        const s = useAssemblerStore.getState();
        const bounds = cameraTargetBounds(sceneModel(s), s.selection);
        if (bounds.length > 0) {
          let min: Vec3 = [Infinity, Infinity, Infinity];
          let max: Vec3 = [-Infinity, -Infinity, -Infinity];
          for (const b of bounds) {
            min = [
              Math.min(min[0], b.min[0]),
              Math.min(min[1], b.min[1]),
              Math.min(min[2], b.min[2]),
            ];
            max = [
              Math.max(max[0], b.max[0]),
              Math.max(max[1], b.max[1]),
              Math.max(max[2], b.max[2]),
            ];
          }
          return {
            point: [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2],
            rule: 'selection',
          };
        }
      }
      return cursorPivot(clientX, clientY);
    },
    [cursorPivot],
  );

  /** An orbit begins (mouse, pen, finger): Adaptive leaves the standard view; the pivot dot shows. */
  const beginOrbit = useCallback(
    (at: { x: number; y: number } | null) => {
      standardViewRef.current = false;
      glideRef.current = null;
      const pivot = at ? orbitPivotAt(at.x, at.y) : null;
      pivotRef.current = pivot?.point ?? null;
      orbitActiveRef.current = true;
      setOrbitDot(pivot ?? { point: poseRef.current.target, rule: 'target' });
    },
    [orbitPivotAt],
  );
  const endOrbit = useCallback(() => {
    orbitActiveRef.current = false;
    setOrbitDot(null);
  }, []);

  /** What the modules' DOM overlays get from the viewport (`domOverlays.ts`). */
  /** Set below, once the touch handlers exist (`adoptTouches`). */
  const adoptTouchesRef = useRef<ViewportDomHost['adoptTouches']>(() => undefined);
  const domHost = useMemo<ViewportDomHost>(
    () => ({
      hostRef,
      poseRef,
      animRef,
      dirtyRef,
      rayAtClient,
      pickAt,
      project: projectHost,
      adoptTouches: (touches) => adoptTouchesRef.current(touches),
    }),
    [rayAtClient, pickAt, projectHost],
  );

  /** The pointer as a running tool sees it (ray, picking). */
  const toolPointer = useCallback(
    (clientX: number, clientY: number, shiftKey: boolean): ToolPointer => ({
      clientX,
      clientY,
      shiftKey,
      ray: rayAtClient(clientX, clientY),
      pickAt,
      rayAt: rayAtClient,
    }),
    [pickAt, rayAtClient],
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
      // The running tool's own handles (an arrow, the gizmo, its centre) start its drag.
      const drag =
        tool &&
        viewportToolFor(tool.kind)?.beginDrag?.(
          pick,
          toolPointer(clientX, clientY, false),
          current,
        );
      if (drag) return { kind: 'tool', drag };
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
          ...(angle.snapDeg !== undefined ? { snapDeg: angle.snapDeg } : {}),
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
    [pickAt, rayAtClient, toolPointer],
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

  /** The first visible surface point under the pointer that Section View does not cut away. */
  const surfacePointAt = useCallback(
    (clientX: number, clientY: number): Vec3 | null => {
      const ray = rayAtClient(clientX, clientY);
      if (!ray) return null;
      const s = useAssemblerStore.getState();
      const clip = s.viewState.sectionEnabled ? sectionClip(sectionViewOf(s)) : null;
      for (const hit of rayCastFaces(visibleBodies(), ray)) {
        const dir = ray.direction;
        const p: Vec3 = [
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
        return p;
      }
      return null;
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
      const pick = pickAt(clientX, clientY);
      // No tool: the modules' and the shell's clicks first (Measure › Points, Section › Face,
      // History "Fix…").
      if (!tool) {
        const host = hostRef.current;
        const rect = host?.getBoundingClientRect();
        const handled =
          rect !== undefined &&
          offerViewportClick({
            state: store,
            pick,
            item: selectionFromPick(pick, isDouble),
            isDouble,
            touch,
            hostPoint: [clientX - rect.left, clientY - rect.top],
            project: (p) => {
              const sp = projectHost(p);
              return sp ? [sp[0], sp[1]] : null;
            },
            visibleBodies,
            surfacePoint: () => surfacePointAt(clientX, clientY),
          });
        if (handled) return;
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
      // The running tool's own clicks (Extrude "To Object", Fillet edges, Shell faces, …).
      if (
        tool &&
        viewportToolFor(tool.kind)?.click?.({
          state: store,
          pick,
          item: selectionFromPick(pick, isDouble),
          isDouble,
        })
      ) {
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
          // …unless the draft takes the empty click itself (Hole: a click into a through hole
          // of the picked face removes that hole).
          if (toolRay) {
            const before = tool.draft;
            store.updateFeatureDraft((d, evaluation) =>
              draftAcceptEmptyClick(d, toolRay, evaluation, store.features),
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
                : item.kind === 'sketchCurve'
                  ? {
                      kind: 'sketchLine' as const,
                      featureId: item.featureId,
                      entityId: item.entityId,
                    }
                  : item;
          store.updateFeatureDraft((draft, evaluation) =>
            acceptPick(draft, toolPick, evaluation, store.features),
          );
        }
        return;
      }
      const throughAll = viewportShell().selectThrough();
      // A sketch curve under the pointer is the pick (SEL-12): no overlap popup for it.
      if (!isDouble && !tool && pick?.kind !== 'sketchCurve') {
        // Overlapping geometry (or Select Through): let the user choose.
        const ctx = queryContext();
        const host = hostRef.current;
        if (ctx && host) {
          const rect = host.getBoundingClientRect();
          const x = clientX - rect.left;
          const y = clientY - rect.top;
          const candidates = candidatesAt(ctx, x, y, {
            radius: touch ? TOUCH_PICK_RADIUS_PX : PICK_RADIUS_PX,
            selectThrough: throughAll,
            names: candidateNames(),
          });
          if (isAmbiguous(candidates, throughAll)) {
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
      // A double click may open the pick in a mode (a sketch in sketch mode, Shapr3D).
      if (isDouble && openPickInMode(pick)) return;
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
      surfacePointAt,
      projectHost,
      visibleBodies,
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
        viewportShell().selectThrough(),
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
        // A finger box ends here; the finger does nothing more until it lifts.
        if (touchBoxRef.current) {
          touchBoxRef.current = false;
          gesturesRef.current?.cancelAll();
        }
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

  // ---- Touch (assembler/TOUCH.md): the gesture recognizer turns fingers into navigation and
  // commands — one finger orbits, two fingers pan, pinch-zoom and twist-roll, taps select (taps
  // add up), a double tap looks at a face / fits the view / selects the body, a long press opens
  // the context menu and long press + drag draws a box; a two-finger tap undoes, a three-finger
  // tap redoes, a three-finger swipe left/right undoes/redoes. Palms are rejected while a pen is
  // used. Modes (sketch) take taps and boxes first.
  /** Runs Undo or Redo the way the menu does (same availability), with a short notice. */
  const historyGesture = useCallback((kind: 'undo' | 'redo') => {
    if (!usePreferences.getState().touchUndoGestures) return;
    const command = findCommand(kind === 'undo' ? 'edit.undo' : 'edit.redo');
    if (!command) return;
    const state = useAssemblerStore.getState();
    const availability = command.availability(state);
    if (!availability.enabled) {
      notify(availability.reason ?? (kind === 'undo' ? 'Nothing to undo.' : 'Nothing to redo.'));
      return;
    }
    void command.run(state);
    notify(kind === 'undo' ? 'Undo' : 'Redo');
  }, []);

  /** A finger double tap: look at a face, fit an empty view, else what a double click does. */
  const doubleTap = useCallback(
    (clientX: number, clientY: number) => {
      const pick = pickAt(clientX, clientY);
      if (!useAssemblerStore.getState().activeTool) {
        if (pick?.kind === 'face') {
          lastClickRef.current = null;
          applyCameraCommand({ kind: 'lookAtFace', bodyId: pick.bodyId, faceKey: pick.faceKey });
          return;
        }
        if (!pick) {
          lastClickRef.current = null;
          applyCameraCommand({ kind: 'fitAll' });
          return;
        }
      }
      // Edges, sketch profiles, tools: like a double click (the body; a sketch opens).
      handleClick(clientX, clientY, true, true);
    },
    [pickAt, applyCameraCommand, handleClick],
  );

  const startGlide = useCallback((kind: Glide['kind'], vx: number, vy: number) => {
    if (!usePreferences.getState().touchInertia || reduceMotion()) return;
    if (Math.hypot(vx, vy) < INERTIA_MIN_START) return;
    glideRef.current = { kind, vx, vy, last: performance.now() };
  }, []);

  const applyGestures = useCallback(
    (events: readonly GestureEvent[]) => {
      const host = hostRef.current;
      if (!host || events.length === 0) return;
      const rect = host.getBoundingClientRect();
      for (const e of events) {
        switch (e.type) {
          case 'tap': {
            setPressRing(null);
            const tap = {
              clientX: e.x,
              clientY: e.y,
              count: e.count,
              pointerType: 'touch' as const,
            };
            if (offerModeTap(tap)) break;
            if (e.count === 2) doubleTap(e.x, e.y);
            else handleClick(e.x, e.y, true, true);
            break;
          }
          case 'longPress':
            setPressRing({ x: e.x - rect.left, y: e.y - rect.top });
            break;
          case 'contextMenu':
            setPressRing(null);
            contextMenuAt(e.x, e.y);
            break;
          case 'boxStart':
            setPressRing(null);
            touchBoxRef.current = true;
            updateBox(e.x0, e.y0, e.x, e.y);
            break;
          case 'boxMove':
            updateBox(e.x0, e.y0, e.x, e.y);
            break;
          case 'boxEnd': {
            touchBoxRef.current = false;
            const current = boxRef.current;
            const handled =
              current !== null &&
              offerModeBox(
                { x0: current.x0, y0: current.y0, x1: current.x1, y1: current.y1 },
                true,
              );
            if (handled) setBox(null);
            else finishBox(true);
            break;
          }
          case 'boxCancel':
            touchBoxRef.current = false;
            setBox(null);
            break;
          case 'orbitStart':
            setPressRing(null);
            // One finger orbits about the point under it (the pivot rules).
            beginOrbit({ x: e.x, y: e.y });
            break;
          case 'transformStart':
            setPressRing(null);
            glideRef.current = null;
            // Pinch zoom stays anchored at the fingers' midpoint; the pivot rules' depth there
            // sets the perspective step (and the pan's depth).
            pinchDepthRef.current = zoomDepthPointAt(e.cx, e.cy);
            break;
          case 'orbit':
            poseRef.current = orbitAbout(poseRef.current, e.dx, e.dy, pivotRef.current);
            dirtyRef.current = true;
            break;
          case 'orbitEnd':
            endOrbit();
            startGlide('orbit', e.vx, e.vy);
            break;
          case 'transform': {
            const depthPoint = pinchDepthRef.current;
            // The fingers move the content at that depth 1:1.
            let pose = panPose(
              poseRef.current,
              e.dx,
              e.dy,
              host.clientHeight,
              depthPoint ? viewDepthOf(poseRef.current, depthPoint) : undefined,
            );
            if (e.scale !== 1 && e.scale > 0) {
              const ray = rayAtClient(e.cx, e.cy, pose);
              if (ray) {
                const depth = depthPoint ? viewDepthOf(pose, depthPoint) : null;
                pose = zoomAtRay(pose, 1 / e.scale, ray, depth);
              }
            }
            if (e.rotation !== 0 && usePreferences.getState().twistRoll) {
              pose = rollBy(pose, e.rotation);
            }
            poseRef.current = pose;
            dirtyRef.current = true;
            break;
          }
          case 'transformEnd':
            startGlide('pan', e.vx, e.vy);
            break;
          case 'twoFingerTap':
            historyGesture('undo');
            break;
          case 'threeFingerTap':
            historyGesture('redo');
            break;
          case 'threeFingerSwipe':
            historyGesture(e.direction === 'left' ? 'undo' : 'redo');
            break;
        }
      }
    },
    [
      beginOrbit,
      contextMenuAt,
      cursorPivot,
      doubleTap,
      endOrbit,
      finishBox,
      handleClick,
      historyGesture,
      startGlide,
      updateBox,
    ],
  );

  /** Polls the recognizer when its long press is due. */
  const scheduleLongPress = useCallback(() => {
    if (longPressTimerRef.current) clearTimeout(longPressTimerRef.current);
    longPressTimerRef.current = null;
    const gestures = gesturesRef.current!;
    const wait = gestures.nextPollIn(performance.now());
    if (wait === null) return;
    longPressTimerRef.current = setTimeout(() => {
      longPressTimerRef.current = null;
      applyGestures(gestures.poll(performance.now()));
    }, wait + 5);
  }, [applyGestures]);
  useEffect(
    () => () => {
      if (longPressTimerRef.current) clearTimeout(longPressTimerRef.current);
    },
    [],
  );

  /** Feeds a finger to the recognizer (captured by the host from now on). */
  const beginTouch = useCallback(
    (pointerId: number, clientX: number, clientY: number, t: number) => {
      const gestures = gesturesRef.current!;
      coarseRef.current = true;
      try {
        hostRef.current?.setPointerCapture(pointerId);
      } catch {
        // The pointer is gone already.
      }
      animRef.current = null;
      glideRef.current = null;
      touchIdsRef.current.add(pointerId);
      gestures.setOptions({
        twistDeg: usePreferences.getState().twistRoll ? TWIST_DEAD_ZONE_DEG : Infinity,
      });
      applyGestures(gestures.down({ id: pointerId, x: clientX, y: clientY, t }));
      scheduleLongPress();
    },
    [applyGestures, scheduleLongPress],
  );

  const onTouchDown = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      const sample = samplePointer(event);
      // A palm resting while the pen is used never navigates.
      if (penPresence.touchDown(sample, usePreferences.getState().palmRejection)) return;
      beginTouch(event.pointerId, event.clientX, event.clientY, event.timeStamp);
    },
    [beginTouch],
  );

  const onTouchMove = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      if (!touchIdsRef.current.has(event.pointerId)) return;
      const gestures = gesturesRef.current!;
      applyGestures(
        gestures.move({
          id: event.pointerId,
          x: event.clientX,
          y: event.clientY,
          t: event.timeStamp,
        }),
      );
      scheduleLongPress();
    },
    [applyGestures, scheduleLongPress],
  );

  const onTouchUp = useCallback(
    (event: React.PointerEvent<HTMLDivElement>, cancelled: boolean) => {
      penPresence.touchUp(event.pointerId);
      if (!touchIdsRef.current.delete(event.pointerId)) return;
      const gestures = gesturesRef.current!;
      applyGestures(
        cancelled
          ? gestures.cancel(event.pointerId)
          : gestures.up(event.pointerId, event.timeStamp),
      );
      if (!gestures.active) {
        setPressRing(null);
        touchBoxRef.current = false;
      }
      scheduleLongPress();
    },
    [applyGestures, scheduleLongPress],
  );

  /** Fingers a DOM overlay hands over (a drawing finger, then a second finger: navigation). */
  const adoptTouches = useCallback(
    (touches: readonly { pointerId: number; clientX: number; clientY: number }[]) => {
      for (const touch of touches) {
        if (touchIdsRef.current.has(touch.pointerId)) continue;
        beginTouch(touch.pointerId, touch.clientX, touch.clientY, performance.now());
      }
    },
    [beginTouch],
  );
  adoptTouchesRef.current = adoptTouches;
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
      glideRef.current = null;
      if (event.pointerType === 'pen') {
        // The pen is down: whatever a resting palm started is not a gesture.
        const gestures = gesturesRef.current!;
        if (gestures.active && usePreferences.getState().palmRejection) {
          applyGestures(gestures.cancelAll());
        }
      }
      coarseRef.current = false;
      host.setPointerCapture(event.pointerId);
      animRef.current = null;

      const modifiers = {
        shift: event.shiftKey,
        ctrl: event.ctrlKey || event.metaKey,
        alt: event.altKey,
      };
      const preset = navigationPreset(usePreferences.getState().navigationPreset);
      const action = resolveDrag(preset, event.button, modifiers);
      // Windows pens (Shapr3D): Shift + drag orbits, Ctrl + drag pans, Alt + drag zooms.
      const penNav =
        event.pointerType === 'pen' && event.button === 0 ? penNavigation(modifiers) : null;
      let mode: DragMode = { kind: 'none' };
      if (penNav === 'orbit') mode = { kind: 'orbit' };
      else if (penNav === 'pan') mode = { kind: 'pan' };
      else if (penNav === 'zoom') {
        // Pen + Alt drag zooms at the pixel where the pen went down.
        mode = {
          kind: 'zoom',
          x: event.clientX,
          y: event.clientY,
          depthPoint: zoomDepthPointAt(event.clientX, event.clientY),
        };
      } else if (action === 'orbit') mode = { kind: 'orbit' };
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
        penNav: penNav !== null,
        shiftKey: event.shiftKey,
      };
      // A drag that hides the gizmo (its centre being placed) redraws it at once.
      if (mode.kind === 'tool' && mode.drag.hidesGizmo) dirtyRef.current = true;
    },
    [findHandleHit, pickAt, onTouchDown, popup, applyGestures, zoomDepthPointAt],
  );

  const onPointerMove = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      if (event.pointerType === 'touch') {
        onTouchMove(event);
        return;
      }
      const gesture = gestureRef.current;
      if (!gesture && event.pointerType === 'pen') {
        // A hovering pen with Shift/Ctrl/Alt navigates (Windows pens, Shapr3D).
        const nav = penNavigation({
          shift: event.shiftKey,
          ctrl: event.ctrlKey || event.metaKey,
          alt: event.altKey,
        });
        const last = penHoverRef.current;
        penHoverRef.current = { x: event.clientX, y: event.clientY };
        if (penHoverNavRef.current && penHoverNavRef.current.nav !== nav) {
          if (penHoverNavRef.current.nav === 'orbit') endOrbit();
          penHoverNavRef.current = null;
        }
        if (nav && last) {
          const dx = event.clientX - last.x;
          const dy = event.clientY - last.y;
          const height = hostRef.current?.clientHeight ?? 800;
          // Decided once when a modifier starts the hover navigation: the orbit pivot, or the
          // zoom's pixel and depth point.
          if (!penHoverNavRef.current) {
            if (nav === 'orbit') beginOrbit({ x: last.x, y: last.y });
            penHoverNavRef.current = {
              nav,
              x: last.x,
              y: last.y,
              depthPoint: nav === 'zoom' ? zoomDepthPointAt(last.x, last.y) : null,
            };
          }
          const hover = penHoverNavRef.current;
          if (nav === 'orbit') {
            poseRef.current = orbitAbout(poseRef.current, dx, dy, pivotRef.current);
          } else if (nav === 'pan') poseRef.current = panPose(poseRef.current, dx, dy, height);
          else {
            const ray = rayAtClient(hover.x, hover.y);
            if (ray) {
              const pose = poseRef.current;
              poseRef.current = zoomAtRay(
                pose,
                Math.exp(dy * PEN_ZOOM_PER_PX),
                ray,
                hover.depthPoint ? viewDepthOf(pose, hover.depthPoint) : null,
              );
            }
          }
          animRef.current = null;
          dirtyRef.current = true;
          return;
        }
      }
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
        if (!mode.started) {
          // Decided once per gesture, where the button went down.
          mode.started = true;
          beginOrbit({ x: gesture.startX, y: gesture.startY });
        }
        poseRef.current = orbitAbout(poseRef.current, dx, dy, pivotRef.current);
        dirtyRef.current = true;
      } else if (mode.kind === 'pan') {
        poseRef.current = panPose(poseRef.current, dx, dy, height);
        dirtyRef.current = true;
      } else if (mode.kind === 'zoom') {
        const ray = rayAtClient(mode.x, mode.y);
        if (ray) {
          const pose = poseRef.current;
          poseRef.current = zoomAtRay(
            pose,
            Math.exp(dy * PEN_ZOOM_PER_PX),
            ray,
            mode.depthPoint ? viewDepthOf(pose, mode.depthPoint) : null,
          );
        }
        dirtyRef.current = true;
      } else if (mode.kind === 'tool') {
        mode.drag.move(toolPointer(event.clientX, event.clientY, event.shiftKey));
        dirtyRef.current = true;
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
          const snapStep = event.shiftKey ? 0.1 : (mode.snapDeg ?? ANGLE_SNAP_DEG);
          const value = Math.round((mode.start + mode.turned) / snapStep) * snapStep;
          applyHandleValue(mode.handle, value, false);
          dirtyRef.current = true;
        }
      }
    },
    [
      pickAt,
      rayAtClient,
      selectionFromPick,
      onTouchMove,
      updateBox,
      toolPointer,
      beginOrbit,
      endOrbit,
      zoomDepthPointAt,
    ],
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
      if (gesture.mode.kind === 'orbit' && gesture.mode.started) endOrbit();
      if (gesture.mode.kind === 'tool' && gesture.mode.drag.hidesGizmo) dirtyRef.current = true; // gizmo handles come back

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
      if (gesture.penNav) {
        // A pen tap with a navigation modifier: Shift still adds to the selection.
        handleClick(event.clientX, event.clientY, gesture.shiftKey, false);
        return;
      }
      if (gesture.mode.kind !== 'none' && gesture.mode.kind !== 'box') return; // a handle click

      // Settings › Selection extension: every click adds, like touch taps (Shapr3D, macOS).
      handleClick(
        event.clientX,
        event.clientY,
        event.shiftKey || usePreferences.getState().selectionExtension,
        false,
      );
    },
    [contextMenuAt, finishBox, handleClick, onTouchUp, endOrbit],
  );

  const onWheel = useCallback(
    (event: React.WheelEvent<HTMLDivElement>) => {
      animRef.current = null;
      glideRef.current = null;
      const factor = Math.exp(event.deltaY * 0.0012);
      // The zoom stays anchored at the cursor's pixel (zoomAtRay). In perspective the step
      // heads for the depth under the cursor, read once per wheel burst (the pivot rules: into
      // a bore, not through the surface) and kept while the cursor barely moves.
      const now = performance.now();
      let burst = wheelBurstRef.current;
      if (
        !burst ||
        now - burst.time >= WHEEL_BURST_MS ||
        Math.hypot(event.clientX - burst.x, event.clientY - burst.y) > WHEEL_PIVOT_SLOP_PX
      ) {
        burst = {
          x: event.clientX,
          y: event.clientY,
          time: now,
          depthPoint: zoomDepthPointAt(event.clientX, event.clientY),
        };
        wheelBurstRef.current = burst;
      }
      burst.time = now;
      const ray = rayAtClient(event.clientX, event.clientY);
      if (!ray) return;
      const pose = poseRef.current;
      poseRef.current = zoomAtRay(
        pose,
        factor,
        ray,
        burst.depthPoint ? viewDepthOf(pose, burst.depthPoint) : null,
      );
      dirtyRef.current = true;
    },
    [zoomDepthPointAt, rayAtClient],
  );

  const onCubePreset = useCallback((preset: CameraPresetName) => {
    stateRef.current.requestCamera(preset);
  }, []);
  const sendCamera = useCallback(
    (command: CameraCommand) => viewportShell().sendCamera(command),
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
      if (modeOwnsKeyboard()) return;
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
    // Dragging the cube orbits about the target (no point under a cursor) and leaves a standard view.
    standardViewRef.current = false;
    pivotRef.current = null;
    poseRef.current = orbitAbout(poseRef.current, dxPixels, dyPixels, null);
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
      const s = useAssemblerStore.getState();
      const tool = s.activeTool;
      if (!tool) return;
      // The tool says whether it waits for a value (and whether `-` starts one).
      const typed = sceneModel(s).toolView.typedValue;
      if (!typed || (event.key === '-' && !typed.negative)) return;
      if (tool.phase === 'numericEditing') return;
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
      pivotAt: (x, y, runs = 1, stale = true) => {
        // Measurement: the whole pivot determination at a page point. `stale`: the id
        // pass is re-recorded first (as after any camera move), so a run includes drawing it.
        let last: PivotProbe | null = null;
        const times: number[] = [];
        const reads: number[] = [];
        for (let i = 0; i < runs; i += 1) {
          const frame = pickFrameRef.current;
          const renderer = rendererRef.current;
          const input = stale ? sceneInputNow(sizeRef.current) : null;
          if (renderer && frame && input) {
            const built = buildScene(input);
            renderer.renderPicking(
              built.frame.viewProj,
              built.idBatches,
              built.frame.clip,
              sizeRef.current.dpr,
              built.frame.depth?.lineBias ?? 5e-5,
            );
          }
          cursorPivot(x, y);
          last = lastPivotRef.current;
          if (last) {
            times.push(last.ms);
            reads.push(last.readMs);
          }
        }
        return last ? { ...last, times, reads } : null;
      },
    });
    return () => setViewportProbe(null);
  }, [sceneInputNow, cursorPivot]);

  // ---- Dimension chips (screen positions recomputed every drawn frame via `tick`) ----
  const labels = useMemo(() => {
    void tick;
    const host = hostRef.current;
    if (!host || host.clientWidth === 0 || host.clientHeight === 0) return [];
    const vp = viewProjectionMatrix(
      poseRef.current,
      host.clientWidth / Math.max(1, host.clientHeight),
    );
    const project = (p: Vec3) => projectToScreen(vp, p, host.clientWidth, host.clientHeight);
    const out: { label: ToolLabel; screen: readonly [number, number] | null }[] = [];
    // The section plane's offset chip (the viewport's own handle).
    const section = model.handles.find((h) => h.handle === 'section');
    if (section) {
      out.push({
        label: {
          key: 'section',
          label: 'Section offset',
          prefix: state.viewState.sectionPlane ? 'Offset' : `${state.viewState.sectionAxis} =`,
          value: section.value,
          at: handleTip(section),
          commit: (value) => applyHandleValue('section', value),
        },
        screen: project(handleTip(section)),
      });
    }
    for (const label of model.toolView.labels ?? []) {
      out.push({ label, screen: project(label.at) });
    }
    return out;
  }, [tick, model, state.viewState.sectionPlane, state.viewState.sectionAxis]);
  const beginNumericEditing = useCallback(
    () => useAssemblerStore.getState().beginNumericEditing(),
    [],
  );
  const endNumericEditing = useCallback(() => useAssemblerStore.getState().endNumericEditing(), []);

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
        if (gestureRef.current?.mode.kind === 'orbit') endOrbit();
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
        projection={projection}
        onProjection={(mode) => usePreferences.getState().setPreference('projection', mode)}
        onSaveView={() => viewportShell().saveCurrentView()}
      />
      {orbitDot ? (
        <PivotDot point={orbitDot.point} rule={orbitDot.rule} project={projectHost} tick={tick} />
      ) : null}
      {selectThrough ? (
        <SelectThroughChip onTurnOff={() => viewportShell().setSelectThrough(false)} />
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
          // A finger box: the filters are tapped with another finger (Shapr3D).
          {...(touchBoxRef.current
            ? {
                hint: 'Tap a filter with another finger',
                onFilter: (index: number) => {
                  const filter = BOX_FILTERS[index];
                  if (filter) setBox((b) => (b ? { ...b, filter } : b));
                },
              }
            : { hint: 'Tab cycles' })}
        />
      ) : null}
      {pressRing ? (
        <div
          className={styles.pressRing}
          style={{ left: pressRing.x, top: pressRing.y }}
          aria-hidden
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
      {viewportDomOverlays().map(({ id, component: Overlay }) => (
        <Overlay key={id} host={domHost} tick={tick} />
      ))}
      {labels.map(({ label, screen }) =>
        screen ? (
          <DimensionLabel
            key={label.key}
            label={label.label}
            {...(label.prefix ? { prefix: label.prefix } : {})}
            {...(label.unit
              ? {
                  unit:
                    label.unit === 'deg'
                      ? '°'
                      : label.unit === 'count' || label.unit === 'ratio'
                        ? ''
                        : 'mm',
                }
              : {})}
            value={label.value}
            x={screen[0]}
            y={screen[1] - 18}
            invalid={label.invalid === true}
            editRequest={label.takesTyping ? editRequest : null}
            onBeginEdit={beginNumericEditing}
            onCancelEdit={endNumericEditing}
            onCommit={(value) =>
              label.commit ? label.commit(value) : applyHandleValue(label.handle!, value, false)
            }
          />
        ) : null,
      )}{' '}
    </div>
  );
}
