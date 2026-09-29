import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import type { Body, EvaluatedSketch } from '../model/mockDocument.js';
import { useAssemblerStore, type SelectionItem, type ToolSession } from '../model/store.js';
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
import type { PickTarget } from './picking.js';
import { buildScene, type BuiltScene } from './scene.js';
import { readViewportColors, type ViewportColors } from './theme.js';
import { ViewCube } from './ViewCube.js';
import styles from './Viewport.module.css';

export interface ViewportProps {
  onContextMenu?: (e: { clientX: number; clientY: number; target: SelectionItem | null }) => void;
}

const CLICK_DRAG_THRESHOLD_PX = 4;
const DOUBLE_CLICK_MS = 400;
/** Matches `scene.ts`'s `MOVE_HANDLE_LENGTH_MM`. */
const HANDLE_LENGTH_MM = 40;

interface PlaneEmbedding {
  origin: Vec3;
  normal: Vec3;
  u: Vec3;
  v: Vec3;
}

function planeEmbedding(plane: 'XY' | 'XZ' | 'YZ', offset: number): PlaneEmbedding {
  if (plane === 'XY')
    return { origin: [0, 0, offset], normal: [0, 0, 1], u: [1, 0, 0], v: [0, 1, 0] };
  if (plane === 'XZ')
    return { origin: [0, offset, 0], normal: [0, 1, 0], u: [1, 0, 0], v: [0, 0, 1] };
  return { origin: [offset, 0, 0], normal: [1, 0, 0], u: [0, 1, 0], v: [0, 0, 1] };
}

function toPlaneUv(point: Vec3, plane: PlaneEmbedding): { u: number; v: number } {
  const rel: Vec3 = [
    point[0] - plane.origin[0],
    point[1] - plane.origin[1],
    point[2] - plane.origin[2],
  ];
  return {
    u: rel[0] * plane.u[0] + rel[1] * plane.u[1] + rel[2] * plane.u[2],
    v: rel[0] * plane.v[0] + rel[1] * plane.v[1] + rel[2] * plane.v[2],
  };
}

function fromPlaneUv(u: number, v: number, plane: PlaneEmbedding): Vec3 {
  return [
    plane.origin[0] + plane.u[0] * u + plane.v[0] * v,
    plane.origin[1] + plane.u[1] * u + plane.v[1] * v,
    plane.origin[2] + plane.u[2] * u + plane.v[2] * v,
  ];
}

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
    const body = bodies.find((b) => b.id === profile.bodyId);
    if (!body) return null;
    const axis = profile.side[1] === 'X' ? 0 : profile.side[1] === 'Y' ? 1 : 2;
    const sign = profile.side[0] === '+' ? 1 : -1;
    const coord = sign > 0 ? body.max[axis] : body.min[axis];
    const center: Vec3 = [
      axis === 0 ? coord : (body.min[0] + body.max[0]) / 2,
      axis === 1 ? coord : (body.min[1] + body.max[1]) / 2,
      axis === 2 ? coord : (body.min[2] + body.max[2]) / 2,
    ];
    const normal: Vec3 = [axis === 0 ? sign : 0, axis === 1 ? sign : 0, axis === 2 ? sign : 0];
    return { origin: center, normal };
  }
  const sketch = sketches.find((s) => s.featureId === profile.featureId);
  if (!sketch) return null;
  const plane = planeEmbedding(sketch.plane, sketch.offset);
  const cu = (sketch.min[0] + sketch.max[0]) / 2;
  const cv = (sketch.min[1] + sketch.max[1]) / 2;
  return { origin: fromPlaneUv(cu, cv, plane), normal: plane.normal };
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
   * Set when pointerdown already fully handled this click (the rectangle
   * tool's first/second corner clicks). The matching pointerup must not
   * fall through to selection/context-menu handling — by then `commit()`
   * may already have cleared `activeTool` and set a fresh selection that a
   * generic "click picked nothing, clear selection" would wipe out.
   */
  handledOnDown: boolean;
}

/**
 * The Assembler 3D viewport: WebGL2 scene (grid/axes/bodies/sketches),
 * Shapr3D-style orbit camera, click/hover picking, the view cube, and the
 * three Phase 0 tools' live previews. Fills its parent (`position: relative`
 * host); the chrome places it full-bleed under the floating islands.
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
  /** Arrow-handle hover state, set from the same hover-pick loop as body/face/edge hover but kept
   * out of the store (it's transient tool chrome, not a document selection concept). */
  const handleHoverRef = useRef<
    { kind: 'extrudeHandle' } | { kind: 'moveHandle'; axis: 0 | 1 | 2 } | null
  >(null);
  /** World-space cursor position on the active sketch plane (snapped to grid), for the snap-indicator dot. */
  const sketchCursorRef = useRef<Vec3 | null>(null);

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
      if (!didInitialFitRef.current && host.clientWidth > 0 && host.clientHeight > 0) {
        didInitialFitRef.current = true;
        const aspect = host.clientWidth / Math.max(1, host.clientHeight);
        poseRef.current = fitPose(stateRef.current.evaluation.bodies, DEFAULT_POSE, aspect);
      }
      dirtyRef.current = true;
    });
    observer.observe(host);
    return () => observer.disconnect();
  }, []);

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

  const sectionState = useMemo(
    () => ({
      enabled: state.viewState.sectionEnabled,
      axis: state.viewState.sectionAxis,
      offset: state.viewState.sectionOffset,
    }),
    [state.viewState.sectionEnabled, state.viewState.sectionAxis, state.viewState.sectionOffset],
  );

  const activeTool = state.activeTool;
  const displayedBodies =
    activeTool?.kind === 'extrude' ? activeTool.previewEvaluation.bodies : state.evaluation.bodies;
  const displayedSketches =
    activeTool?.kind === 'extrude'
      ? activeTool.previewEvaluation.sketches
      : state.evaluation.sketches;
  const extrudePreviewBodyId = useMemo(() => {
    if (activeTool?.kind !== 'extrude') return null;
    const before = new Set(state.evaluation.bodies.map((b) => b.id));
    const created = activeTool.previewEvaluation.bodies.find((b) => !before.has(b.id));
    if (created) return created.id;
    if (activeTool.profile.kind === 'face') return activeTool.profile.bodyId;
    return null;
  }, [activeTool, state.evaluation.bodies]);
  const movePreview = useMemo(
    () =>
      activeTool?.kind === 'move' ? { bodyId: activeTool.bodyId, delta: activeTool.delta } : null,
    [activeTool],
  );

  // ---- Render loop ----------------------------------------------------------
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
      const { width, height } = sizeRef.current;
      const aspect = width / Math.max(1, height);
      const current = stateRef.current;
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
      } | null = null;
      if (currentTool?.kind === 'sketchRectangle') {
        let corners: [Vec3, Vec3, Vec3, Vec3] | null = null;
        if (currentTool.preview) {
          const plane = planeEmbedding(currentTool.plane, currentTool.offset);
          const p = currentTool.preview;
          corners = [
            fromPlaneUv(p.x, p.y, plane),
            fromPlaneUv(p.x + p.width, p.y, plane),
            fromPlaneUv(p.x + p.width, p.y + p.height, plane),
            fromPlaneUv(p.x, p.y + p.height, plane),
          ];
        }
        sketchPreview = { corners, cursorPoint: sketchCursorRef.current };
      }
      const built = buildScene({
        colors,
        pose: poseRef.current,
        aspect,
        viewportHeightPx: height,
        bodies: displayedBodies,
        sketches: displayedSketches,
        hiddenBodyIds: current.hiddenBodyIds,
        isolatedBodyIds: current.isolatedBodyIds,
        displayMode: current.viewState.displayMode,
        section: sectionState,
        gridVisible: current.viewState.gridVisible,
        gridStep: current.viewState.gridStep,
        selection: current.selection,
        hover: current.hover,
        movePreview,
        extrudePreviewBodyId,
        extrudeHandle,
        moveHandle,
        sketchPreview,
      });
      renderer.render(built.frame);
      renderer.renderPicking(built.frame.viewProj, built.idBatches, built.frame.clip);
      lastPickTableRef.current = built.pickTable;
      setTick((v) => (v + 1) % 1_000_000);
    };
    handle = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(handle);
  }, [displayedBodies, displayedSketches, sectionState, movePreview, extrudePreviewBodyId]);

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
      if (pick.kind === 'extrudeHandle' || pick.kind === 'moveHandle') return null;
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

  const rectanglePlane = useMemo(() => {
    if (activeTool?.kind !== 'sketchRectangle') return null;
    return planeEmbedding(activeTool.plane, activeTool.offset);
  }, [activeTool]);

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
      const tool = stateRef.current.activeTool;
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
      return null;
    },
    [extrudeAnchor, moveAnchor, pickAt],
  );

  // ---- Pointer handlers -----------------------------------------------------
  const onPointerDown = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      const host = hostRef.current;
      if (!host) return;
      host.setPointerCapture(event.pointerId);
      animRef.current = null;

      const tool = stateRef.current.activeTool;

      if (tool?.kind === 'sketchRectangle' && event.button === 0 && rectanglePlane) {
        const ray = rayAtClient(event.clientX, event.clientY);
        const hit =
          ray &&
          rayPlaneIntersect(
            ray.origin,
            ray.direction,
            rectanglePlane.origin,
            rectanglePlane.normal,
          );
        if (hit) {
          const uv = toPlaneUv(hit, rectanglePlane);
          const snapped = stateRef.current.viewState.snapToGrid
            ? {
                u: snap(uv.u, stateRef.current.viewState.gridStep),
                v: snap(uv.v, stateRef.current.viewState.gridStep),
              }
            : uv;
          if (!rectCornerRef.current) {
            rectCornerRef.current = snapped;
          } else {
            const corner = rectCornerRef.current;
            stateRef.current.setPreviewRect(
              corner.u,
              corner.v,
              snapped.u - corner.u,
              snapped.v - corner.v,
            );
            stateRef.current.commit();
            rectCornerRef.current = null;
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
    [rectanglePlane, rayAtClient, findHandleHit],
  );

  const onPointerMove = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      const tool = stateRef.current.activeTool;
      if (tool?.kind === 'sketchRectangle' && rectanglePlane) {
        const ray = rayAtClient(event.clientX, event.clientY);
        const hit =
          ray &&
          rayPlaneIntersect(
            ray.origin,
            ray.direction,
            rectanglePlane.origin,
            rectanglePlane.normal,
          );
        if (hit) {
          const uv = toPlaneUv(hit, rectanglePlane);
          const snapped = stateRef.current.viewState.snapToGrid
            ? {
                u: snap(uv.u, stateRef.current.viewState.gridStep),
                v: snap(uv.v, stateRef.current.viewState.gridStep),
              }
            : uv;
          // Snap indicator dot follows the cursor on the grid whether or not
          // the first corner has been placed yet.
          sketchCursorRef.current = fromPlaneUv(snapped.u, snapped.v, rectanglePlane);
          const corner = rectCornerRef.current;
          if (corner) {
            stateRef.current.setPreviewRect(
              corner.u,
              corner.v,
              snapped.u - corner.u,
              snapped.v - corner.v,
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
            if (pick?.kind === 'extrudeHandle' || pick?.kind === 'moveHandle') {
              const nextHover =
                pick.kind === 'extrudeHandle' ? { kind: 'extrudeHandle' as const } : pick;
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
      if (gesture.mode.kind === 'orbit') {
        poseRef.current = orbitPose(poseRef.current, dx, dy);
        dirtyRef.current = true;
      } else if (gesture.mode.kind === 'pan') {
        poseRef.current = panPose(poseRef.current, dx, dy, height);
        dirtyRef.current = true;
      } else if (gesture.mode.kind === 'extrudeHandle') {
        const ray = rayAtClient(event.clientX, event.clientY);
        if (ray) {
          const t = closestPointOnLineToRay(
            gesture.mode.origin,
            gesture.mode.normal,
            ray.origin,
            ray.direction,
          );
          stateRef.current.setDistance(t);
          dirtyRef.current = true;
        }
      } else if (gesture.mode.kind === 'moveAxis') {
        const ray = rayAtClient(event.clientX, event.clientY);
        if (ray) {
          const unit = AXIS_UNIT[gesture.mode.axis];
          const t = closestPointOnLineToRay(gesture.mode.origin, unit, ray.origin, ray.direction);
          const next = { ...gesture.mode.startDelta };
          if (gesture.mode.axis === 0) next.dx = t;
          else if (gesture.mode.axis === 1) next.dy = t;
          else next.dz = t;
          stateRef.current.setDelta(next.dx, next.dy, next.dz);
          dirtyRef.current = true;
        }
      }
    },
    [pickAt, rayAtClient, rectanglePlane, selectionFromPick],
  );

  const onPointerUp = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      const gesture = gestureRef.current;
      gestureRef.current = null;
      if (!gesture) return;
      if (gesture.handledOnDown) return; // e.g. the rectangle tool's click already committed

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

      const now = performance.now();
      const last = lastClickRef.current;
      const isDouble =
        !!last &&
        now - last.time < DOUBLE_CLICK_MS &&
        Math.hypot(event.clientX - last.x, event.clientY - last.y) < 8;
      lastClickRef.current = { time: now, x: event.clientX, y: event.clientY };

      const pick = pickAt(event.clientX, event.clientY);
      if (!pick) {
        stateRef.current.clearSelection();
        return;
      }
      const item = selectionFromPick(pick, isDouble);
      if (!item) return;
      stateRef.current.select(item, { additive: event.shiftKey });
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

  // ---- Dimension label overlay data (recomputed every drawn frame via `tick`) ----
  const overlay = useMemo(() => {
    void tick;
    const host = hostRef.current;
    if (!host || !activeTool) return null;
    const rect = { width: host.clientWidth, height: host.clientHeight };
    if (rect.width === 0 || rect.height === 0) return null;
    const aspect = rect.width / Math.max(1, rect.height);
    const vp = viewProjectionMatrix(poseRef.current, aspect);

    if (activeTool.kind === 'sketchRectangle' && activeTool.preview && rectanglePlane) {
      const p = activeTool.preview;
      const widthMidWorld = fromPlaneUv(p.x + p.width / 2, p.y, rectanglePlane);
      const heightMidWorld = fromPlaneUv(p.x, p.y + p.height / 2, rectanglePlane);
      const widthScreen = projectToScreen(vp, widthMidWorld, rect.width, rect.height);
      const heightScreen = projectToScreen(vp, heightMidWorld, rect.width, rect.height);
      return {
        kind: 'rectangle' as const,
        widthScreen,
        heightScreen,
        width: Math.abs(p.width),
        height: Math.abs(p.height),
      };
    }
    if (activeTool.kind === 'extrude' && extrudeAnchor) {
      const tip: Vec3 = [
        extrudeAnchor.origin[0] + extrudeAnchor.normal[0] * activeTool.distance,
        extrudeAnchor.origin[1] + extrudeAnchor.normal[1] * activeTool.distance,
        extrudeAnchor.origin[2] + extrudeAnchor.normal[2] * activeTool.distance,
      ];
      const screen = projectToScreen(vp, tip, rect.width, rect.height);
      return { kind: 'extrude' as const, screen, distance: activeTool.distance };
    }
    if (activeTool.kind === 'move' && moveAnchor) {
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
          screen: projectToScreen(vp, tip, rect.width, rect.height),
        };
      });
      return { kind: 'move' as const, axisLabels };
    }
    return null;
  }, [tick, activeTool, rectanglePlane, extrudeAnchor, moveAnchor]);

  const beginNumericEditing = useCallback(() => stateRef.current.beginNumericEditing(), []);
  const endNumericEditing = useCallback(() => stateRef.current.endNumericEditing(), []);

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
      {overlay?.kind === 'rectangle' && overlay.widthScreen && (
        <DimensionLabel
          label="Width"
          value={overlay.width}
          x={overlay.widthScreen[0]}
          y={overlay.widthScreen[1] - 18}
          onBeginEdit={beginNumericEditing}
          onCancelEdit={endNumericEditing}
          onCommit={(value) => {
            if (activeTool?.kind === 'sketchRectangle' && activeTool.preview) {
              const p = activeTool.preview;
              const sign = p.width < 0 ? -1 : 1;
              stateRef.current.setPreviewRect(p.x, p.y, value * sign, p.height);
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
            if (activeTool?.kind === 'sketchRectangle' && activeTool.preview) {
              const p = activeTool.preview;
              const sign = p.height < 0 ? -1 : 1;
              stateRef.current.setPreviewRect(p.x, p.y, p.width, value * sign);
            }
          }}
        />
      )}
      {overlay?.kind === 'extrude' && overlay.screen && (
        <DimensionLabel
          label="Extrude distance"
          value={overlay.distance}
          x={overlay.screen[0]}
          y={overlay.screen[1] - 18}
          onBeginEdit={beginNumericEditing}
          onCancelEdit={endNumericEditing}
          onCommit={(value) => stateRef.current.setDistance(value)}
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
                  const tool = stateRef.current.activeTool;
                  if (tool?.kind !== 'move') return;
                  const next = { ...tool.delta };
                  if (a.axis === 0) next.dx = value;
                  else if (a.axis === 1) next.dy = value;
                  else next.dz = value;
                  stateRef.current.setDelta(next.dx, next.dy, next.dz);
                }}
              />
            ),
        )}
    </div>
  );
}
