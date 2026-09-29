import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import type { Body, EvaluatedSketch } from '../kernel/types.js';
import { framePoint, frameUv, MIN_FEATURE_SIZE_MM, type SketchFrame } from '../model/document.js';
import {
  consumedSketchIds,
  isSketchVisible,
  sectionRange,
  visibleBounds,
  type Bounds3,
} from '../model/modeling.js';
import {
  findFace,
  isPlanarFace,
  isPreviewTool,
  PREVIEW_FEATURE_ID,
  useAssemblerStore,
  type AssemblerState,
  type SelectionItem,
  type ToolSession,
} from '../model/store.js';
import { setViewportProbe } from './automation.js';
import { findAnchorPixel } from './automation.js';
import {
  DEFAULT_POSE,
  fitPose,
  lerpPose,
  orbit as orbitPose,
  pan as panPose,
  presetPose,
  viewProjectionMatrix,
  zoomTowards,
  type CameraPose,
  type CameraPresetName,
} from './camera.js';
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
import { buildScene, type BuiltScene } from './scene.js';
import { readViewportColors, type ViewportColors } from './theme.js';
import {
  blendHandle,
  handleTip,
  sectionHandle,
  shellHandle,
  type AxisHandle,
} from './toolAnchors.js';
import { ViewCube } from './ViewCube.js';
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
const CIRCLE_SEGMENTS = 96;

function snap(value: number, step: number): number {
  return Math.round(value / step) * step;
}

const AXIS_UNIT: Record<0 | 1 | 2, Vec3> = { 0: [1, 0, 0], 1: [0, 1, 0], 2: [0, 0, 1] };

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
  if (profile.kind === 'face') {
    const body = bodies.find((b) => b.id === profile.face.bodyId);
    const face = body ? findFace(body, profile.face.key) : undefined;
    if (!face?.normal) return null;
    return { origin: face.centroid, normal: face.normal };
  }
  const sketch = sketches.find((s) => s.featureId === profile.featureId);
  if (!sketch) return null;
  const profiles =
    profile.profileIndex !== undefined
      ? sketch.profiles.slice(profile.profileIndex, profile.profileIndex + 1)
      : sketch.profiles;
  if (profiles.length === 0) return null;
  const origin: [number, number, number] = [0, 0, 0];
  for (const p of profiles) {
    for (let i = 0; i < 3; i += 1) origin[i] = origin[i]! + p.center[i]! / profiles.length;
  }
  return { origin, normal: sketch.frame.normal };
}

/** Pure (no React) move-anchor lookup; see {@link computeExtrudeAnchor}. */
function computeMoveAnchor(tool: ToolSession | null, bodies: readonly Body[]): Vec3 | null {
  if (!tool || tool.kind !== 'move') return null;
  const body = bodies.find((b) => b.id === tool.bodyId);
  if (!body) return null;
  return [
    (body.min[0] + body.max[0]) / 2,
    (body.min[1] + body.max[1]) / 2,
    (body.min[2] + body.max[2]) / 2,
  ];
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
}

function sceneModel(s: AssemblerState): SceneModel {
  const tool = s.activeTool;
  const previewTool = isPreviewTool(tool) ? tool : null;
  const preview = previewTool?.previewEvaluation ?? null;
  const bodies = preview?.bodies ?? s.evaluation.bodies;
  const allSketches = preview?.sketches ?? s.evaluation.sketches;
  const consumed = consumedSketchIds(s.features);
  const extruding =
    tool?.kind === 'extrude' && tool.profile.kind === 'sketch' ? tool.profile.featureId : null;
  const sketches = allSketches.filter(
    (sketch) =>
      sketch.featureId === extruding ||
      isSketchVisible(sketch.featureId, consumed, s.sketchVisibility) ||
      s.selection.some((i) => i.kind === 'sketchProfile' && i.featureId === sketch.featureId) ||
      (s.hover?.kind === 'sketchProfile' && s.hover.featureId === sketch.featureId),
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
  }

  const bounds = visibleBounds(s.evaluation.bodies, s.hiddenBodyIds, s.isolatedBodyIds);
  const handles: AxisHandle[] = [];
  if (tool?.kind === 'edgeBlend') {
    const handle = blendHandle(tool, s.evaluation.bodies);
    if (handle) handles.push(handle);
  } else if (tool?.kind === 'shell') {
    const handle = shellHandle(tool, s.evaluation.bodies);
    if (handle) handles.push(handle);
  }
  if (s.viewState.sectionEnabled) {
    handles.push(
      sectionHandle(
        {
          axis: s.viewState.sectionAxis,
          offset: s.viewState.sectionOffset,
          flipped: s.viewState.sectionFlipped,
        },
        bounds,
      ),
    );
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
  };
}

/** The sketch frame of the active rectangle/circle tool, read fresh from the store. */
function activeSketchFrame(): SketchFrame | null {
  const tool = useAssemblerStore.getState().activeTool;
  return tool?.kind === 'sketchRectangle' || tool?.kind === 'sketchCircle' ? tool.frame : null;
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
      startDelta: { dx: number; dy: number; dz: number };
    }
  | {
      kind: 'axisHandle';
      handle: ToolHandleKind;
      origin: Vec3;
      dir: Vec3;
      t0: number;
      start: number;
    };

interface PointerGesture {
  button: number;
  startX: number;
  startY: number;
  lastX: number;
  lastY: number;
  moved: boolean;
  mode: DragMode;
  /**
   * Set when pointerdown already fully handled this click (the sketch
   * tools' point clicks). The matching pointerup must not fall through to
   * selection/context-menu handling — by then `commit()` may already have
   * cleared `activeTool` and set a fresh selection that a generic "click
   * picked nothing, clear selection" would wipe out.
   */
  handledOnDown: boolean;
}

type HandleHover =
  | { kind: 'extrudeHandle' }
  | { kind: 'moveHandle'; axis: 0 | 1 | 2 }
  | { kind: 'toolHandle'; handle: ToolHandleKind };

/** Applies a dragged/typed handle value to the store (clamped, snapped). */
function applyHandleValue(handle: ToolHandleKind, raw: number): void {
  const s = useAssemblerStore.getState();
  if (handle === 'blend') s.setBlendSize(Math.max(HANDLE_STEP_MM, snap(raw, HANDLE_STEP_MM)));
  else if (handle === 'shell')
    s.setShellThickness(Math.max(MIN_FEATURE_SIZE_MM, snap(raw, HANDLE_STEP_MM)));
  else {
    const bounds = visibleBounds(s.evaluation.bodies, s.hiddenBodyIds, s.isolatedBodyIds);
    const [lo, hi] = sectionRange(bounds, s.viewState.sectionAxis);
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
  const poseRef = useRef<CameraPose>(DEFAULT_POSE);
  const animRef = useRef<{
    from: CameraPose;
    to: CameraPose;
    start: number;
    duration: number;
  } | null>(null);
  const dirtyRef = useRef(true);
  const sizeRef = useRef({ width: 1, height: 1, dpr: 1 });
  const gestureRef = useRef<PointerGesture | null>(null);
  const rectCornerRef = useRef<{ u: number; v: number } | null>(null);
  const lastClickRef = useRef<{ time: number; x: number; y: number } | null>(null);
  const hoverRafRef = useRef<number | null>(null);
  const pendingHoverRef = useRef<{ x: number; y: number } | null>(null);
  const lastPickTableRef = useRef<BuiltScene['pickTable'] | null>(null);
  const didInitialFitRef = useRef(false);
  const frameWaitersRef = useRef<(() => void)[]>([]);
  /** Handle hover state, set from the same hover-pick loop as body/face/edge hover but kept
   * out of the store (it's transient tool chrome, not a document selection concept). */
  const handleHoverRef = useRef<HandleHover | null>(null);
  /** World-space cursor position on the active sketch plane (snapped to grid), for the snap-indicator dot. */
  const sketchCursorRef = useRef<Vec3 | null>(null);
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
        poseRef.current = fitPose(stateRef.current.evaluation.bodies, DEFAULT_POSE, aspect);
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
    poseRef.current = fitPose(firstBodies, DEFAULT_POSE, host.clientWidth / host.clientHeight);
    dirtyRef.current = true;
  }, [firstBodies]);

  // ---- Camera preset requests ----------------------------------------------
  const lastCameraNonce = useRef<number | null>(null);
  useEffect(() => {
    const request = state.viewState.cameraRequest;
    if (!request || request.nonce === lastCameraNonce.current) return;
    lastCameraNonce.current = request.nonce;
    const host = hostRef.current;
    const aspect = host ? host.clientWidth / Math.max(1, host.clientHeight) : 1;
    const current = poseRef.current;
    const next =
      request.preset === 'fit'
        ? fitPose(state.evaluation.bodies, current, aspect)
        : presetPose(request.preset, current);
    const reduceMotion =
      typeof window !== 'undefined' &&
      window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    if (reduceMotion) {
      poseRef.current = next;
    } else {
      animRef.current = { from: current, to: next, start: performance.now(), duration: 300 };
    }
    dirtyRef.current = true;
  }, [state.viewState.cameraRequest, state.evaluation.bodies]);

  const activeTool = state.activeTool;
  const model = useMemo(() => sceneModel(state), [state]);

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
      const { width, height, dpr } = sizeRef.current;
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
      const moveHandle =
        currentTool?.kind === 'move' && moveAnchorNow
          ? {
              origin: moveAnchorNow,
              delta: currentTool.delta,
              hoveredAxis: handleHover?.kind === 'moveHandle' ? handleHover.axis : null,
            }
          : null;
      let sketchPreview: {
        corners: [Vec3, Vec3, Vec3, Vec3] | null;
        cursorPoint: Vec3 | null;
        outline: Vec3[] | null;
        center: Vec3 | null;
      } | null = null;
      if (currentTool?.kind === 'sketchRectangle') {
        let corners: [Vec3, Vec3, Vec3, Vec3] | null = null;
        if (currentTool.preview) {
          const plane = currentTool.frame;
          const p = currentTool.preview;
          corners = [
            framePoint(plane, p.x, p.y),
            framePoint(plane, p.x + p.width, p.y),
            framePoint(plane, p.x + p.width, p.y + p.height),
            framePoint(plane, p.x, p.y + p.height),
          ];
        }
        sketchPreview = {
          corners,
          cursorPoint: sketchCursorRef.current,
          outline: null,
          center: null,
        };
      } else if (currentTool?.kind === 'sketchCircle') {
        const { frame, center, radius } = currentTool;
        let outline: Vec3[] | null = null;
        if (center && radius) {
          outline = [];
          for (let i = 0; i < CIRCLE_SEGMENTS; i += 1) {
            const a = (i / CIRCLE_SEGMENTS) * Math.PI * 2;
            outline.push(
              framePoint(frame, center.u + Math.cos(a) * radius, center.v + Math.sin(a) * radius),
            );
          }
        }
        sketchPreview = {
          corners: null,
          cursorPoint: sketchCursorRef.current,
          outline,
          center: center ? framePoint(frame, center.u, center.v) : null,
        };
      }
      const movePreview =
        currentTool?.kind === 'move'
          ? { bodyId: currentTool.bodyId, delta: currentTool.delta }
          : null;
      const built = buildScene({
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
        },
        gridVisible: current.viewState.gridVisible,
        gridStep: current.viewState.gridStep,
        selection: current.selection,
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
        sketchPreview,
      });
      renderer.render(built.frame);
      renderer.renderPicking(built.frame.viewProj, built.idBatches, built.frame.clip);
      lastPickTableRef.current = built.pickTable;
      setTick((v) => (v + 1) % 1_000_000);
      const waiters = frameWaitersRef.current;
      frameWaitersRef.current = [];
      for (const resolve of waiters) resolve();
    };
    handle = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(handle);
  }, []);

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
      if (pick.kind === 'extrudeHandle' || pick.kind === 'moveHandle' || pick.kind === 'toolHandle')
        return null;
      if (pick.kind === 'sketchProfile')
        return { kind: 'sketchProfile', featureId: pick.featureId };
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

  /** Sketch (u, v) of the pointer on the active sketch plane, grid-snapped when snapping is on. */
  const sketchUvAt = useCallback(
    (
      clientX: number,
      clientY: number,
    ): { raw: { u: number; v: number }; snapped: { u: number; v: number } } | null => {
      const frame = activeSketchFrame();
      const ray = rayAtClient(clientX, clientY);
      if (!frame || !ray) return null;
      const hit = rayPlaneIntersect(ray.origin, ray.direction, frame.origin, frame.normal);
      if (!hit) return null;
      const raw = frameUv(frame, hit);
      const view = useAssemblerStore.getState().viewState;
      const snapped = view.snapToGrid
        ? { u: snap(raw.u, view.gridStep), v: snap(raw.v, view.gridStep) }
        : raw;
      return { raw, snapped };
    },
    [rayAtClient],
  );

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
        return { kind: 'moveAxis', origin: moveAnchor, axis: pick.axis, startDelta: tool.delta };
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

  // ---- Pointer handlers -----------------------------------------------------
  const onPointerDown = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      const host = hostRef.current;
      if (!host) return;
      host.setPointerCapture(event.pointerId);
      animRef.current = null;

      const store = useAssemblerStore.getState();
      const tool = store.activeTool;
      const sketching = tool?.kind === 'sketchRectangle' || tool?.kind === 'sketchCircle';

      if (sketching && event.button === 0) {
        const firstPoint =
          (tool.kind === 'sketchRectangle' && !rectCornerRef.current) ||
          (tool.kind === 'sketchCircle' && !tool.center);
        if (firstPoint) {
          // Shapr3D: the first click on a planar body face picks the sketch plane.
          const pick = pickAt(event.clientX, event.clientY);
          if (pick?.kind === 'face' && isPlanarFace(store.evaluation, pick.bodyId, pick.faceKey)) {
            store.setSketchPlaneFace(pick.bodyId, pick.faceKey);
          }
        }
        const uv = sketchUvAt(event.clientX, event.clientY);
        if (uv) {
          const s = useAssemblerStore.getState();
          const current = s.activeTool;
          if (current?.kind === 'sketchRectangle') {
            if (!rectCornerRef.current) {
              rectCornerRef.current = uv.snapped;
            } else {
              const corner = rectCornerRef.current;
              s.setPreviewRect(
                corner.u,
                corner.v,
                uv.snapped.u - corner.u,
                uv.snapped.v - corner.v,
              );
              s.commit();
              rectCornerRef.current = null;
            }
          } else if (current?.kind === 'sketchCircle') {
            if (!current.center) {
              s.setCircleCenter(uv.snapped.u, uv.snapped.v);
            } else if (current.radius !== null && current.radius >= MIN_FEATURE_SIZE_MM / 2) {
              s.commit();
            }
          }
          dirtyRef.current = true;
        }
        gestureRef.current = {
          button: event.button,
          startX: event.clientX,
          startY: event.clientY,
          lastX: event.clientX,
          lastY: event.clientY,
          moved: false,
          mode: { kind: 'none' },
          handledOnDown: true,
        };
        return;
      }

      let mode: DragMode = { kind: 'none' };
      if (event.button === 2 && !event.shiftKey) mode = { kind: 'orbit' };
      else if (event.button === 1 || (event.button === 2 && event.shiftKey)) mode = { kind: 'pan' };
      else if (event.button === 0) {
        const handleHit = findHandleHit(event.clientX, event.clientY);
        if (handleHit) mode = handleHit;
      }
      gestureRef.current = {
        button: event.button,
        startX: event.clientX,
        startY: event.clientY,
        lastX: event.clientX,
        lastY: event.clientY,
        moved: false,
        mode,
        handledOnDown: false,
      };
    },
    [findHandleHit, pickAt, sketchUvAt],
  );

  const onPointerMove = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      const store = useAssemblerStore.getState();
      const tool = store.activeTool;
      if (tool?.kind === 'sketchRectangle' || tool?.kind === 'sketchCircle') {
        const uv = sketchUvAt(event.clientX, event.clientY);
        if (uv) {
          const frame = tool.frame;
          // Snap indicator dot follows the cursor on the grid whether or not
          // the first point has been placed yet.
          sketchCursorRef.current = framePoint(frame, uv.snapped.u, uv.snapped.v);
          if (tool.kind === 'sketchRectangle') {
            const corner = rectCornerRef.current;
            if (corner) {
              store.setPreviewRect(
                corner.u,
                corner.v,
                uv.snapped.u - corner.u,
                uv.snapped.v - corner.v,
              );
            }
          } else if (tool.center && tool.phase !== 'numericEditing') {
            const distance = Math.hypot(uv.raw.u - tool.center.u, uv.raw.v - tool.center.v);
            const step = store.viewState.snapToGrid ? store.viewState.gridStep / 2 : 0;
            const radius = step > 0 ? Math.max(step, snap(distance, step)) : distance;
            store.setCircleRadius(radius);
            const a = Math.atan2(uv.raw.v - tool.center.v, uv.raw.u - tool.center.u);
            sketchCursorRef.current = framePoint(
              frame,
              tool.center.u + Math.cos(a) * radius,
              tool.center.v + Math.sin(a) * radius,
            );
          }
          dirtyRef.current = true;
        }
      }

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
      if (mode.kind === 'orbit') {
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
          const unit = AXIS_UNIT[mode.axis];
          const t = closestPointOnLineToRay(mode.origin, unit, ray.origin, ray.direction);
          const next = { ...mode.startDelta };
          if (mode.axis === 0) next.dx = t;
          else if (mode.axis === 1) next.dy = t;
          else next.dz = t;
          store.setDelta(next.dx, next.dy, next.dz);
          dirtyRef.current = true;
        }
      } else if (mode.kind === 'axisHandle') {
        const ray = rayAtClient(event.clientX, event.clientY);
        if (ray) {
          const t = closestPointOnLineToRay(mode.origin, mode.dir, ray.origin, ray.direction);
          applyHandleValue(mode.handle, mode.start + (t - mode.t0));
          dirtyRef.current = true;
        }
      }
    },
    [pickAt, rayAtClient, selectionFromPick, sketchUvAt],
  );

  const onPointerUp = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      const gesture = gestureRef.current;
      gestureRef.current = null;
      if (!gesture) return;
      if (gesture.handledOnDown) return; // e.g. a sketch tool's click already committed

      if (gesture.moved) return; // a real drag never selects/opens the context menu

      if (gesture.button === 2) {
        const pick = pickAt(event.clientX, event.clientY);
        props.onContextMenu?.({
          clientX: event.clientX,
          clientY: event.clientY,
          target: selectionFromPick(pick, false),
        });
        return;
      }
      if (gesture.button !== 0) return;
      if (gesture.mode.kind !== 'none') return; // a handle click without a drag

      const now = performance.now();
      const last = lastClickRef.current;
      const isDouble =
        !!last &&
        now - last.time < DOUBLE_CLICK_MS &&
        Math.hypot(event.clientX - last.x, event.clientY - last.y) < 8;
      lastClickRef.current = { time: now, x: event.clientX, y: event.clientY };

      const store = useAssemblerStore.getState();
      const tool = store.activeTool;
      const pick = pickAt(event.clientX, event.clientY);
      if (tool?.kind === 'edgeBlend' || tool?.kind === 'shell' || tool?.kind === 'boolean') {
        // Adaptive tools: clicking empty space finishes (Shapr3D); edges add/remove.
        if (!pick) store.commit();
        else if (pick.kind === 'edge' && tool.kind === 'edgeBlend') {
          store.toggleBlendEdge(pick.bodyId, pick.edgeKey);
        }
        return;
      }
      if (!pick) {
        store.clearSelection();
        return;
      }
      const item = selectionFromPick(pick, isDouble);
      if (!item) return;
      store.select(item, { additive: event.shiftKey });
    },
    [pickAt, props, selectionFromPick],
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

  const onCubePreset = useCallback((preset: CameraPresetName | 'iso') => {
    stateRef.current.requestCamera(preset);
  }, []);

  const onCubeOrbitDrag = useCallback((dxPixels: number, dyPixels: number) => {
    animRef.current = null;
    poseRef.current = orbitPose(poseRef.current, dxPixels, dyPixels);
    dirtyRef.current = true;
  }, []);

  // Clear the transient sketch state when a sketch tool ends.
  useEffect(() => {
    if (activeTool?.kind !== 'sketchRectangle') rectCornerRef.current = null;
    if (activeTool?.kind !== 'sketchRectangle' && activeTool?.kind !== 'sketchCircle') {
      sketchCursorRef.current = null;
    }
  }, [activeTool]);

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
      if (event.key === '-' && tool?.kind !== 'extrude') return; // only extrude takes negatives
      const accepts =
        (tool?.kind === 'sketchCircle' && tool.center !== null) ||
        tool?.kind === 'edgeBlend' ||
        tool?.kind === 'shell' ||
        tool?.kind === 'extrude';
      if (!accepts || tool.phase === 'numericEditing') return;
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
    });
    return () => setViewportProbe(null);
  }, []);

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

    const handleChips = model.handles.map((h) => ({ handle: h, screen: project(handleTip(h)) }));

    if (activeTool?.kind === 'sketchRectangle' && activeTool.preview) {
      const frame = activeTool.frame;
      const p = activeTool.preview;
      return {
        kind: 'rectangle' as const,
        handleChips,
        widthScreen: project(framePoint(frame, p.x + p.width / 2, p.y)),
        heightScreen: project(framePoint(frame, p.x, p.y + p.height / 2)),
        width: Math.abs(p.width),
        height: Math.abs(p.height),
      };
    }
    if (activeTool?.kind === 'sketchCircle' && activeTool.center) {
      const { frame, center, radius } = activeTool;
      const r = radius ?? 0;
      const at = framePoint(frame, center.u + r * Math.SQRT1_2, center.v + r * Math.SQRT1_2);
      return { kind: 'circle' as const, handleChips, screen: project(at), radius: r };
    }
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
      };
    }
    if (activeTool?.kind === 'move' && moveAnchor) {
      const centre: Vec3 = [
        moveAnchor[0] + activeTool.delta.dx,
        moveAnchor[1] + activeTool.delta.dy,
        moveAnchor[2] + activeTool.delta.dz,
      ];
      const axisLabels = ([0, 1, 2] as const).map((axisIndex) => {
        const unit = AXIS_UNIT[axisIndex];
        const tip: Vec3 = [
          centre[0] + unit[0] * HANDLE_LENGTH_MM,
          centre[1] + unit[1] * HANDLE_LENGTH_MM,
          centre[2] + unit[2] * HANDLE_LENGTH_MM,
        ];
        return {
          axis: axisIndex,
          value:
            axisIndex === 0
              ? activeTool.delta.dx
              : axisIndex === 1
                ? activeTool.delta.dy
                : activeTool.delta.dz,
          screen: project(tip),
        };
      });
      return { kind: 'move' as const, handleChips, axisLabels };
    }
    return { kind: 'handles' as const, handleChips };
  }, [tick, activeTool, extrudeAnchor, moveAnchor, model.handles]);

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
      onPointerCancel={() => {
        gestureRef.current = null;
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
        yawRadians={poseRef.current.yaw}
        pitchRadians={poseRef.current.pitch}
        onPreset={onCubePreset}
        onOrbitDrag={onCubeOrbitDrag}
      />
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
            ? `${state.viewState.sectionAxis} =`
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
      {overlay?.kind === 'rectangle' && overlay.widthScreen && (
        <DimensionLabel
          label="Width"
          value={overlay.width}
          x={overlay.widthScreen[0]}
          y={overlay.widthScreen[1] - 18}
          onBeginEdit={beginNumericEditing}
          onCancelEdit={endNumericEditing}
          onCommit={(value) => {
            const tool = useAssemblerStore.getState().activeTool;
            if (tool?.kind === 'sketchRectangle' && tool.preview) {
              const p = tool.preview;
              const sign = p.width < 0 ? -1 : 1;
              useAssemblerStore.getState().setPreviewRect(p.x, p.y, value * sign, p.height);
            }
          }}
        />
      )}
      {overlay?.kind === 'rectangle' && overlay.heightScreen && (
        <DimensionLabel
          label="Height"
          value={overlay.height}
          x={overlay.heightScreen[0] + 18}
          y={overlay.heightScreen[1]}
          onBeginEdit={beginNumericEditing}
          onCancelEdit={endNumericEditing}
          onCommit={(value) => {
            const tool = useAssemblerStore.getState().activeTool;
            if (tool?.kind === 'sketchRectangle' && tool.preview) {
              const p = tool.preview;
              const sign = p.height < 0 ? -1 : 1;
              useAssemblerStore.getState().setPreviewRect(p.x, p.y, p.width, value * sign);
            }
          }}
        />
      )}
      {overlay?.kind === 'circle' && overlay.screen && activeTool?.kind === 'sketchCircle' && (
        <DimensionLabel
          label={activeTool.dimension === 'diameter' ? 'Circle diameter' : 'Circle radius'}
          prefix={activeTool.dimension === 'diameter' ? 'Ø' : 'R'}
          value={activeTool.dimension === 'diameter' ? overlay.radius * 2 : overlay.radius}
          x={overlay.screen[0] + 22}
          y={overlay.screen[1] - 22}
          editRequest={chipRequest('sketchCircle')}
          onBeginEdit={beginNumericEditing}
          onCancelEdit={endNumericEditing}
          onCommit={(value) => {
            const s = useAssemblerStore.getState();
            const tool = s.activeTool;
            if (tool?.kind !== 'sketchCircle') return;
            const radius = tool.dimension === 'diameter' ? value / 2 : value;
            if (!(radius >= MIN_FEATURE_SIZE_MM / 2)) return;
            // A typed value completes the circle, like a second click.
            s.setCircleRadius(radius);
            s.commit();
          }}
        />
      )}
      {overlay?.kind === 'extrude' && overlay.screen && (
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
                label={['X offset', 'Y offset', 'Z offset'][a.axis]!}
                value={a.value}
                x={a.screen[0]}
                y={a.screen[1] - 18}
                onBeginEdit={beginNumericEditing}
                onCancelEdit={endNumericEditing}
                onCommit={(value) => {
                  const s = useAssemblerStore.getState();
                  const tool = s.activeTool;
                  if (tool?.kind !== 'move') return;
                  const next = { ...tool.delta };
                  if (a.axis === 0) next.dx = value;
                  else if (a.axis === 1) next.dy = value;
                  else next.dz = value;
                  s.setDelta(next.dx, next.dy, next.dz);
                }}
              />
            ),
        )}
    </div>
  );
}
