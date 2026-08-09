/* eslint-disable @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access -- vendored three-loader boundary has incomplete declarations */
import type { EntityId, SnapResult, SnapTargetMask } from '@himmelcad/data';
import { Potree } from '@himmelcad/three-loader';
import type { PointCloudOctree } from '@himmelcad/three-loader';
import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  BufferAttribute,
  BufferGeometry,
  Box3,
  CanvasTexture,
  Color,
  Group,
  LineBasicMaterial,
  LineSegments,
  Points,
  PointsMaterial,
  Raycaster,
  Sprite,
  SpriteMaterial,
  Vector2,
  Vector3,
  WebGLRenderer,
} from 'three';
import type { Object3D } from 'three';

import styles from './Viewport.module.css';
import { CameraController } from './camera/CameraController.js';
import { PickingPass } from './picking/PickingPass.js';
import { GaussianSplatDataset } from './products/GaussianSplatDataset.js';
import type { GaussianSplatDatasetOptions } from './products/GaussianSplatDataset.js';
import { resolvePotreeAssetUrl } from './products/PotreeAssetUrl.js';
import { RasterPyramidDataset } from './products/RasterPyramidDataset.js';
import type { RasterPyramidDatasetOptions } from './products/RasterPyramidDataset.js';
import { TiledMeshDataset } from './products/TiledMeshDataset.js';
import type { TiledMeshDatasetOptions } from './products/TiledMeshDataset.js';
import { SceneGraph } from './scene/SceneGraph.js';
import { isFiniteCoordinate3, toRenderLocal } from './spatial/renderCoordinates.js';
import { FallbackSnapProvider } from './snapping/FallbackSnapProvider.js';
import { CameraSnapProvider } from './snapping/CameraSnapProvider.js';
import { PotreeSnapProvider } from './snapping/PotreeSnapProvider.js';
import { SnappingService } from './snapping/SnappingService.js';
import { RenderBudget } from './streaming/RenderBudget.js';
import type { RenderBudgetLimits } from './streaming/RenderBudget.js';
import { TileStreamingService } from './streaming/TileStreamingService.js';
import type { TiledDataset } from './streaming/TiledDataset.js';

/**
 * Legacy GPU pick pass. Disabled in Phase 1 (full-window pick render
 * doubled GPU load); slated for removal in Phase 2.7 when the snap
 * provider switches to three-loader's scissored on-demand pick. See
 * ADR 0003.
 *
 * While disabled the cursor still updates via the FallbackSnapProvider
 * (camera-aligned plane intersection); the Potree snap provider lands
 * in Phase 2.8 and replaces both the legacy octree provider and this
 * pass.
 */
const PICKING_ENABLED = false;

/**
 * three-loader point budget. Caps the total *visible* point count
 * across all loaded clouds — the LRU evicts past this. 8M is a stronger
 * default for current desktop dGPUs while still staying below the budgets
 * where fragment cost starts dominating ordinary orbit/pan.
 */
const DEFAULT_POINT_BUDGET = 8_000_000;
const DEFAULT_POINT_SIZE = 1.5;
const NORMAL_POINT_CACHE_MULTIPLIER = 2.25;
const INTERACTIVE_POINT_CACHE_MULTIPLIER = 1.6;
const RECOVERY_POINT_CACHE_MULTIPLIER = 1.2;
const NORMAL_GPU_UPLOAD_CAP = 8;
const INTERACTIVE_GPU_UPLOAD_CAP = 3;
const RECOVERY_GPU_UPLOAD_CAP = 1;
const STREAMING_SETTLE_MS = 220;
const CONTEXT_RECOVERY_THROTTLE_MS = 1_500;
const CONTEXT_RECREATE_TIMEOUT_MS = 2_000;
const MAX_POINTER_DELTA_PX = 480;
const DEFAULT_MIN_NODE_PIXEL_SIZE = 80;

type StreamingProfile = 'normal' | 'interactive' | 'recovery';
export type ViewportNavigationMode = 'orbit3d' | 'lockedTopDown2d';

interface RenderableProductDataset extends TiledDataset {
  readonly root: Object3D;
  readonly renderOffset?: readonly [number, number, number];
  dispose(): void;
}

export interface CameraImageRectangle {
  readonly entityId: EntityId;
  readonly cameraCenter: readonly [number, number, number];
  readonly corners: readonly [
    readonly [number, number, number],
    readonly [number, number, number],
    readonly [number, number, number],
    readonly [number, number, number],
  ];
  readonly aligned: boolean;
  readonly depthReady: boolean;
}

export interface GcpMarker {
  readonly entityId: EntityId;
  readonly name: string;
  readonly position: readonly [number, number, number];
  readonly role:
    | 'controlXyz'
    | 'controlXy'
    | 'controlZ'
    | 'checkpointXyz'
    | 'checkpointXy'
    | 'checkpointZ'
    | 'disabled';
}

export interface ViewportHandle {
  /**
   * Load a Potree 2.0 point cloud (PotreeConverter output) by its
   * metadata.json URL. The renderer streams nodes on demand via the
   * vendored three-loader; total point count can be billions.
   */
  loadPotreePointCloud: (
    metadataUrl: string,
    options: {
      entityId: EntityId;
      sourceName: string;
      renderOffset: [number, number, number];
      bounds: { min: [number, number, number]; max: [number, number, number] };
      pointCount: number;
      loadToken?: string;
      pointSize?: number;
      pointBudget?: number;
    },
  ) => Promise<{ pointCount: number }>;
  removeLayer: (entityId: EntityId) => void;
  setPointSize: (sizePx: number) => void;
  setPointBudget: (budget: number) => void;
  setSnapTargets: (mask: SnapTargetMask) => void;
  registerTiledDataset: (dataset: TiledDataset) => void;
  unregisterTiledDataset: (dataset: TiledDataset) => void;
  loadRasterPyramid: (
    manifestUrl: string,
    options: Omit<RasterPyramidDatasetOptions, 'id'> & {
      readonly entityId: EntityId;
      readonly loadToken?: string;
    },
  ) => Promise<RasterPyramidDataset>;
  loadTiledMesh: (
    manifestUrl: string,
    options: Omit<TiledMeshDatasetOptions, 'id'> & {
      readonly entityId: EntityId;
      readonly loadToken?: string;
    },
  ) => Promise<TiledMeshDataset>;
  loadGaussianSplats: (
    sourceUrl: string,
    options: Omit<GaussianSplatDatasetOptions, 'id'> & {
      readonly entityId: EntityId;
      readonly loadToken?: string;
      readonly format?: 'prepared' | 'brushPly';
    },
  ) => Promise<GaussianSplatDataset>;
  configureRenderBudget: (limits: Partial<RenderBudgetLimits>) => void;
  setNavigationMode: (mode: ViewportNavigationMode) => void;
  resetProjectScene: (offset: readonly [number, number, number]) => void;
  setSceneRenderOffset: (offset: readonly [number, number, number]) => void;
  setCameraImageRectangles: (rectangles: readonly CameraImageRectangle[]) => void;
  setGcpMarkers: (markers: readonly GcpMarker[]) => void;
  frameAll: () => void;
  frameSelection: (entityIds: readonly EntityId[]) => boolean;
}

export interface ViewportProps {
  renderOffset?: readonly [number, number, number];
  navigationMode?: ViewportNavigationMode;
  pointBudget?: number;
  onCursorSnap?: (snap: SnapResult | null) => void;
  onDropFiles?: (paths: string[]) => void;
  onLog?: (level: 'info' | 'warn' | 'error', message: string) => void;
  onContextRecreate?: () => void;
}

/**
 * FULL-WINDOW CANVAS / MASK ARCHITECTURE
 *
 * The Three.js canvas is always sized to the full browser window. The camera
 * projection covers the entire window so the 3D scene is stable in
 * window-relative coordinates regardless of panel layout.
 *
 * The Viewport container (`.root`) sits in the flex layout and acts as a
 * CLIPPING MASK via `overflow: hidden` + `border-radius`. Every frame we
 * reposition the canvas with a negative offset equal to the container's
 * position within the window, so the visible portion of the canvas lines up
 * with the correct window-relative area.
 *
 * Effect: dragging splitters only changes which part of the static render is
 * visible. No setSize, no backbuffer reallocation, no re-projection, zero
 * flicker or cloud movement. Only an actual window resize triggers setSize.
 */
export const Viewport = forwardRef<ViewportHandle, ViewportProps>(function Viewport(
  {
    renderOffset = [0, 0, 0],
    navigationMode = 'orbit3d',
    pointBudget = DEFAULT_POINT_BUDGET,
    onCursorSnap,
    onDropFiles,
    onLog,
    onContextRecreate,
  },
  handleRef,
): JSX.Element {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const sceneRef = useRef<SceneGraph | null>(null);
  const cameraRef = useRef<CameraController | null>(null);
  const rendererRef = useRef<WebGLRenderer | null>(null);
  const snappingRef = useRef<SnappingService | null>(null);
  const pickingRef = useRef<PickingPass | null>(null);

  // three-loader Potree scheduler: owns the LRU/visibility queue across
  // all loaded clouds. Lazily created on the first Potree cloud load (so
  // sessions that don't import any cloud pay zero cost). Keyed by
  // entityId for removeLayer + future snap-provider lookup.
  const potreeRef = useRef<Potree | null>(null);
  const cloudsRef = useRef<Map<EntityId, PointCloudOctree>>(new Map());
  const pointSizeRef = useRef(DEFAULT_POINT_SIZE);
  const pointBudgetRef = useRef(pointBudget);
  const renderBudgetRef = useRef<RenderBudget>(new RenderBudget());
  const tileStreamingRef = useRef<TileStreamingService>(
    new TileStreamingService(renderBudgetRef.current),
  );
  const productDatasetsRef = useRef<Map<EntityId, RenderableProductDataset>>(new Map());
  const layerLoadTokensRef = useRef<Map<EntityId, string>>(new Map());
  const initialRenderOffsetRef = useRef(renderOffset);
  const layerLoadSequenceRef = useRef(0);
  const nodeLoadConcurrencyRef = useRef(detectNodeLoadConcurrency());
  const streamingProfileRef = useRef<StreamingProfile>('normal');
  const navigationModeRef = useRef<ViewportNavigationMode>(navigationMode);
  const cameraRectanglesRef = useRef<LineSegments | null>(null);
  const cameraRectangleDataRef = useRef<readonly CameraImageRectangle[]>([]);
  const cameraSnapProviderRef = useRef<CameraSnapProvider | null>(null);
  const framedCameraRectanglesRef = useRef(false);
  const gcpMarkersRef = useRef<Group | null>(null);
  const gcpMarkerDataRef = useRef<readonly GcpMarker[]>([]);
  const datasetBoundsRef = useRef<
    Map<
      EntityId,
      { min: readonly [number, number, number]; max: readonly [number, number, number] }
    >
  >(new Map());

  // Imperative refs for the cursor overlay. The overlay is updated directly
  // from the rAF tick inside `useEffect` — never via React state — so that
  // moving the mouse never re-renders the Viewport tree. See `applyCursor`.
  const overlayActiveRef = useRef<HTMLSpanElement | null>(null);
  const overlayIdleRef = useRef<HTMLSpanElement | null>(null);
  const overlayXRef = useRef<HTMLSpanElement | null>(null);
  const overlayYRef = useRef<HTMLSpanElement | null>(null);
  const overlayZRef = useRef<HTMLSpanElement | null>(null);
  const overlayKindRef = useRef<HTMLSpanElement | null>(null);

  // Stable ref for the parent's onCursorSnap callback. Captured once and
  // updated on every render so the rAF tick can fire it without depending
  // on stale closures.
  const onCursorSnapRef = useRef(onCursorSnap);
  useEffect(() => {
    onCursorSnapRef.current = onCursorSnap;
  }, [onCursorSnap]);
  const onLogRef = useRef(onLog);
  useEffect(() => {
    onLogRef.current = onLog;
  }, [onLog]);
  const onContextRecreateRef = useRef(onContextRecreate);
  useEffect(() => {
    onContextRecreateRef.current = onContextRecreate;
  }, [onContextRecreate]);

  const [dragOver, setDragOver] = useState(false);
  const [contextMessage, setContextMessage] = useState<string | null>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const tileStreaming = tileStreamingRef.current;
    const productDatasets = productDatasetsRef.current;
    const layerLoadTokens = layerLoadTokensRef.current;
    const datasetBounds = datasetBoundsRef.current;

    const renderer = new WebGLRenderer({
      antialias: true,
      powerPreference: 'high-performance',
    });
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    renderer.setPixelRatio(dpr);
    renderer.setClearColor(new Color('#15171a'));
    container.appendChild(renderer.domElement);
    rendererRef.current = renderer;

    const canvas = renderer.domElement;
    let contextLost = false;
    let settleTimer: number | null = null;
    let recoveryTimer: number | null = null;
    let recreateTimer: number | null = null;

    const scene = new SceneGraph();
    const initialRenderOffset = initialRenderOffsetRef.current;
    scene.resetRenderOffset(initialRenderOffset[0], initialRenderOffset[1], initialRenderOffset[2]);
    sceneRef.current = scene;
    const camera = new CameraController(window.innerWidth, window.innerHeight);
    camera.setLockedTopDown(navigationModeRef.current === 'lockedTopDown2d');
    camera.frame({ x: -25, y: -25, z: -1 } as never, { x: 25, y: 25, z: 1 } as never);
    cameraRef.current = camera;

    const snapping = new SnappingService();
    const cameraSnapping = new CameraSnapProvider();
    cameraSnapProviderRef.current = cameraSnapping;
    snapping.register(cameraSnapping);
    snapping.register(new FallbackSnapProvider());
    snappingRef.current = snapping;

    const picking = new PickingPass(renderer, camera.camera, window.innerWidth, window.innerHeight);
    pickingRef.current = picking;

    const applyStreamingProfile = (profile: StreamingProfile) => {
      streamingProfileRef.current = profile;
      const potree = potreeRef.current;
      if (!potree) return;
      applyPotreeStreamingProfile(
        potree,
        cloudsRef.current.values(),
        nodeLoadConcurrencyRef.current,
        profile,
      );
    };

    const scheduleNormalStreaming = () => {
      if (settleTimer) window.clearTimeout(settleTimer);
      settleTimer = window.setTimeout(() => {
        settleTimer = null;
        if (!contextLost) applyStreamingProfile('normal');
      }, STREAMING_SETTLE_MS);
    };

    const markInteractiveStreaming = () => {
      if (contextLost) return;
      applyStreamingProfile('interactive');
      scheduleNormalStreaming();
    };

    // Size canvas to full window. Only called on actual window resize, never
    // during splitter drags.
    const applyWindowSize = () => {
      const w = window.innerWidth;
      const h = window.innerHeight;
      renderer.setSize(w, h, false);
      canvas.style.width = `${w}px`;
      canvas.style.height = `${h}px`;
      camera.setViewportSize(w, h);
      picking.resize(w, h);
      renderer.render(scene.scene, camera.camera);
    };
    applyWindowSize();
    window.addEventListener('resize', applyWindowSize);

    // ── Interaction ────────────────────────────────────────────────────

    let dragMode: 'orbit' | 'pan' | null = null;
    let lastX = 0;
    let lastY = 0;
    let pointerInside = false;

    // Orbit pivot is captured ONCE at drag start (the cursor world position
    // at pointerdown) and held constant for the entire drag. We deliberately
    // don't recompute it from the moving cursor — that would slide the orbit
    // centre mid-rotation and feel unstable. null means "fall back to plain
    // orbit-around-target" (no snap was available when drag began).
    let orbitPivot: Vector3 | null = null;
    let panAnchor: Vector3 | null = null;

    // rAF throttling: pointer events store the latest position; the render
    // tick consumes it once per frame for the snap query. Camera ops still
    // run on every event because that's what makes orbit/pan feel direct.
    let pendingCursorEvent: PointerEvent | null = null;
    let lastPointerEvent: PointerEvent | null = null;

    // Track the last applied snap so we only ping the parent (and only
    // touch the DOM) when the value actually changes. Equality is
    // structural — sub-mm position deltas don't count.
    let lastAppliedSnap: SnapResult | null = null;

    // Last *stable* snap is the pivot reference for orbit / zoom. We never
    // pivot around a Free/Grid result mid-orbit because that would jump as
    // soon as the cursor crosses an empty pixel; we keep the previous
    // stable snap instead. SnapResult.stable is set by the providers.
    let lastStableSnap: SnapResult | null = null;

    const onWebGLContextLost = (e: Event) => {
      e.preventDefault();
      contextLost = true;
      dragMode = null;
      orbitPivot = null;
      panAnchor = null;
      pendingCursorEvent = null;
      applyStreamingProfile('recovery');
      setContextMessage('GPU context reset. Restoring viewport...');
      onLogRef.current?.('warn', 'GPU context reset; viewport is restoring automatically');
      console.error('[viewport] WebGL context lost; waiting for browser restore');
      if (recreateTimer) window.clearTimeout(recreateTimer);
      recreateTimer = window.setTimeout(() => {
        recreateTimer = null;
        onLogRef.current?.(
          'warn',
          'GPU context was not restored by Chromium; recreating the viewport safely',
        );
        onContextRecreateRef.current?.();
      }, CONTEXT_RECREATE_TIMEOUT_MS);
    };

    const onWebGLContextRestored = () => {
      if (recreateTimer) {
        window.clearTimeout(recreateTimer);
        recreateTimer = null;
      }
      contextLost = false;
      renderer.setPixelRatio(dpr);
      renderer.setClearColor(new Color('#15171a'));
      applyWindowSize();
      markCloudResourcesForUpload(cloudsRef.current.values());
      markProductResourcesForUpload(productDatasetsRef.current.values());
      applyStreamingProfile('recovery');
      setContextMessage('GPU context restored. Rebuilding viewport...');
      onLogRef.current?.('info', 'GPU context restored; rebuilding viewport resources');
      console.warn('[viewport] WebGL context restored; rebuilding GPU resources');
      if (recoveryTimer) window.clearTimeout(recoveryTimer);
      recoveryTimer = window.setTimeout(() => {
        recoveryTimer = null;
        applyStreamingProfile('normal');
        setContextMessage(null);
      }, CONTEXT_RECOVERY_THROTTLE_MS);
    };

    canvas.addEventListener('webglcontextlost', onWebGLContextLost);
    canvas.addEventListener('webglcontextrestored', onWebGLContextRestored);

    const applyCursor = (snap: SnapResult | null) => {
      if (snapShallowEqual(snap, lastAppliedSnap)) return;
      lastAppliedSnap = snap;
      if (snap && snap.stable !== false) lastStableSnap = snap;
      writeOverlay(snap);
      onCursorSnapRef.current?.(snap);
    };

    /**
     * Convert a snap (world-absolute coordinates) to scene-local
     * coordinates so it can be used as a CameraController pivot/anchor.
     * The CameraController operates in scene space (the same space as the
     * three.js camera position), not world space.
     */
    const snapToScenePivot = (snap: SnapResult | null): Vector3 | null => {
      if (!snap || snap.position.z === null) return null;
      const off = scene.getRenderOffset();
      return new Vector3(
        snap.position.x - off[0],
        snap.position.y - off[1],
        snap.position.z - off[2],
      );
    };

    // Renders the latest snap into the overlay DOM imperatively. No React
    // re-render. Keeps both subtrees mounted; toggles visibility.
    const writeOverlay = (snap: SnapResult | null) => {
      const active = overlayActiveRef.current;
      const idle = overlayIdleRef.current;
      if (!active || !idle) return;
      if (!snap) {
        if (active.style.display !== 'none') active.style.display = 'none';
        if (idle.style.display !== '') idle.style.display = '';
        return;
      }
      if (active.style.display !== '') active.style.display = '';
      if (idle.style.display !== 'none') idle.style.display = 'none';
      const x = overlayXRef.current;
      const y = overlayYRef.current;
      const z = overlayZRef.current;
      const k = overlayKindRef.current;
      if (x) x.textContent = snap.position.x.toFixed(3);
      if (y) y.textContent = snap.position.y.toFixed(3);
      if (z) z.textContent = snap.position.z === null ? '—' : snap.position.z.toFixed(3);
      if (k) {
        const sourceLabel = snap.source ? ` · ${snap.source}` : '';
        const confidenceLabel = ` · ${Math.round(snap.confidence * 100)}%`;
        k.textContent = `${snap.kind}${sourceLabel}${confidenceLabel}`;
      }
    };

    const onPointerDown = (e: PointerEvent) => {
      if (e.button === 0 && navigationModeRef.current === 'orbit3d') {
        dragMode = 'orbit';
        // Capture pivot ONCE here — never reassigned during the drag.
        // Crucially we do NOT touch the camera (no setOrbitPivot, no
        // target swap) because that would force a lookAt() and swing
        // the cursor world point to the screen centre. The actual
        // rotation happens in pointermove via `orbitAround`, which
        // rotates cameraPos and target *together* around `pivot` so
        // the cursor point stays in its current screen pixel.
        const orbitStart = queryCursor(e, container, scene, camera, snapping, picking);
        applyCursor(orbitStart.active);
        orbitPivot = snapToScenePivot(orbitStart.active ?? lastStableSnap ?? lastAppliedSnap);
      } else if (e.button === 0 || e.button === 1 || e.button === 2) {
        // MMB and RMB both pan. MMB matches Rhino/Blender/SketchUp/CAD
        // muscle memory; RMB stays for users on a 2-button mouse and
        // for context-menu opening on a click without drag.
        // preventDefault on MMB blocks the browser's auto-scroll cursor.
        if (e.button === 1) e.preventDefault();
        dragMode = 'pan';
        const panStart = queryCursor(e, container, scene, camera, snapping, picking);
        applyCursor(panStart.active);
        panAnchor = snapToScenePivot(panStart.active ?? lastStableSnap ?? lastAppliedSnap);
      }
      lastX = e.clientX;
      lastY = e.clientY;
      pendingCursorEvent = e;
      lastPointerEvent = e;
      (e.target as Element).setPointerCapture(e.pointerId);
    };
    const onPointerMove = (e: PointerEvent) => {
      const dx = e.clientX - lastX;
      const dy = e.clientY - lastY;
      lastX = e.clientX;
      lastY = e.clientY;
      const safeDx = clampNumber(dx, -MAX_POINTER_DELTA_PX, MAX_POINTER_DELTA_PX);
      const safeDy = clampNumber(dy, -MAX_POINTER_DELTA_PX, MAX_POINTER_DELTA_PX);
      if (dragMode === 'orbit') {
        markInteractiveStreaming();
        if (orbitPivot) {
          camera.orbitAround(-safeDx * 0.005, safeDy * 0.005, orbitPivot);
        } else {
          camera.orbit(-safeDx * 0.005, safeDy * 0.005);
        }
      } else if (dragMode === 'pan') {
        markInteractiveStreaming();
        if (panAnchor) {
          const ndcX = (e.clientX / window.innerWidth) * 2 - 1;
          const ndcY = -((e.clientY / window.innerHeight) * 2 - 1);
          if (!camera.panAnchorToPointer(panAnchor, ndcX, ndcY)) {
            camera.panPixels(safeDx, safeDy);
          }
        } else {
          camera.panPixels(safeDx, safeDy);
        }
      }

      // Snap query is throttled to once per rAF; only record the event.
      pendingCursorEvent = e;
      lastPointerEvent = e;

      if (PICKING_ENABLED) {
        // Fire-and-forget pick readback. Latency is one frame.
        void picking.readback(e.clientX, e.clientY);
      }
    };
    const onPointerUp = (e: PointerEvent) => {
      dragMode = null;
      orbitPivot = null;
      panAnchor = null;
      scheduleNormalStreaming();
      try {
        (e.target as Element).releasePointerCapture(e.pointerId);
      } catch {
        /* already released */
      }
    };
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      markInteractiveStreaming();
      // Constant zoom speed: deltaY-normalised exponential factor. One
      // classic notch (deltaY ≈ ±100) maps to ≈ 1.16×, indistinguishable
      // from the previous fixed 1.1× per notch but smooth on hi-dpi
      // wheels and trackpads. Distance-independent by construction
      // because it's a *factor*, not an additive step.
      const factor = Math.pow(1.0015, e.deltaY);

      // CAD-style zoom-to-cursor: anchor the world point under the
      // cursor so it stays under the cursor after the zoom. We use
      // `lastAppliedSnap` (not lastStable) because the cursor *is*
      // currently under that point — even an interpolated surface is a
      // better anchor than the scene centre. Falls back to centre-zoom
      // only if there's no snap at all (cursor outside cloud, no
      // fallback grid hit, e.g. extreme oblique view).
      const anchor = snapToScenePivot(lastAppliedSnap);
      if (anchor) {
        camera.zoomAt(factor, anchor);
      } else {
        camera.zoom(factor);
      }
    };
    const onContextMenu = (e: MouseEvent) => {
      e.preventDefault();
    };
    const onAuxClick = (e: MouseEvent) => {
      // MMB auxclick on Linux/Chromium can trigger primary-paste or
      // navigation in some contexts; block it for our canvas.
      if (e.button === 1) e.preventDefault();
    };
    /**
     * Block Chromium's MMB auto-scroll. preventDefault on `pointerdown`
     * is NOT enough — for mouse pointers the legacy `mousedown` event
     * fires independently, and that's the one Chromium reads to decide
     * whether to enter auto-scroll mode. preventDefault here is the
     * documented escape hatch (see crbug.com/40092683 and discussion
     * around `disable-features=MiddleClickAutoscroll`).
     *
     * Without this, MMB-drag does nothing visible on Linux: the
     * auto-scroll cursor appears, the pointer is captured by Chromium's
     * scroll logic, and our `pointermove` never fires with `dragMode`
     * set.
     */
    const onMouseDown = (e: MouseEvent) => {
      if (e.button === 1) e.preventDefault();
    };
    const onPointerEnter = () => {
      pointerInside = true;
    };
    const onPointerLeave = () => {
      pointerInside = false;
      pendingCursorEvent = null;
      applyCursor(null);
    };

    const onKeyDown = (e: KeyboardEvent) => {
      if (!pointerInside || e.code !== 'Space') return;
      e.preventDefault();
      // Picking-driven neighbourhood probe is gated; without picking the
      // hierarchy still cycles across whatever providers populated.
      if (PICKING_ENABLED && lastPointerEvent && snapping.candidateCount() <= 1) {
        const neighborhood = picking.readNeighborhood(
          lastPointerEvent.clientX,
          lastPointerEvent.clientY,
          16,
        );
        const requeried = queryCursor(
          lastPointerEvent,
          container,
          scene,
          camera,
          snapping,
          picking,
          neighborhood,
        );
        if (requeried.candidates.length > 1) {
          applyCursor(requeried.active);
          return;
        }
      }
      const cycled = snapping.cycleCandidate(e.shiftKey ? -1 : 1);
      if (cycled.candidates.length <= 1) return;
      applyCursor(cycled.active);
    };

    canvas.addEventListener('pointerdown', onPointerDown);
    canvas.addEventListener('pointermove', onPointerMove);
    canvas.addEventListener('pointerup', onPointerUp);
    canvas.addEventListener('pointercancel', onPointerUp);
    canvas.addEventListener('pointerenter', onPointerEnter);
    canvas.addEventListener('pointerleave', onPointerLeave);
    canvas.addEventListener('wheel', onWheel, { passive: false });
    canvas.addEventListener('contextmenu', onContextMenu);
    canvas.addEventListener('auxclick', onAuxClick);
    canvas.addEventListener('mousedown', onMouseDown);
    window.addEventListener('keydown', onKeyDown);

    // ── Canvas offset sync ───────────────────────────────────────────
    //
    // The canvas renders for the full window but lives inside the viewport
    // container (clipped by overflow:hidden). We compensate for the
    // container's position via a negative left/top offset.
    //
    // CRITICAL: this offset must update BEFORE the browser paints after a
    // layout change. The render-loop rAF alone isn't fast enough — when the
    // LEFT panel grows, the container's left edge shifts right, and the
    // browser may paint one frame with the stale offset before our rAF
    // fires. ResizeObserver fires after layout but BEFORE paint, so we use
    // it to sync the offset immediately on any container size/position
    // change.

    const syncOffset = () => {
      const rect = container.getBoundingClientRect();
      canvas.style.left = `${-rect.left}px`;
      canvas.style.top = `${-rect.top}px`;
    };
    syncOffset();

    const ro = new ResizeObserver(syncOffset);
    ro.observe(container);

    // ── Render loop ────────────────────────────────────────────────────

    let raf = 0;
    const tick = () => {
      syncOffset();
      if (contextLost) {
        raf = requestAnimationFrame(tick);
        return;
      }

      // Snap query: at most once per frame, only if the pointer moved since
      // last tick. Keeps the query off the high-frequency pointermove path.
      if (pendingCursorEvent) {
        const evt = pendingCursorEvent;
        pendingCursorEvent = null;
        const result = queryCursor(evt, container, scene, camera, snapping, picking);
        applyCursor(result.active);
      }

      // three-loader visibility/streaming pass. MUST run before render so
      // any nodes that were hoisted into GPU memory this frame are picked
      // up by the renderer below. Skipped when no Potree cloud is loaded.
      const potree = potreeRef.current;
      const clouds = cloudsRef.current;
      if (potree && clouds.size > 0) {
        potree.updatePointClouds(Array.from(clouds.values()), camera.camera, renderer);
      }

      tileStreaming.update({
        camera: camera.camera,
        viewportHeight: window.innerHeight,
        fovY: (camera.camera.fov * Math.PI) / 180,
      });

      if (PICKING_ENABLED) {
        picking.render();
      }
      renderer.render(scene.scene, camera.camera);
      raf = requestAnimationFrame(tick);
    };
    tick();

    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      window.removeEventListener('resize', applyWindowSize);
      if (settleTimer) window.clearTimeout(settleTimer);
      if (recoveryTimer) window.clearTimeout(recoveryTimer);
      if (recreateTimer) window.clearTimeout(recreateTimer);
      canvas.removeEventListener('webglcontextlost', onWebGLContextLost);
      canvas.removeEventListener('webglcontextrestored', onWebGLContextRestored);
      canvas.removeEventListener('pointerdown', onPointerDown);
      canvas.removeEventListener('pointermove', onPointerMove);
      canvas.removeEventListener('pointerup', onPointerUp);
      canvas.removeEventListener('pointercancel', onPointerUp);
      canvas.removeEventListener('pointerenter', onPointerEnter);
      canvas.removeEventListener('pointerleave', onPointerLeave);
      canvas.removeEventListener('wheel', onWheel);
      canvas.removeEventListener('contextmenu', onContextMenu);
      canvas.removeEventListener('auxclick', onAuxClick);
      canvas.removeEventListener('mousedown', onMouseDown);
      window.removeEventListener('keydown', onKeyDown);
      picking.dispose();
      tileStreaming.dispose();
      for (const dataset of productDatasets.values()) dataset.dispose();
      productDatasets.clear();
      layerLoadTokens.clear();
      disposeCameraRectangles(cameraRectanglesRef.current);
      cameraRectanglesRef.current = null;
      cameraRectangleDataRef.current = [];
      cameraSnapProviderRef.current = null;
      disposeGcpMarkers(gcpMarkersRef.current);
      gcpMarkersRef.current = null;
      gcpMarkerDataRef.current = [];
      datasetBounds.clear();
      pickingRef.current = null;
      renderer.dispose();
      rendererRef.current = null;
      container.removeChild(canvas);
      sceneRef.current = null;
      cameraRef.current = null;
      snappingRef.current = null;
    };
  }, []);

  const loadPotreePointCloud = useCallback<ViewportHandle['loadPotreePointCloud']>(
    async (metadataUrl, opts) => {
      const scene = sceneRef.current;
      const camera = cameraRef.current;
      const snapping = snappingRef.current;
      if (!scene || !camera || !snapping) throw new Error('viewport not ready');
      const loadToken =
        opts.loadToken ?? `${opts.entityId}:${String(++layerLoadSequenceRef.current)}`;
      layerLoadTokensRef.current.set(opts.entityId, loadToken);

      let potree = potreeRef.current;
      if (!potree) {
        // ADR 0003: we use Potree v2 (PotreeConverter 2.x output) exclusively.
        potree = new Potree('v2');
        potree.pointBudget = opts.pointBudget ?? pointBudgetRef.current;
        applyPotreeStreamingProfile(
          potree,
          cloudsRef.current.values(),
          nodeLoadConcurrencyRef.current,
          streamingProfileRef.current,
        );
        potreeRef.current = potree;
      }

      // metadataUrl is the direct URL to metadata.json. The internal loader
      // calls getUrl(...) for every relative path inside the octree
      // (hierarchy.bin, octree.bin) — we just resolve them against the
      // metadata URL so they share the same hcad-cache:// scope.
      const getUrl = (relative: string): Promise<string> => {
        // Potree asks the resolver for the metadata URL itself before it asks
        // for hierarchy.bin and octree.bin.  Product URLs are already absolute
        // custom-scheme URLs; prepending baseUrl a second time produces an
        // invalid `.../hcad-product://...` path and a misleading 403 response.
        return Promise.resolve(resolvePotreeAssetUrl(metadataUrl, relative));
      };

      const cloud = await potree.loadPointCloud(metadataUrl, getUrl);
      if (layerLoadTokensRef.current.get(opts.entityId) !== loadToken) {
        cloud.dispose();
        throw new Error('Stale point-cloud load superseded by a newer entity generation.');
      }
      cloud.name = `pc:${opts.entityId}`;
      // three-loader expects the on-screen point size in pixels.
      cloud.material.size = opts.pointSize ?? pointSizeRef.current;
      cloud.minNodePixelSize = DEFAULT_MIN_NODE_PIXEL_SIZE;
      cloud.pcoGeometry.maxNumNodesLoading = nodeLoadConcurrencyRef.current;
      // Anchor on the first cloud so the scene render offset stays stable
      // across subsequent imports (kept for snap-coordinate consistency).
      const isFirst = cloudsRef.current.size === 0 && scene.iterLayerCount() === 0;
      if (isFirst) {
        scene.setRenderOffset(opts.renderOffset[0], opts.renderOffset[1], opts.renderOffset[2]);
      }
      const sceneOff = scene.getRenderOffset();
      const cloudAnchor = toRenderLocal(opts.renderOffset, sceneOff);
      if (!cloudAnchor) {
        cloud.dispose();
        throw new Error(
          'Point cloud origin is outside the active PhotoLab reference frame. Check product lineage and CRS.',
        );
      }
      cloud.position.set(cloudAnchor[0], cloudAnchor[1], cloudAnchor[2]);
      cloud.updateMatrixWorld(true);

      scene.scene.add(cloud);
      cloudsRef.current.set(opts.entityId, cloud);
      datasetBoundsRef.current.set(opts.entityId, opts.bounds);
      if (isFirst) scene.lockRenderOffset();
      applyPotreeStreamingProfile(
        potree,
        cloudsRef.current.values(),
        nodeLoadConcurrencyRef.current,
        streamingProfileRef.current,
      );

      // Snap provider for this cloud. The closure captures `cloud` and the
      // viewport's renderer/camera refs so it can run a scissored GPU pick
      // on demand without the snap module needing to know about WebGL.
      // RATIONALE pickWindowSize=17: gives a comfortable 8 px hit radius
      // around the cursor — picks succeed even when the user is between
      // sample points but their cursor is "obviously on" the surface.
      snapping.register(
        new PotreeSnapProvider({
          cloud,
          layerId: `pc:${opts.entityId}`,
          entityId: opts.entityId,
          pickRay: (ray) => {
            const r = rendererRef.current;
            const c = cameraRef.current;
            if (!r || !c) return null;
            return Potree.pick([cloud], r, c.camera, ray, { pickWindowSize: 17 });
          },
        }),
      );

      const min = opts.bounds.min;
      const max = opts.bounds.max;
      camera.frame(
        new Vector3(min[0] - sceneOff[0], min[1] - sceneOff[1], min[2] - sceneOff[2]),
        new Vector3(max[0] - sceneOff[0], max[1] - sceneOff[1], max[2] - sceneOff[2]),
      );

      return { pointCount: opts.pointCount };
    },
    [],
  );

  const removeLayerResources = useCallback((entityId: EntityId) => {
    const cloud = cloudsRef.current.get(entityId);
    if (cloud) {
      sceneRef.current?.scene.remove(cloud);
      cloud.dispose();
      cloudsRef.current.delete(entityId);
    }
    datasetBoundsRef.current.delete(entityId);
    const id = `pc:${entityId}`;
    snappingRef.current?.unregister(`${id}:potree-snap`);
    // Legacy SceneGraph layer + snap id (pre-Potree, none should exist post-2.5
    // but unregistering is idempotent so it's safe to keep until we delete the
    // dead PointCloudLayer/PickingPass code in Phase 2.7).
    sceneRef.current?.removeLayer(id);
    snappingRef.current?.unregister(`${id}:snap`);
    pickingRef.current?.unregisterLayer(id);
    const product = productDatasetsRef.current.get(entityId);
    if (product) {
      tileStreamingRef.current.unregister(product);
      sceneRef.current?.root.remove(product.root);
      product.dispose();
      productDatasetsRef.current.delete(entityId);
    }
  }, []);

  const removeLayer = useCallback<ViewportHandle['removeLayer']>(
    (entityId) => {
      layerLoadTokensRef.current.delete(entityId);
      removeLayerResources(entityId);
    },
    [removeLayerResources],
  );

  const setPointSize = useCallback<ViewportHandle['setPointSize']>((sizePx) => {
    const next = Math.max(0.25, Math.min(20, sizePx));
    pointSizeRef.current = next;
    for (const cloud of cloudsRef.current.values()) {
      cloud.material.size = next;
    }
  }, []);

  const setPointBudget = useCallback<ViewportHandle['setPointBudget']>((budget) => {
    const next = Math.max(250_000, Math.min(50_000_000, Math.round(budget)));
    pointBudgetRef.current = next;
    const potree = potreeRef.current;
    if (potree) {
      potree.pointBudget = next;
      applyPotreeStreamingProfile(
        potree,
        cloudsRef.current.values(),
        nodeLoadConcurrencyRef.current,
        streamingProfileRef.current,
      );
    }
  }, []);

  useEffect(() => {
    setPointBudget(pointBudget);
  }, [pointBudget, setPointBudget]);

  const setSnapTargets = useCallback<ViewportHandle['setSnapTargets']>((mask) => {
    snappingRef.current?.configureTargets(mask);
  }, []);

  const registerTiledDataset = useCallback<ViewportHandle['registerTiledDataset']>((dataset) => {
    tileStreamingRef.current.register(dataset);
  }, []);

  const unregisterTiledDataset = useCallback<ViewportHandle['unregisterTiledDataset']>(
    (dataset) => {
      tileStreamingRef.current.unregister(dataset);
    },
    [],
  );

  const attachProductDataset = useCallback(
    <T extends RenderableProductDataset>(entityId: EntityId, dataset: T, loadToken: string): T => {
      const scene = sceneRef.current;
      if (!scene) {
        dataset.dispose();
        throw new Error('viewport not ready');
      }
      if (layerLoadTokensRef.current.get(entityId) !== loadToken) {
        dataset.dispose();
        throw new Error('Stale product load superseded by a newer entity generation.');
      }
      removeLayerResources(entityId);
      const rootTile = dataset.getTile(dataset.rootTile);
      if (rootTile && cloudsRef.current.size === 0 && productDatasetsRef.current.size === 0) {
        const world = (rootTile as { worldBounds?: { min: { x: number; y: number; z: number } } })
          .worldBounds;
        if (world) {
          scene.setRenderOffset(
            world.min.x - rootTile.bounds.min.x,
            world.min.y - rootTile.bounds.min.y,
            world.min.z - rootTile.bounds.min.z,
          );
        }
      }
      dataset.setNavigationMode?.(navigationModeRef.current);
      const datasetOffset = dataset.renderOffset;
      if (datasetOffset) {
        const localOrigin = toRenderLocal(datasetOffset, scene.getRenderOffset());
        if (!localOrigin) {
          dataset.dispose();
          throw new Error(
            'Product origin is outside the active PhotoLab reference frame. Check product lineage and CRS.',
          );
        }
        dataset.root.position.set(localOrigin[0], localOrigin[1], localOrigin[2]);
      }
      productDatasetsRef.current.set(entityId, dataset);
      scene.root.add(dataset.root);
      scene.lockRenderOffset();
      tileStreamingRef.current.register(dataset);
      if (rootTile) {
        const position = dataset.root.position;
        cameraRef.current?.frame(
          new Vector3(
            rootTile.bounds.min.x + position.x,
            rootTile.bounds.min.y + position.y,
            rootTile.bounds.min.z + position.z,
          ),
          new Vector3(
            rootTile.bounds.max.x + position.x,
            rootTile.bounds.max.y + position.y,
            rootTile.bounds.max.z + position.z,
          ),
        );
      }
      return dataset;
    },
    [removeLayerResources],
  );

  const loadRasterPyramid = useCallback<ViewportHandle['loadRasterPyramid']>(
    async (manifestUrl, options) => {
      const { entityId, loadToken: requestedLoadToken, ...datasetOptions } = options;
      const loadToken =
        requestedLoadToken ?? `${entityId}:${String(++layerLoadSequenceRef.current)}`;
      layerLoadTokensRef.current.set(entityId, loadToken);
      const dataset = await RasterPyramidDataset.load(manifestUrl, {
        ...datasetOptions,
        id: `raster:${entityId}`,
      });
      return attachProductDataset(entityId, dataset, loadToken);
    },
    [attachProductDataset],
  );

  const loadTiledMesh = useCallback<ViewportHandle['loadTiledMesh']>(
    async (manifestUrl, options) => {
      const { entityId, loadToken: requestedLoadToken, ...datasetOptions } = options;
      const loadToken =
        requestedLoadToken ?? `${entityId}:${String(++layerLoadSequenceRef.current)}`;
      layerLoadTokensRef.current.set(entityId, loadToken);
      const dataset = await TiledMeshDataset.load(manifestUrl, {
        ...datasetOptions,
        id: `mesh:${entityId}`,
      });
      return attachProductDataset(entityId, dataset, loadToken);
    },
    [attachProductDataset],
  );

  const loadGaussianSplats = useCallback<ViewportHandle['loadGaussianSplats']>(
    async (sourceUrl, options) => {
      const {
        entityId,
        loadToken: requestedLoadToken,
        format = 'prepared',
        ...datasetOptions
      } = options;
      const loadToken =
        requestedLoadToken ?? `${entityId}:${String(++layerLoadSequenceRef.current)}`;
      layerLoadTokensRef.current.set(entityId, loadToken);
      const typedOptions: GaussianSplatDatasetOptions = {
        ...datasetOptions,
        id: `splat:${entityId}`,
      };
      const dataset =
        format === 'brushPly'
          ? await GaussianSplatDataset.loadBrushPly(sourceUrl, typedOptions)
          : await GaussianSplatDataset.load(sourceUrl, typedOptions);
      return attachProductDataset(entityId, dataset, loadToken);
    },
    [attachProductDataset],
  );

  const configureRenderBudget = useCallback<ViewportHandle['configureRenderBudget']>((limits) => {
    renderBudgetRef.current.configure(limits);
  }, []);

  const setNavigationMode = useCallback<ViewportHandle['setNavigationMode']>((mode) => {
    navigationModeRef.current = mode;
    cameraRef.current?.setLockedTopDown(mode === 'lockedTopDown2d');
    for (const dataset of productDatasetsRef.current.values()) dataset.setNavigationMode?.(mode);
  }, []);

  const resetProjectScene = useCallback<ViewportHandle['resetProjectScene']>((offset) => {
    const scene = sceneRef.current;
    if (!scene || !isFiniteCoordinate3(offset)) return;
    const rectangles = cameraRectanglesRef.current;
    if (rectangles) {
      scene.scene.remove(rectangles);
      disposeCameraRectangles(rectangles);
    }
    cameraRectanglesRef.current = null;
    cameraRectangleDataRef.current = [];
    cameraSnapProviderRef.current?.update([], offset);
    const markers = gcpMarkersRef.current;
    if (markers) {
      scene.scene.remove(markers);
      disposeGcpMarkers(markers);
    }
    gcpMarkersRef.current = null;
    gcpMarkerDataRef.current = [];
    datasetBoundsRef.current.clear();
    framedCameraRectanglesRef.current = false;
    scene.resetRenderOffset(offset[0], offset[1], offset[2]);
  }, []);

  const setSceneRenderOffset = useCallback<ViewportHandle['setSceneRenderOffset']>((offset) => {
    const scene = sceneRef.current;
    if (!scene) return;
    if (!isFiniteCoordinate3(offset)) {
      onLogRef.current?.('error', 'Ignored a non-finite PhotoLab render origin.');
      return;
    }
    const effectiveOffset = scene.setRenderOffset(offset[0], offset[1], offset[2]);
    cameraSnapProviderRef.current?.update(cameraRectangleDataRef.current, effectiveOffset);
    const previous = cameraRectanglesRef.current;
    if (previous) {
      scene.scene.remove(previous);
      disposeCameraRectangles(previous);
      cameraRectanglesRef.current = buildCameraRectangles(
        cameraRectangleDataRef.current,
        effectiveOffset,
      );
      if (cameraRectanglesRef.current) scene.scene.add(cameraRectanglesRef.current);
    }
  }, []);

  const [renderOffsetX, renderOffsetY, renderOffsetZ] = renderOffset;
  useEffect(() => {
    setSceneRenderOffset([renderOffsetX, renderOffsetY, renderOffsetZ]);
  }, [renderOffsetX, renderOffsetY, renderOffsetZ, setSceneRenderOffset]);

  useEffect(() => {
    setNavigationMode(navigationMode);
  }, [navigationMode, setNavigationMode]);

  const setCameraImageRectangles = useCallback<ViewportHandle['setCameraImageRectangles']>(
    (rectangles) => {
      const scene = sceneRef.current;
      if (!scene) return;
      const renderOffset = scene.getRenderOffset();
      const valid = rectangles.filter((rectangle) =>
        isPlausibleCameraRectangle(rectangle, renderOffset),
      );
      const rejected = rectangles.length - valid.length;
      if (rejected > 0) {
        onLogRef.current?.(
          'error',
          `Ignored ${rejected} camera rectangle${rejected === 1 ? '' : 's'} outside the active reference frame. Alignment-local coordinates must be transformed to world Easting/Northing/Height before rendering.`,
        );
      }
      onLogRef.current?.(
        'info',
        `Camera layer updated · ${valid.length}/${rectangles.length} rectangles · origin ${renderOffset.map((value) => value.toFixed(3)).join(', ')}`,
      );
      cameraRectangleDataRef.current = valid;
      const previous = cameraRectanglesRef.current;
      if (previous) {
        scene.scene.remove(previous);
        disposeCameraRectangles(previous);
      }
      cameraRectanglesRef.current = buildCameraRectangles(valid, renderOffset);
      cameraSnapProviderRef.current?.update(valid, renderOffset);
      if (cameraRectanglesRef.current) {
        scene.scene.add(cameraRectanglesRef.current);
        scene.lockRenderOffset();
      }
      if (!framedCameraRectanglesRef.current) {
        const bounds = cameraRectangleBounds(valid, renderOffset);
        if (bounds) {
          cameraRef.current?.frame(bounds.min, bounds.max);
          framedCameraRectanglesRef.current = true;
        }
      }
    },
    [],
  );

  const setGcpMarkers = useCallback<ViewportHandle['setGcpMarkers']>((markers) => {
    const scene = sceneRef.current;
    if (!scene) return;
    const renderOffset = scene.getRenderOffset();
    const valid = markers.filter(
      (marker) =>
        marker.name.trim() !== '' && toRenderLocal(marker.position, renderOffset) !== null,
    );
    const rejected = markers.length - valid.length;
    if (rejected > 0) {
      onLogRef.current?.(
        'error',
        `Ignored ${rejected} GCP marker${rejected === 1 ? '' : 's'} outside the active reference frame.`,
      );
    }
    gcpMarkerDataRef.current = valid;
    const previous = gcpMarkersRef.current;
    if (previous) {
      scene.scene.remove(previous);
      disposeGcpMarkers(previous);
    }
    gcpMarkersRef.current = buildGcpMarkers(valid, renderOffset);
    if (gcpMarkersRef.current) {
      scene.scene.add(gcpMarkersRef.current);
      scene.lockRenderOffset();
    }
  }, []);

  const frameEntities = useCallback((entityIds?: ReadonlySet<EntityId>): boolean => {
    const scene = sceneRef.current;
    const camera = cameraRef.current;
    if (!scene || !camera) return false;
    const bounds = collectSceneBounds(
      scene.getRenderOffset(),
      entityIds,
      cameraRectangleDataRef.current,
      gcpMarkerDataRef.current,
      datasetBoundsRef.current,
      productDatasetsRef.current,
    );
    if (!bounds) return false;
    camera.frame(bounds.min, bounds.max);
    return true;
  }, []);

  const frameAll = useCallback<ViewportHandle['frameAll']>(() => {
    if (!frameEntities()) {
      cameraRef.current?.frame(new Vector3(-25, -25, -1), new Vector3(25, 25, 1));
    }
  }, [frameEntities]);

  const frameSelection = useCallback<ViewportHandle['frameSelection']>(
    (entityIds) => entityIds.length > 0 && frameEntities(new Set(entityIds)),
    [frameEntities],
  );

  useImperativeHandle(
    handleRef,
    () => ({
      loadPotreePointCloud,
      removeLayer,
      setPointSize,
      setPointBudget,
      setSnapTargets,
      registerTiledDataset,
      unregisterTiledDataset,
      loadRasterPyramid,
      loadTiledMesh,
      loadGaussianSplats,
      configureRenderBudget,
      setNavigationMode,
      resetProjectScene,
      setSceneRenderOffset,
      setCameraImageRectangles,
      setGcpMarkers,
      frameAll,
      frameSelection,
    }),
    [
      loadPotreePointCloud,
      removeLayer,
      setPointSize,
      setPointBudget,
      setSnapTargets,
      registerTiledDataset,
      unregisterTiledDataset,
      loadRasterPyramid,
      loadTiledMesh,
      loadGaussianSplats,
      configureRenderBudget,
      setNavigationMode,
      resetProjectScene,
      setSceneRenderOffset,
      setCameraImageRectangles,
      setGcpMarkers,
      frameAll,
      frameSelection,
    ],
  );

  const onDragOver = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setDragOver(true);
  };
  const onDragLeave = () => setDragOver(false);
  const onDrop = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setDragOver(false);
    if (!onDropFiles) return;
    const paths: string[] = [];
    const fileList = e.dataTransfer.files;
    const webUtils = (window as { electronWebUtils?: { getPathForFile: (f: File) => string } })
      .electronWebUtils;
    for (let i = 0; i < fileList.length; i++) {
      const f = fileList.item(i);
      if (!f) continue;
      const pathFromWebUtils = webUtils?.getPathForFile(f);
      const legacyPath = (f as { path?: string }).path;
      const path = pathFromWebUtils ?? legacyPath;
      if (path) paths.push(path);
    }
    if (paths.length > 0) onDropFiles(paths);
  };

  const dropOverlay = useMemo(() => {
    if (!dragOver) return null;
    return <div className={styles.dropOverlay}>Drop LAS / LAZ to import</div>;
  }, [dragOver]);

  return (
    <div
      ref={containerRef}
      className={styles.root}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      <div className={styles.cursorOverlay} aria-live="polite">
        <span ref={overlayActiveRef} style={{ display: 'none' }}>
          <span className={styles.cursorAxis}>X</span>
          <span ref={overlayXRef}>0.000</span>
          <span className={styles.cursorAxis}>Y</span>
          <span ref={overlayYRef}>0.000</span>
          <span className={styles.cursorAxis}>Z</span>
          <span ref={overlayZRef}>0.000</span>
          <span ref={overlayKindRef} className={styles.cursorKind}></span>
        </span>
        <span ref={overlayIdleRef} className={styles.cursorOverlayMuted}>
          Move cursor over geometry…
        </span>
      </div>
      {contextMessage ? <div className={styles.contextOverlay}>{contextMessage}</div> : null}
      {dropOverlay}
    </div>
  );
});

const RAYCASTER = new Raycaster();
const NDC_VEC = new Vector2();

function queryCursor(
  e: PointerEvent,
  container: HTMLDivElement,
  scene: SceneGraph,
  camera: CameraController,
  snapping: SnappingService,
  picking: PickingPass,
  neighborhood?: ReturnType<PickingPass['readNeighborhood']>,
) {
  const ndcX = (e.clientX / window.innerWidth) * 2 - 1;
  const ndcY = -((e.clientY / window.innerHeight) * 2 - 1);
  NDC_VEC.set(ndcX, ndcY);
  RAYCASTER.setFromCamera(NDC_VEC, camera.camera);
  return snapping.query({
    pointerNdc: NDC_VEC.clone(),
    pointerClient: new Vector2(e.clientX, e.clientY),
    viewportRect: container.getBoundingClientRect(),
    pixelTolerance: 10,
    interpolationPixelRadius: 42,
    camera: camera.camera,
    ray: RAYCASTER.ray.clone(),
    sceneRenderOffset: scene.getRenderOffset(),
    previous: snapping.getLatestStable(),
    targetMask: snapping.getTargetMask(),
    pick: PICKING_ENABLED ? picking.getLatest() : null,
    pickNeighborhood: neighborhood ?? null,
    intent: 'hover',
  });
}

/**
 * Cheap structural compare to suppress redundant overlay updates when the
 * cursor hasn't really moved (sub-mm) or the snap kind/source/confidence
 * is unchanged. Position is compared at 1 µm resolution; below that the
 * displayed string would be identical anyway.
 */
function snapShallowEqual(a: SnapResult | null, b: SnapResult | null): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  if (a.kind !== b.kind) return false;
  if (a.source !== b.source) return false;
  if (Math.abs(a.confidence - b.confidence) > 0.005) return false;
  if (Math.abs(a.position.x - b.position.x) > 1e-6) return false;
  if (Math.abs(a.position.y - b.position.y) > 1e-6) return false;
  if (
    a.position.z !== b.position.z &&
    (a.position.z === null || b.position.z === null || Math.abs(a.position.z - b.position.z) > 1e-6)
  )
    return false;
  return true;
}

function detectNodeLoadConcurrency(): number {
  const cores = navigator.hardwareConcurrency || 8;
  return Math.max(6, Math.min(24, Math.floor(cores * 1.5)));
}

function clampNumber(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(min, Math.min(max, value));
}

function applyPotreeStreamingProfile(
  potree: Potree,
  clouds: Iterable<PointCloudOctree>,
  baseNodeConcurrency: number,
  profile: StreamingProfile,
): void {
  const base = Math.max(2, baseNodeConcurrency);
  const settings =
    profile === 'normal'
      ? {
          nodeLoads: base,
          gpuUploads: Math.max(4, Math.min(NORMAL_GPU_UPLOAD_CAP, Math.floor(base / 2))),
          memoryScale: NORMAL_POINT_CACHE_MULTIPLIER,
          minNodePixelSize: DEFAULT_MIN_NODE_PIXEL_SIZE,
        }
      : profile === 'interactive'
        ? {
            nodeLoads: Math.max(3, Math.min(base, 6)),
            gpuUploads: INTERACTIVE_GPU_UPLOAD_CAP,
            memoryScale: INTERACTIVE_POINT_CACHE_MULTIPLIER,
            minNodePixelSize: DEFAULT_MIN_NODE_PIXEL_SIZE,
          }
        : {
            nodeLoads: 2,
            gpuUploads: RECOVERY_GPU_UPLOAD_CAP,
            memoryScale: RECOVERY_POINT_CACHE_MULTIPLIER,
            minNodePixelSize: DEFAULT_MIN_NODE_PIXEL_SIZE + 16,
          };

  potree.maxNumNodesLoading = settings.nodeLoads;
  potree.maxLoadsToGPU = settings.gpuUploads;
  setPotreeMemoryScale(potree, settings.memoryScale);

  for (const cloud of clouds) {
    cloud.minNodePixelSize = settings.minNodePixelSize;
    cloud.pcoGeometry.maxNumNodesLoading = settings.nodeLoads;
  }
}

interface UploadAttribute {
  needsUpdate: boolean;
}
interface UploadGeometry {
  attributes?: Record<string, UploadAttribute>;
  index?: UploadAttribute | null;
}
interface ObjectWithUploadGeometry {
  geometry?: UploadGeometry;
}

function markCloudResourcesForUpload(clouds: Iterable<PointCloudOctree>): void {
  for (const cloud of clouds) {
    cloud.material.needsUpdate = true;
    cloud.traverse((object: Object3D) => {
      const geometry = (object as ObjectWithUploadGeometry).geometry;
      if (!geometry) return;
      for (const attribute of Object.values(geometry.attributes ?? {})) {
        attribute.needsUpdate = true;
      }
      if (geometry.index) {
        geometry.index.needsUpdate = true;
      }
    });
    cloud.updateMatrixWorld(true);
  }
}

function markProductResourcesForUpload(datasets: Iterable<RenderableProductDataset>): void {
  for (const dataset of datasets) {
    dataset.root.traverse((object: Object3D) => {
      const candidate = object as Object3D & {
        geometry?: UploadGeometry;
        material?:
          | { needsUpdate: boolean; map?: { needsUpdate: boolean } | null }
          | readonly { needsUpdate: boolean; map?: { needsUpdate: boolean } | null }[];
      };
      const geometry = candidate.geometry;
      if (geometry) {
        for (const attribute of Object.values(geometry.attributes ?? {}))
          attribute.needsUpdate = true;
        if (geometry.index) geometry.index.needsUpdate = true;
      }
      const materials = candidate.material
        ? Array.isArray(candidate.material)
          ? candidate.material
          : [candidate.material]
        : [];
      for (const material of materials) {
        material.needsUpdate = true;
        if (material.map) material.map.needsUpdate = true;
      }
    });
  }
}

function setPotreeMemoryScale(potree: Potree, value: number): void {
  (potree as Potree & { memoryScale: number }).memoryScale = value;
}

function buildCameraRectangles(
  rectangles: readonly CameraImageRectangle[],
  renderOffset: readonly [number, number, number],
): LineSegments | null {
  const valid = rectangles.filter(isValidCameraRectangle);
  if (valid.length === 0) return null;
  const positions = new Float32Array(valid.length * 16 * 3);
  const colors = new Float32Array(valid.length * 16 * 3);
  let cursor = 0;
  let colorCursor = 0;
  for (const rectangle of valid) {
    const color = new Color(
      themeColor(
        rectangle.depthReady
          ? '--hc-success'
          : rectangle.aligned
            ? '--hc-accent-base'
            : '--hc-warning',
      ),
    );
    const points = [rectangle.cameraCenter, ...rectangle.corners] as const;
    const edges = [
      [1, 2],
      [2, 3],
      [3, 4],
      [4, 1],
      [0, 1],
      [0, 2],
      [0, 3],
      [0, 4],
    ] as const;
    for (const [startIndex, endIndex] of edges) {
      const start = points[startIndex];
      const end = points[endIndex];
      if (!start || !end) continue;
      positions[cursor++] = start[0] - renderOffset[0];
      positions[cursor++] = start[1] - renderOffset[1];
      positions[cursor++] = start[2] - renderOffset[2];
      positions[cursor++] = end[0] - renderOffset[0];
      positions[cursor++] = end[1] - renderOffset[1];
      positions[cursor++] = end[2] - renderOffset[2];
      for (let component = 0; component < 2; component += 1) {
        colors[colorCursor++] = color.r;
        colors[colorCursor++] = color.g;
        colors[colorCursor++] = color.b;
      }
    }
  }
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(positions, 3));
  geometry.setAttribute('color', new BufferAttribute(colors, 3));
  const material = new LineBasicMaterial({
    vertexColors: true,
    transparent: true,
    opacity: 0.88,
  });
  const lines = new LineSegments(geometry, material);
  lines.name = 'photolab:camera-image-rectangles';
  lines.frustumCulled = true;
  return lines;
}

function cameraRectangleBounds(
  rectangles: readonly CameraImageRectangle[],
  renderOffset: readonly [number, number, number],
): { min: Vector3; max: Vector3 } | null {
  const points = rectangles
    .filter(isValidCameraRectangle)
    .flatMap((rectangle) => [rectangle.cameraCenter, ...rectangle.corners]);
  if (points.length === 0) return null;
  const min = new Vector3(
    Number.POSITIVE_INFINITY,
    Number.POSITIVE_INFINITY,
    Number.POSITIVE_INFINITY,
  );
  const max = new Vector3(
    Number.NEGATIVE_INFINITY,
    Number.NEGATIVE_INFINITY,
    Number.NEGATIVE_INFINITY,
  );
  for (const point of points) {
    min.min(
      new Vector3(
        point[0] - renderOffset[0],
        point[1] - renderOffset[1],
        point[2] - renderOffset[2],
      ),
    );
    max.max(
      new Vector3(
        point[0] - renderOffset[0],
        point[1] - renderOffset[1],
        point[2] - renderOffset[2],
      ),
    );
  }
  if (min.distanceTo(max) < 0.01) max.addScalar(1);
  return { min, max };
}

function isValidCameraRectangle(rectangle: CameraImageRectangle): boolean {
  return [rectangle.cameraCenter, ...rectangle.corners].every((point) =>
    point.every(Number.isFinite),
  );
}

function isPlausibleCameraRectangle(
  rectangle: CameraImageRectangle,
  renderOffset: readonly [number, number, number],
): boolean {
  return (
    isValidCameraRectangle(rectangle) &&
    [rectangle.cameraCenter, ...rectangle.corners].every(
      (point) => toRenderLocal(point, renderOffset) !== null,
    )
  );
}

function collectSceneBounds(
  renderOffset: readonly [number, number, number],
  entityIds: ReadonlySet<EntityId> | undefined,
  rectangles: readonly CameraImageRectangle[],
  markers: readonly GcpMarker[],
  worldBounds: ReadonlyMap<
    EntityId,
    { min: readonly [number, number, number]; max: readonly [number, number, number] }
  >,
  products: ReadonlyMap<EntityId, RenderableProductDataset>,
): { min: Vector3; max: Vector3 } | null {
  const box = new Box3();
  box.makeEmpty();
  const includes = (entityId: EntityId): boolean => !entityIds || entityIds.has(entityId);
  const addWorldPoint = (point: readonly [number, number, number]): void => {
    const local = toRenderLocal(point, renderOffset);
    if (local) box.expandByPoint(new Vector3(local[0], local[1], local[2]));
  };

  for (const rectangle of rectangles) {
    if (!includes(rectangle.entityId)) continue;
    for (const point of [rectangle.cameraCenter, ...rectangle.corners]) addWorldPoint(point);
  }
  for (const marker of markers) {
    if (!includes(marker.entityId)) continue;
    const local = toRenderLocal(marker.position, renderOffset);
    if (!local) continue;
    const point = new Vector3(local[0], local[1], local[2]);
    box.expandByPoint(point);
    // A survey marker is point geometry, but framing it at sub-metre scale makes
    // its world-space label fill the entire viewport. Give isolated selections a
    // stable site-context envelope while leaving full-scene bounds unchanged.
    if (entityIds) {
      box.expandByPoint(point.clone().addScalar(10));
      box.expandByPoint(point.clone().addScalar(-10));
    }
  }
  for (const [entityId, bounds] of worldBounds) {
    if (!includes(entityId)) continue;
    addWorldPoint(bounds.min);
    addWorldPoint(bounds.max);
  }
  for (const [entityId, dataset] of products) {
    if (!includes(entityId)) continue;
    const tile = dataset.getTile(dataset.rootTile);
    if (!tile) continue;
    const position = dataset.root.position;
    box.expandByPoint(
      new Vector3(
        tile.bounds.min.x + position.x,
        tile.bounds.min.y + position.y,
        tile.bounds.min.z + position.z,
      ),
    );
    box.expandByPoint(
      new Vector3(
        tile.bounds.max.x + position.x,
        tile.bounds.max.y + position.y,
        tile.bounds.max.z + position.z,
      ),
    );
  }

  if (box.isEmpty()) return null;
  if (box.min.distanceTo(box.max) < 0.01) box.expandByScalar(0.5);
  return { min: box.min.clone(), max: box.max.clone() };
}

function disposeCameraRectangles(lines: LineSegments | null): void {
  if (!lines) return;
  lines.geometry.dispose();
  const material = lines.material;
  if (Array.isArray(material)) {
    for (const entry of material) entry.dispose();
  } else {
    material.dispose();
  }
}

function buildGcpMarkers(
  markers: readonly GcpMarker[],
  renderOffset: readonly [number, number, number],
): Group | null {
  const valid = markers.filter(
    (marker) => marker.name.trim() !== '' && marker.position.every(Number.isFinite),
  );
  if (valid.length === 0) return null;
  const group = new Group();
  group.name = 'photolab:gcp-markers';
  const positions = new Float32Array(valid.length * 3);
  for (let index = 0; index < valid.length; index += 1) {
    const marker = valid[index];
    if (!marker) continue;
    positions[index * 3] = marker.position[0] - renderOffset[0];
    positions[index * 3 + 1] = marker.position[1] - renderOffset[1];
    positions[index * 3 + 2] = marker.position[2] - renderOffset[2];

    const label = buildGcpLabel(marker.name, marker.role === 'disabled');
    label.position.set(
      marker.position[0] - renderOffset[0],
      marker.position[1] - renderOffset[1],
      marker.position[2] - renderOffset[2] + 0.35,
    );
    label.userData.entityId = marker.entityId;
    group.add(label);
  }
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(positions, 3));
  const material = new PointsMaterial({
    color: themeColor('--hc-info'),
    size: 8,
    sizeAttenuation: false,
    transparent: true,
    opacity: 0.95,
  });
  const points = new Points(geometry, material);
  points.name = 'photolab:gcp-points';
  group.add(points);
  return group;
}

function buildGcpLabel(name: string, disabled: boolean): Sprite {
  const canvas = document.createElement('canvas');
  canvas.width = 512;
  canvas.height = 96;
  const context = canvas.getContext('2d');
  if (!context) return new Sprite(new SpriteMaterial());
  context.clearRect(0, 0, canvas.width, canvas.height);
  context.font = '600 30px Inter, sans-serif';
  context.textAlign = 'center';
  context.textBaseline = 'middle';
  context.lineWidth = 7;
  context.strokeStyle = themeColor('--hc-bg-void');
  context.fillStyle = themeColor(disabled ? '--hc-fg-muted' : '--hc-fg-strong');
  const clipped = name.length > 36 ? `${name.slice(0, 35)}…` : name;
  context.strokeText(clipped, 256, 48);
  context.fillText(clipped, 256, 48);
  const texture = new CanvasTexture(canvas);
  texture.needsUpdate = true;
  const material = new SpriteMaterial({ map: texture, transparent: true, depthTest: true });
  const sprite = new Sprite(material);
  sprite.scale.set(8, 1.5, 1);
  return sprite;
}

function disposeGcpMarkers(group: Group | null): void {
  if (!group) return;
  group.traverse((object) => {
    if (object instanceof Points) {
      object.geometry.dispose();
      if (Array.isArray(object.material)) {
        for (const material of object.material) material.dispose();
      } else {
        object.material.dispose();
      }
    } else if (object instanceof Sprite) {
      object.material.map?.dispose();
      object.material.dispose();
    }
  });
}

function themeColor(token: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(token).trim();
}
