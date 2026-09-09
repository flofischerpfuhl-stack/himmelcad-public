import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
  type DragEvent,
  type PointerEvent as ReactPointerEvent,
} from 'react';

import {
  DrawSnapLatencyRing,
  LocalStorageViewHistoryPersistence,
  ViewLocalHistory,
  type PointCloudDisplayStyle,
} from '@himmelcad/app';
import type { EntityId, SnapKind, SnapResult, SourcePosition3, Vec3 } from '@himmelcad/data';
import { ViewportHud, OverlayChip, registerEscapeRung } from '@himmelcad/ui';
import {
  KernelCameraController,
  createKernelOverlayGlyphAtlas,
  cssColorToLinearRgba,
  EMPTY_RENDERER_OVERLAY,
  overlayAnchorSquare,
  overlayDirectionArrow,
  type CanonicalEntity,
  type CanonicalRepresentationAdmission,
  type GeometryObject,
  type HimmelcadViewerWasmLoader,
  type KernelPickCandidate,
  type KernelCanonicalRenderAdmission,
  type KernelClipVolume,
  type KernelDiagnosticsSampleRequest,
  type KernelDiagnosticsSampleResult,
  type KernelDiagnosticsSnapshot,
  type KernelDeadlineReasonCode,
  type KernelQualitySnapshot,
  type KernelRgbaCaptureRequest,
  type KernelRgbaCaptureResult,
  type KernelRenderStyle,
  type KernelRendererOverlayPayload,
  type KernelViewingBoxAxis,
  type KernelViewingBoxFace,
  type KernelViewingBoxState,
  type KernelViewerEntityHandle,
  type KernelViewMode,
  type KernelViewModeTransitionOptions,
  type KernelWorldCamera,
  type KernelWorldPoint,
  fenceVolumeFromCamera,
  type KernelFenceVolume,
  type Representation,
  SHARED_3D_TARGET_DEVIATIONS,
  resizeViewingBoxFace,
  resizeViewingBoxCorner,
  rotateViewingBox,
  setViewingBoxMode,
  viewingBoxAxes,
  viewingBoxClipVolume,
  viewingBoxFromViewport,
} from '@himmelcad/viewer/kernel';
import { KernelViewport, type KernelViewportHandle } from '@himmelcad/viewer/kernel/react';

import styles from './BuilderKernelViewport.module.css';
import { bakePotreeViewingBox, viewingBoxBakeCacheKey } from './viewingBoxBake.js';
import { viewingBoxFromViewportDrag } from './viewingBoxWorkflow.js';

// Development raster fixtures have not entered canonical I/O yet. Keep their
// viewer-only identities visibly isolated; they never enter the project tree.
const DEV_RASTER_COMPONENTS_HASH = '01'.repeat(32);
const DEV_RASTER_ATTRIBUTES_HASH = '02'.repeat(32);
const DEV_RASTER_RELATIONS_HASH = '03'.repeat(32);
const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1] as const;

const viewerWasmUrl = new URL('viewer-wasm/himmelcad_wasm.js', window.location.href).href;
const decodeWasmUrl = new URL('viewer-decode-wasm/himmelcad_decode_wasm.js', window.location.href)
  .href;

const wasmLoader: HimmelcadViewerWasmLoader = async () => {
  const module = await import(/* @vite-ignore */ viewerWasmUrl);
  return module;
};

const POINT_CLOUD_STYLE: KernelRenderStyle = {
  baseColor: [0.72, 0.82, 0.9, 1],
  opacity: 1,
  verticalExaggeration: 1,
  colorMode: { kind: 'source' },
  fill: { kind: 'color' },
  stroke: {
    mode: { kind: 'color' },
    color: { kind: 'inherit' },
    width: { kind: 'source' },
    cap: 'butt',
    join: 'miter',
    miterLimit: 4,
  },
};
const IFC_STYLE: KernelRenderStyle = {
  ...POINT_CLOUD_STYLE,
  // Linear-light neutral blue-grey. The old near-white fallback compressed
  // most lighting contrast after sRGB presentation and made faces look flat.
  baseColor: [0.38, 0.46, 0.58, 1],
};
const RASTER_STYLE: KernelRenderStyle = {
  ...POINT_CLOUD_STYLE,
  baseColor: [1, 1, 1, 1],
};

function renderPointCloudStyle(
  display: PointCloudDisplayStyle | undefined,
  bounds: {
    readonly min: readonly [number, number, number];
    readonly max: readonly [number, number, number];
  },
): KernelRenderStyle {
  if (!display || display.colorMode === 'rgb') return POINT_CLOUD_STYLE;
  if (display.colorMode === 'intensity') {
    return { ...POINT_CLOUD_STYLE, colorMode: { kind: 'pointIntensity' } };
  }
  if (display.colorMode === 'elevation') {
    return {
      ...POINT_CLOUD_STYLE,
      colorMode: {
        kind: 'height',
        minimum: bounds.min[2],
        maximum: bounds.max[2],
        colors: [
          [0.08, 0.34, 0.95, 1],
          [0.15, 0.95, 0.65, 1],
          [1, 0.35, 0.08, 1],
        ],
      },
    };
  }
  const maximumCode = Math.max(0, ...display.classes.map((item) => item.code));
  const colors = Array.from({ length: maximumCode + 1 }, (_, code) => {
    const visible = display.classes.find((item) => item.code === code)?.visible ?? true;
    const hue = (code * 0.61803398875) % 1;
    const red = 0.35 + Math.abs(hue * 6 - 3) * 0.16;
    const green = 0.35 + Math.abs(((hue + 0.333) % 1) * 6 - 3) * 0.16;
    const blue = 0.35 + Math.abs(((hue + 0.666) % 1) * 6 - 3) * 0.16;
    return [Math.min(red, 0.95), Math.min(green, 0.95), Math.min(blue, 0.95), visible ? 1 : 0];
  });
  return { ...POINT_CLOUD_STYLE, colorMode: { kind: 'pointClassification', colors } };
}

export interface BuilderPointCloudOptions {
  readonly datasetId: string;
  /** Exact admission already committed by the canonical project runtime. */
  readonly admission: CanonicalRepresentationAdmission;
  readonly bounds: {
    readonly min: readonly [number, number, number];
    readonly max: readonly [number, number, number];
  };
  readonly display?: PointCloudDisplayStyle;
}

export interface BuilderCanonicalImportPackage {
  readonly providerId: string;
  readonly providerVersion: string;
  readonly admissions: readonly CanonicalRepresentationAdmission[];
}

export interface BuilderRasterImageOptions {
  readonly entityId: EntityId;
  readonly sourceName: string;
  readonly origin: readonly [number, number, number];
  readonly columnStep: readonly [number, number, number];
  readonly rowStep: readonly [number, number, number];
  readonly rasterSize?: readonly [number, number];
  readonly tiles?: readonly {
    readonly x: number;
    readonly y: number;
    readonly width: number;
    readonly height: number;
    readonly imageUrl: string;
    readonly depthUrl: string | null;
  }[];
}

export interface BuilderKernelViewportHandle {
  loadPotreePointCloud(metadataUrl: string, options: BuilderPointCloudOptions): Promise<void>;
  loadPreparedHierarchy(
    manifestUrl: string,
    options: {
      readonly datasetId: string;
      readonly formatId: string;
      readonly admission: CanonicalRepresentationAdmission;
    },
  ): Promise<void>;
  loadCanonicalPackage(package_: BuilderCanonicalImportPackage): Promise<readonly EntityId[]>;
  loadRasterImage(imageUrl: string, options: BuilderRasterImageOptions): Promise<void>;
  loadDrapedRaster(
    imageUrl: string,
    depthUrl: string,
    options: BuilderRasterImageOptions,
  ): Promise<void>;
  cameraHistory(action: 'get' | 'undo' | 'redo' | 'clear'): Promise<unknown>;
  frameAll(): void;
  setPreset(preset: 'top' | 'front' | 'right' | 'isometric' | 'perspective'): Promise<void>;
  setPointSize(pointSize: number): void;
  setRendererOverlayPayload(layerId: string, payload: KernelRendererOverlayPayload): void;
  setViewMode(mode: KernelViewMode, options?: KernelViewModeTransitionOptions): Promise<boolean>;
  worldCamera(): KernelWorldCamera | null;
  adoptWorldCamera(camera: KernelWorldCamera): KernelWorldCamera;
  waitForNextPresentedFrame(): Promise<void>;
  diagnosticsSnapshot(lastFrames?: number): KernelDiagnosticsSnapshot;
  qualitySnapshot(): KernelQualitySnapshot;
  sampleDiagnostics(
    request: KernelDiagnosticsSampleRequest,
  ): Promise<KernelDiagnosticsSampleResult>;
  captureRgba(request: KernelRgbaCaptureRequest): Promise<KernelRgbaCaptureResult>;
  captureRectangle(): { x: number; y: number; width: number; height: number } | null;
  typedFenceRectangle(
    anchor: KernelWorldPoint,
    width: number,
    height: number,
  ): readonly KernelWorldPoint[];
  setEntityAppearance(
    entityIds: readonly EntityId[],
    options: { readonly opacity?: number; readonly verticalExaggeration?: number },
  ): void;
  setPointCloudDisplay(entityIds: readonly EntityId[], display: PointCloudDisplayStyle): void;
  setEntityVisibility(entityIds: readonly EntityId[], visible: boolean): void;
  residentEntityIds(): readonly EntityId[];
  cycleCandidate(direction: 1 | -1): void;
  setClipVolumes(volumes: readonly KernelClipVolume[]): void;
  setAutomationClipVolumes(volumes: readonly KernelClipVolume[]): void;
  createViewingBoxAt(center?: SourcePosition3, id?: string): KernelViewingBoxState | null;
  createViewingBoxFromSelection(
    entityIds: readonly EntityId[],
    id: string,
  ): KernelViewingBoxState | null;
  setViewingBox(state: KernelViewingBoxState | null): void;
  lockViewingBox(
    state: KernelViewingBoxState,
    signal: AbortSignal,
    onProgress: (fraction: number, phase: string) => void | Promise<void>,
  ): Promise<KernelViewingBoxState>;
  unlockViewingBox(state: KernelViewingBoxState): KernelViewingBoxState;
  cancelViewingBoxDrag(): boolean;
}

export interface BuilderFenceOverlayState {
  readonly kind: 'polygon' | 'rectangle';
  readonly vertices: readonly KernelWorldPoint[];
  readonly closed: boolean;
}

interface BuilderKernelViewportProps {
  readonly projectId?: string | undefined;
  readonly hudVisible?: boolean;
  readonly pointSize: number;
  readonly onCursorSnap: (snap: SnapResult | null) => void;
  readonly onDropFiles: (paths: string[]) => void | Promise<void>;
  readonly onLog: (level: 'debug' | 'info' | 'warn' | 'error', message: string) => void;
  readonly onViewModeSettled?: (mode: KernelViewMode) => void;
  readonly viewingBox?: KernelViewingBoxState | null;
  readonly viewingBoxEditing?: boolean;
  readonly placingViewingBoxCenter?: boolean;
  readonly onViewportPoint?: (position: SourcePosition3) => void;
  readonly onViewportBox?: (state: KernelViewingBoxState) => void;
  readonly onViewingBoxChange?: (state: KernelViewingBoxState | null) => void;
  readonly viewingBoxName?: string;
  readonly viewingBoxPanelOpen?: boolean;
  readonly onOpenViewingBox?: () => void;
  readonly selectedEntityIds?: ReadonlySet<EntityId>;
  readonly onSelectEntity?: (id: EntityId, mode: 'replace' | 'toggle') => void;
  readonly onClearSelection?: () => void;
  readonly isEntityClickPickable?: (id: EntityId) => boolean;
  readonly isEntitySnappable?: (id: EntityId) => boolean;
  readonly isEntitySelectionHighlightable?: (id: EntityId) => boolean;
  readonly constructionToolId?: string | null;
  readonly constructionOrigin?: KernelWorldPoint | null;
  readonly onConstructionTab?: (direction: 1 | -1) => void;
  readonly onConstructionTyping?: (key: string) => void;
  readonly onConstructionCancel?: () => void;
  readonly onConstructionClick?: () => void;
  readonly onConstructionFinish?: () => void;
  readonly onConstructionUndo?: () => void;
  readonly onCandidateSet?: (candidates: readonly KernelPickCandidate[], index: number) => void;
  readonly onCandidateSetClear?: () => void;
  readonly onContextSurface?: (
    candidate: KernelPickCandidate | null,
    position: { readonly x: number; readonly y: number },
  ) => void;
  readonly onRegistryShortcut?: (event: KeyboardEvent) => void;
  readonly fence?: BuilderFenceOverlayState | null;
  readonly onFenceVertex?: (point: KernelWorldPoint) => void;
  readonly onFenceRectangle?: (vertices: readonly KernelWorldPoint[], closed: boolean) => void;
  readonly onFenceClose?: (volume: KernelFenceVolume) => void;
  readonly onFenceCancel?: () => void;
  readonly onFenceKey?: (key: string) => void;
  readonly onFenceNavigationRejected?: () => void;
}

interface ScreenPoint {
  readonly x: number;
  readonly y: number;
}

interface ViewingBoxFaceHandle {
  readonly kind: 'face';
  readonly axis: KernelViewingBoxAxis;
  readonly face: KernelViewingBoxFace;
  readonly point: ScreenPoint;
  readonly screenAxis: ScreenPoint;
  readonly pixelsPerWorldUnit: number;
  readonly polygon: readonly ScreenPoint[];
}

interface ViewingBoxRingHandle {
  readonly kind: 'ring';
  readonly axis: KernelViewingBoxAxis;
  readonly center: ScreenPoint;
  readonly points: readonly ScreenPoint[];
}

interface ViewingBoxCornerHandle {
  readonly kind: 'corner';
  readonly faces: readonly [KernelViewingBoxFace, KernelViewingBoxFace, KernelViewingBoxFace];
  readonly point: ScreenPoint;
  readonly screenAxes: readonly [ScreenPoint, ScreenPoint, ScreenPoint];
  readonly pixelsPerWorldUnit: readonly [number, number, number];
}

type ViewingBoxHandle = ViewingBoxFaceHandle | ViewingBoxCornerHandle | ViewingBoxRingHandle;

interface ViewingBoxBakeCacheEntry {
  readonly key: string;
  readonly proxies: readonly {
    readonly sourceEntityId: EntityId;
    readonly proxyEntityId: EntityId;
    readonly datasetId: string;
    readonly handle: KernelViewerEntityHandle;
  }[];
  readonly pointCount: number;
  readonly originalVisibility: Map<EntityId, boolean>;
}

type ViewingBoxPointerInteraction =
  | {
      readonly kind: 'face';
      readonly pointerId: number;
      readonly startClientX: number;
      readonly startClientY: number;
      readonly startState: KernelViewingBoxState;
      readonly handle: ViewingBoxFaceHandle;
      pointerMoved: boolean;
      moved: boolean;
    }
  | {
      readonly kind: 'corner';
      readonly pointerId: number;
      readonly startClientX: number;
      readonly startClientY: number;
      readonly startState: KernelViewingBoxState;
      readonly handle: ViewingBoxCornerHandle;
      pointerMoved: boolean;
      moved: boolean;
    }
  | {
      readonly kind: 'ring';
      readonly pointerId: number;
      readonly startClientX: number;
      readonly startClientY: number;
      readonly startState: KernelViewingBoxState;
      readonly handle: ViewingBoxRingHandle;
      readonly startAngle: number;
      pointerMoved: boolean;
      moved: boolean;
    };

interface ViewingBoxPlacementInteraction {
  readonly pointerId: number;
  readonly startClientX: number;
  readonly startClientY: number;
  readonly start: KernelWorldPoint;
  readonly seed: KernelViewingBoxState;
  preview: KernelViewingBoxState;
  moved: boolean;
}

export const BuilderKernelViewport = forwardRef<
  BuilderKernelViewportHandle,
  BuilderKernelViewportProps
>(function BuilderKernelViewport(
  {
    pointSize,
    hudVisible = false,
    projectId,
    onCursorSnap,
    onDropFiles,
    onLog,
    onViewModeSettled,
    viewingBox = null,
    viewingBoxEditing = false,
    placingViewingBoxCenter = false,
    onViewportPoint,
    onViewportBox,
    onViewingBoxChange,
    viewingBoxName = 'Viewing Box',
    viewingBoxPanelOpen = false,
    onOpenViewingBox,
    selectedEntityIds = new Set<EntityId>(),
    onSelectEntity,
    onClearSelection,
    isEntityClickPickable,
    isEntitySnappable,
    isEntitySelectionHighlightable,
    constructionToolId = null,
    constructionOrigin = null,
    onConstructionTab,
    onConstructionTyping,
    onConstructionCancel,
    onConstructionClick,
    onConstructionFinish,
    onConstructionUndo,
    onCandidateSet,
    onCandidateSetClear,
    onContextSurface,
    onRegistryShortcut,
    fence = null,
    onFenceVertex,
    onFenceRectangle,
    onFenceClose,
    onFenceCancel,
    onFenceKey,
    onFenceNavigationRejected,
  },
  ref,
): JSX.Element {
  const kernelRef = useRef<KernelViewportHandle | null>(null);
  const cameraHistoryRef = useRef<ViewLocalHistory<CameraHistoryState> | null>(null);
  const cameraHistoryErrorRef = useRef<string | null>(null);
  const cameraProjectIdRef = useRef<string | undefined>(projectId);
  const restoringCameraRef = useRef(false);
  const recordCamera = useCallback(() => {
    const kernel = kernelRef.current;
    if (kernel && !restoringCameraRef.current)
      cameraHistoryRef.current?.commit(
        { camera: kernel.camera.worldCamera(), mode: viewModeRef.current },
        crypto.randomUUID(),
      );
  }, []);
  useEffect(() => {
    let cancelled = false;
    cameraHistoryRef.current = null;
    cameraHistoryErrorRef.current = null;
    cameraProjectIdRef.current = projectId;
    if (!projectId) return;
    const waitForLiveKernel = async (): Promise<KernelViewportHandle> => {
      for (let attempt = 0; attempt < 1_800 && !cancelled; attempt += 1) {
        const kernel = kernelRef.current;
        if (kernel) {
          try {
            kernel.session.diagnostics();
            return kernel;
          } catch {
            // React development strict-effects retire the first session.
          }
        }
        await new Promise<void>((resolve) => window.setTimeout(resolve, 16));
      }
      throw new Error('live viewer session was not ready for camera history');
    };
    const restoreModeWhenReady = async (
      kernel: KernelViewportHandle,
      mode: KernelViewMode,
    ): Promise<void> => {
      for (let attempt = 0; attempt < 1_800 && !cancelled; attempt += 1) {
        try {
          await kernel.session.setViewMode(mode, 0);
          return;
        } catch (error) {
          if (!String(error).includes('suspended')) throw error;
          await new Promise<void>((resolve) => window.setTimeout(resolve, 16));
        }
      }
      throw new Error('navigation remained suspended while restoring camera history');
    };
    void waitForLiveKernel()
      .then(async (kernel) => {
        if (cancelled) return;
        const history = new ViewLocalHistory(
          projectId,
          'camera',
          { camera: kernel.camera.worldCamera(), mode: viewModeRef.current },
          parseCameraHistory,
          new LocalStorageViewHistoryPersistence(window.localStorage, 'camera'),
          (message) => callbacksRef.current.onLog('warn', message),
        );
        await history.open();
        if (cancelled) {
          return;
        }
        restoringCameraRef.current = true;
        try {
          const state = history.current;
          await restoreModeWhenReady(kernel, state.mode);
          if (cancelled) return;
          kernel.session.adoptWorldCamera(state.camera);
          viewModeRef.current = state.mode;
          setViewModeState(state.mode);
          cameraHistoryRef.current = history;
        } finally {
          restoringCameraRef.current = false;
        }
      })
      .catch((error: unknown) => {
        cameraHistoryErrorRef.current = String(error);
        callbacksRef.current.onLog('error', String(error));
      });
    return () => {
      cancelled = true;
      cameraHistoryRef.current = null;
    };
  }, [projectId]);
  const hostRef = useRef<HTMLDivElement | null>(null);
  const viewingBoxOverlayRef = useRef<HTMLCanvasElement | null>(null);
  const readyRef = useRef(createDeferred<KernelViewportHandle>());
  const loadedBoundsRef = useRef<Bounds | null>(null);
  const entityBoundsRef = useRef(new Map<EntityId, Bounds>());
  const entityVisibilityRef = useRef(new Map<EntityId, boolean>());
  const potreeSourcesRef = useRef(
    new Map<EntityId, BuilderPointCloudOptions & { metadataUrl: string }>(),
  );
  const viewingBoxBakeCacheRef = useRef(new Map<string, ViewingBoxBakeCacheEntry>());
  const activeViewingBoxBakeKeyRef = useRef<string | null>(null);
  const viewingBoxScopeRef = useRef<string | null>(null);
  const bakeProxySourcesRef = useRef(new Map<EntityId, EntityId>());
  const entityStylesRef = useRef(new Map<EntityId, KernelRenderStyle>());
  const entityOverlayGeometryRef = useRef(
    new Map<EntityId, Pick<CanonicalRepresentationAdmission, 'entity' | 'resolvedGeometry'>>(),
  );
  const selectionOverlayKeyRef = useRef('');
  const entityExaggerationDatumsRef = useRef(new Map<EntityId, number>());
  const callbacksRef = useRef({
    onCursorSnap,
    onDropFiles,
    onLog,
    onViewportPoint,
    onViewportBox,
    onViewingBoxChange,
    selectedEntityIds,
    onSelectEntity,
    onClearSelection,
    isEntityClickPickable,
    isEntitySnappable,
    isEntitySelectionHighlightable,
    onConstructionTab,
    onConstructionTyping,
    onConstructionCancel,
    onConstructionClick,
    onConstructionFinish,
    onConstructionUndo,
    onCandidateSet,
    onCandidateSetClear,
    onContextSurface,
    onRegistryShortcut,
    onFenceVertex,
    onFenceRectangle,
    onFenceClose,
    onFenceCancel,
    onFenceKey,
    onFenceNavigationRejected,
    constructionOrigin,
  });
  const pointerPositionRef = useRef({ x: 0, y: 0 });
  const activeSourcePositionRef = useRef<SourcePosition3 | null>(null);
  const viewingBoxRef = useRef(viewingBox);
  const viewingBoxInteractionRef = useRef<ViewingBoxPointerInteraction | null>(null);
  const viewingBoxPlacementRef = useRef<ViewingBoxPlacementInteraction | null>(null);
  const pendingViewingBoxPreviewRef = useRef<KernelViewingBoxState | null>(null);
  const viewingBoxPreviewFrameRef = useRef<number | null>(null);
  const pointSizeRef = useRef(pointSize);
  const viewModeRef = useRef<KernelViewMode>('3d');
  const automationClipIdsRef = useRef(new Set<string>());
  const highlightedSelectionRef = useRef(new Set<EntityId>());
  const drawSnapLatencyRef = useRef(new DrawSnapLatencyRing());
  callbacksRef.current = {
    onCursorSnap,
    onDropFiles,
    onLog,
    onViewportPoint,
    onViewportBox,
    onViewingBoxChange,
    selectedEntityIds,
    onSelectEntity,
    onClearSelection,
    isEntityClickPickable,
    isEntitySnappable,
    isEntitySelectionHighlightable,
    onConstructionTab,
    onConstructionTyping,
    onConstructionCancel,
    onConstructionClick,
    onConstructionFinish,
    onConstructionUndo,
    onCandidateSet,
    onCandidateSetClear,
    onContextSurface,
    onRegistryShortcut,
    onFenceVertex,
    onFenceRectangle,
    onFenceClose,
    onFenceCancel,
    onFenceKey,
    onFenceNavigationRejected,
    constructionOrigin,
  };
  // A grip gesture owns its local preview until pointer-up/cancel. React state
  // updates (cursor/hover/job chrome) must not replace it with the last
  // committed prop mid-gesture.
  if (!viewingBoxInteractionRef.current) viewingBoxRef.current = viewingBox;
  const [cursor, setCursor] = useState<SourcePosition3 | null>(null);
  const [viewMode, setViewModeState] = useState<KernelViewMode>('3d');
  const [dragging, setDragging] = useState(false);
  const [viewingBoxCursor, setViewingBoxCursor] = useState<'default' | 'grab' | 'grabbing'>(
    'default',
  );
  const [hoveredViewingBoxHandle, setHoveredViewingBoxHandle] = useState<ViewingBoxHandle | null>(
    null,
  );
  const fenceDragStartRef = useRef<KernelWorldPoint | null>(null);
  const fencePointerRef = useRef<KernelWorldPoint | null>(null);
  const [fenceClaimGeneration, setFenceClaimGeneration] = useState(0);
  const fenceRef = useRef(fence);
  fenceRef.current = fence;
  const fenceActive = fence !== null;

  useEffect(() => {
    if (!fenceActive) return;
    let cancelled = false;
    let release: (() => void) | undefined;
    void readyRef.current.promise
      .then((kernel) => {
        if (cancelled) return;
        const point = (event: Event): KernelWorldPoint | null => {
          const pointer = event as PointerEvent;
          const host = hostRef.current;
          if (!host) return null;
          const rect = host.getBoundingClientRect();
          if (rect.width <= 0 || rect.height <= 0) return null;
          return kernel.camera.worldPointOnTargetPlane(
            ((pointer.clientX - rect.left) / rect.width) * 2 - 1,
            1 - ((pointer.clientY - rect.top) / rect.height) * 2,
          );
        };
        const close = (): void => {
          const currentFence = fenceRef.current;
          if (!currentFence || currentFence.closed || currentFence.vertices.length < 3) return;
          callbacksRef.current.onFenceClose?.(
            fenceVolumeFromCamera(kernel.camera.worldCamera(), currentFence.vertices),
          );
        };
        const claims = [
          {
            row: 'lmbClick' as const,
            handle: ({ originalEvent }: { originalEvent: Event }) => {
              const currentFence = fenceRef.current;
              if (!currentFence || currentFence.closed) return;
              const next = point(originalEvent);
              if (!next) return;
              if (currentFence.kind === 'polygon') {
                const first = currentFence.vertices[0];
                const host = hostRef.current;
                const pointer = originalEvent as PointerEvent;
                if (
                  first &&
                  currentFence.vertices.length >= 3 &&
                  host &&
                  (() => {
                    const projected = projectViewingBoxPoint(
                      first,
                      kernel.camera.worldCamera(),
                      host.getBoundingClientRect(),
                    );
                    return Boolean(
                      projected &&
                      Math.hypot(
                        projected.x - (pointer.clientX - host.getBoundingClientRect().left),
                        projected.y - (pointer.clientY - host.getBoundingClientRect().top),
                      ) <= 9,
                    );
                  })()
                ) {
                  close();
                } else {
                  callbacksRef.current.onFenceVertex?.(next);
                }
              } else if (currentFence.vertices.length === 0) {
                callbacksRef.current.onFenceVertex?.(next);
              }
            },
          },
          {
            row: 'lmbDrag' as const,
            deviationReason: 'An armed rectangle fence owns LMB drag until the fence closes.',
            admit: () => {
              const currentFence = fenceRef.current;
              return currentFence?.kind === 'rectangle' && !currentFence.closed;
            },
            handle: ({ originalEvent, phase }: { originalEvent: Event; phase?: string }) => {
              const next = point(originalEvent);
              if (!next) return;
              if (phase === 'start') {
                fenceDragStartRef.current = next;
                callbacksRef.current.onFenceRectangle?.([next], false);
                kernel.setInteracting(true);
                return;
              }
              const start = fenceDragStartRef.current;
              if (!start) return;
              const rectangle = rectangleOnCameraPlane(start, next, kernel.camera.worldCamera());
              if (phase === 'move') {
                callbacksRef.current.onFenceRectangle?.(rectangle, false);
              } else {
                fenceDragStartRef.current = null;
                kernel.setInteracting(false);
                if (phase === 'end') {
                  callbacksRef.current.onFenceRectangle?.(rectangle, true);
                  callbacksRef.current.onFenceClose?.(
                    fenceVolumeFromCamera(kernel.camera.worldCamera(), rectangle),
                  );
                }
              }
            },
          },
          ...(['lmbDoubleClickEntity', 'lmbDoubleClickVoid'] as const).map((row) => ({
            row,
            deviationReason: 'Double-click closes the active point-cloud fence.',
            handle: close,
          })),
          {
            row: 'escape' as const,
            handle: () => {
              callbacksRef.current.onFenceCancel?.();
              // The arbiter disarms a tool after consuming its Escape rung. An
              // open/closed fence discards first, so re-arm if the function
              // remains active for the next empty fence.
              queueMicrotask(() => setFenceClaimGeneration((generation) => generation + 1));
            },
          },
          {
            row: 'typing' as const,
            entryFocus: 'numeric' as const,
            handle: ({ originalEvent }: { originalEvent: Event }) =>
              callbacksRef.current.onFenceKey?.((originalEvent as KeyboardEvent).key),
          },
          {
            row: 'tab' as const,
            handle: ({ originalEvent }: { originalEvent: Event }) => {
              const event = originalEvent as KeyboardEvent;
              callbacksRef.current.onFenceKey?.(event.shiftKey ? 'Shift+Tab' : 'Tab');
            },
          },
          ...(['mmbDrag', 'rmbDrag', 'wheel'] as const).map((row) => ({
            row,
            deviationReason: 'Open fence vertices remain fixed on the current view plane.',
            admit: () => {
              const currentFence = fenceRef.current;
              return Boolean(
                currentFence && currentFence.vertices.length > 0 && !currentFence.closed,
              );
            },
            handle: () => callbacksRef.current.onFenceNavigationRejected?.(),
          })),
        ];
        release = kernel.navigation.gestures.registerGestureClaims('pointcloud.fence', claims);
      })
      .catch((error: unknown) => callbacksRef.current.onLog('error', String(error)));
    return () => {
      cancelled = true;
      release?.();
      fenceDragStartRef.current = null;
      kernelRef.current?.setInteracting(false);
    };
  }, [fenceActive, fenceClaimGeneration]);

  useEffect(() => {
    pointSizeRef.current = pointSize;
    kernelRef.current?.session.setPointSize(pointSize);
  }, [pointSize]);

  useEffect(() => {
    if (!constructionToolId) return;
    let cancelled = false;
    let release: (() => void) | undefined;
    void readyRef.current.promise
      .then((kernel) => {
        if (cancelled) return;
        release = kernel.navigation.gestures.registerGestureClaims(constructionToolId, [
          {
            row: 'tab',
            handle: ({ direction }) => {
              if (direction !== undefined) callbacksRef.current.onConstructionTab?.(direction);
            },
          },
          {
            row: 'typing',
            entryFocus: 'numeric',
            handle: ({ originalEvent }) =>
              callbacksRef.current.onConstructionTyping?.((originalEvent as KeyboardEvent).key),
          },
          {
            row: 'candidateCycle',
            handle: ({ direction }) => kernel.navigation.cycleCandidate(direction),
          },
          { row: 'lmbClick', handle: () => callbacksRef.current.onConstructionClick?.() },
          {
            row: 'lmbDoubleClickEntity',
            handle: () => callbacksRef.current.onConstructionFinish?.(),
          },
          {
            row: 'lmbDoubleClickVoid',
            deviationReason:
              'Double-click finishes the active polyline without changing selection.',
            handle: () => callbacksRef.current.onConstructionFinish?.(),
          },
          { row: 'escape', handle: () => callbacksRef.current.onConstructionCancel?.() },
        ]);
        const host = hostRef.current;
        const onKeyDown = (event: KeyboardEvent): void => {
          if (
            event.target instanceof HTMLInputElement ||
            event.target instanceof HTMLTextAreaElement
          )
            return;
          if (event.key === 'Enter') {
            event.preventDefault();
            event.stopImmediatePropagation();
            if (kernel.navigation.cameraContinuumState()) {
              callbacksRef.current.onLog('info', 'Finish or cancel view transition');
              return;
            }
            callbacksRef.current.onConstructionFinish?.();
          } else if (event.key === 'Backspace') {
            event.preventDefault();
            event.stopImmediatePropagation();
            callbacksRef.current.onConstructionUndo?.();
          }
        };
        host?.addEventListener('keydown', onKeyDown, true);
        const releaseClaims = release;
        release = () => {
          host?.removeEventListener('keydown', onKeyDown, true);
          releaseClaims?.();
        };
      })
      .catch((error: unknown) => callbacksRef.current.onLog('error', String(error)));
    return () => {
      cancelled = true;
      release?.();
    };
  }, [constructionToolId]);

  useEffect(() => {
    const kernel = kernelRef.current;
    if (!kernel) return;
    const next = new Set(
      [...selectedEntityIds].filter(
        (id) => callbacksRef.current.isEntitySelectionHighlightable?.(id) ?? true,
      ),
    );
    for (const id of highlightedSelectionRef.current) {
      if (!next.has(id))
        kernel.session.setEntityInteractionState(id, { selected: false, hovered: false });
    }
    for (const id of next) {
      if (!highlightedSelectionRef.current.has(id)) {
        kernel.session.setEntityInteractionState(id, { selected: true, hovered: false });
      }
    }
    highlightedSelectionRef.current = next;
    selectionOverlayKeyRef.current = '';
  }, [selectedEntityIds]);

  useEffect(() => {
    drawViewingBoxOverlay(
      viewingBoxOverlayRef.current,
      hostRef.current,
      kernelRef.current,
      viewingBox,
      hoveredViewingBoxHandle,
      viewingBoxEditing,
    );
  }, [hoveredViewingBoxHandle, viewingBox, viewingBoxEditing]);

  useEffect(() => {
    if (placingViewingBoxCenter) return;
    const placement = viewingBoxPlacementRef.current;
    if (!placement) return;
    viewingBoxPlacementRef.current = null;
    kernelRef.current?.setInteracting(false);
    drawViewingBoxOverlay(
      viewingBoxOverlayRef.current,
      hostRef.current,
      kernelRef.current,
      viewingBoxRef.current,
    );
    kernelRef.current?.requestFrame();
  }, [placingViewingBoxCenter]);

  useEffect(() => {
    if (!viewingBoxEditing) return;
    let cancelled = false;
    let release: (() => void) | undefined;
    void readyRef.current.promise.then((kernel) => {
      if (cancelled) return;
      release = kernel.navigation.gestures.registerGestureClaims('view.viewing-box.grips', [
        {
          row: 'lmbDrag',
          deviationReason: SHARED_3D_TARGET_DEVIATIONS.lmbDrag,
          handle: () => undefined,
        },
      ]);
    });
    return () => {
      cancelled = true;
      release?.();
    };
  }, [viewingBoxEditing]);

  useEffect(
    () => () => {
      if (viewingBoxPreviewFrameRef.current !== null) {
        cancelAnimationFrame(viewingBoxPreviewFrameRef.current);
      }
      kernelRef.current?.setInteracting(false);
    },
    [],
  );

  const frameAll = useCallback(() => {
    const kernel = kernelRef.current;
    const bounds = loadedBoundsRef.current;
    if (!kernel || !bounds) return;
    kernel.camera.frame(tuplePoint(bounds.min), tuplePoint(bounds.max));
    kernel.session.setWorldCamera(
      kernel.camera.worldCamera(),
      kernel.camera.recommendedFloatingOrigin(),
    );
    kernel.requestFrame();
    recordCamera();
  }, [recordCamera]);

  const changeViewMode = useCallback(
    async (mode: KernelViewMode, options?: KernelViewModeTransitionOptions): Promise<boolean> => {
      const kernel = kernelRef.current;
      await kernel?.session.setViewMode(mode, options).catch((error: unknown) => {
        callbacksRef.current.onLog('error', `View mode change failed: ${String(error)}`);
        throw error;
      });
      if (!kernel || kernel.session.currentViewMode() !== mode) return false;
      viewModeRef.current = mode;
      setViewModeState(mode);
      onViewModeSettled?.(mode);
      recordCamera();
      return true;
    },
    [onViewModeSettled, recordCamera],
  );

  useImperativeHandle(
    ref,
    () => ({
      async loadPotreePointCloud(metadataUrl, options) {
        const kernel = await readyRef.current.promise;
        const entityId = options.admission.entity.id as EntityId;
        if (options.admission.resolvedGeometry.kind !== 'pointCloud') {
          throw new Error('committed LAS admission does not resolve to point-cloud geometry');
        }
        const pointCloudStyle = renderPointCloudStyle(options.display, options.bounds);
        await kernel.session.loadPotree(
          {
            datasetId: options.datasetId,
            metadataUri: metadataUrl,
            admission: options.admission,
            style: pointCloudStyle,
          },
          { operationId: `builder/load/${entityId}` },
        );
        potreeSourcesRef.current.set(entityId, { ...options, metadataUrl });
        entityBoundsRef.current.set(entityId, options.bounds);
        entityVisibilityRef.current.set(entityId, true);
        entityStylesRef.current.set(entityId, pointCloudStyle);
        if (options.display) {
          kernel.session.setEntityPointSizeMultiplier(entityId, options.display.pointSizePixels);
        }
        entityExaggerationDatumsRef.current.set(entityId, options.bounds.min[2]);
        loadedBoundsRef.current = unionBounds(loadedBoundsRef.current, options.bounds);
        frameAll();
      },
      async loadPreparedHierarchy(manifestUrl, options) {
        const kernel = await readyRef.current.promise;
        const response = await fetch(manifestUrl);
        if (!response.ok) {
          throw new Error(`Prepared hierarchy manifest failed with HTTP ${response.status}`);
        }
        const manifestBytes = new Uint8Array(await response.arrayBuffer());
        const bounds = preparedHierarchyBounds(manifestBytes);
        const entityId = options.admission.entity.id as EntityId;
        kernel.session.loadPreparedHierarchy({
          datasetId: options.datasetId,
          formatId: options.formatId,
          manifestUri: manifestUrl,
          manifestBytes,
          admissions: [
            {
              admission: options.admission,
              style:
                options.admission.resolvedGeometry.kind === 'elevationSurface'
                  ? RASTER_STYLE
                  : IFC_STYLE,
              exaggerationDatum: bounds.min[2],
            },
          ],
        });
        entityBoundsRef.current.set(entityId, bounds);
        entityVisibilityRef.current.set(entityId, true);
        entityStylesRef.current.set(
          entityId,
          options.admission.resolvedGeometry.kind === 'elevationSurface' ? RASTER_STYLE : IFC_STYLE,
        );
        entityExaggerationDatumsRef.current.set(entityId, bounds.min[2]);
        loadedBoundsRef.current = unionBounds(loadedBoundsRef.current, bounds);
        frameAll();
      },
      async loadCanonicalPackage(package_) {
        const kernel = await readyRef.current.promise;
        const admissions: KernelCanonicalRenderAdmission[] = package_.admissions.map(
          (admission) => ({
            admission,
            style: IFC_STYLE,
          }),
        );
        if (admissions.length === 0) return [];
        kernel.session.loadCanonical(admissions);
        const loaded = new Set(admissions.map(({ admission }) => admission.entity.id as EntityId));
        for (const { admission } of admissions) {
          entityOverlayGeometryRef.current.set(admission.entity.id as EntityId, {
            entity: admission.entity,
            resolvedGeometry: admission.resolvedGeometry,
          });
        }
        for (const id of loaded) {
          entityStylesRef.current.set(id, IFC_STYLE);
          entityExaggerationDatumsRef.current.set(id, 0);
          entityVisibilityRef.current.set(id, true);
        }
        kernel.requestFrame();
        return [...loaded];
      },
      async loadRasterImage(imageUrl, options) {
        const kernel = await readyRef.current.promise;
        const dimensions = options.rasterSize
          ? { width: options.rasterSize[0], height: options.rasterSize[1] }
          : await decodeImageDimensions(imageUrl);
        await loadPreparedRaster(
          kernel,
          imageUrl,
          null,
          dimensions.width,
          dimensions.height,
          options,
          {
            min: options.origin[2],
            max: options.origin[2],
          },
        );
        entityStylesRef.current.set(options.entityId, RASTER_STYLE);
        entityExaggerationDatumsRef.current.set(options.entityId, options.origin[2]);
        const last = rasterCorner(
          options.origin,
          options.columnStep,
          options.rowStep,
          dimensions.width,
          dimensions.height,
        );
        loadedBoundsRef.current = unionBounds(loadedBoundsRef.current, {
          min: [
            Math.min(options.origin[0], last[0]),
            Math.min(options.origin[1], last[1]),
            options.origin[2],
          ],
          max: [
            Math.max(options.origin[0], last[0]),
            Math.max(options.origin[1], last[1]),
            options.origin[2],
          ],
        });
        kernel.requestFrame();
      },
      async loadDrapedRaster(imageUrl, depthUrl, options) {
        const kernel = await readyRef.current.promise;
        const dimensions = options.rasterSize
          ? { width: options.rasterSize[0], height: options.rasterSize[1] }
          : await decodeImageDimensions(imageUrl);
        await loadPreparedRaster(
          kernel,
          imageUrl,
          depthUrl,
          dimensions.width,
          dimensions.height,
          options,
          {
            min: 482.035,
            max: 560.356,
          },
        );
        entityStylesRef.current.set(options.entityId, RASTER_STYLE);
        entityExaggerationDatumsRef.current.set(options.entityId, 482.035);
        loadedBoundsRef.current = unionBounds(loadedBoundsRef.current, {
          min: [691064.265, 5334758.3, 482.035],
          max: [691289.676, 5335057.515, 560.356],
        });
        kernel.requestFrame();
      },
      async cameraHistory(action) {
        const history = cameraHistoryRef.current,
          kernel = kernelRef.current;
        if (!history || !kernel || restoringCameraRef.current)
          throw new Error(
            `Camera history is not ready (history=${Boolean(history)}, viewer=${Boolean(kernel)}, restoring=${restoringCameraRef.current}, project=${cameraProjectIdRef.current ?? 'none'}, error=${cameraHistoryErrorRef.current ?? 'none'})`,
          );
        if (action === 'get') {
          await history.flushPersistence();
          return history.snapshot;
        }
        if (action === 'clear') {
          history.clear();
          return history.snapshot;
        }
        restoringCameraRef.current = true;
        try {
          const snapshot = history.snapshot;
          const state =
            action === 'undo' && history.canUndo
              ? parseCameraHistory(snapshot.entries[snapshot.cursor - 1]!.before)
              : action === 'redo' && history.canRedo
                ? parseCameraHistory(snapshot.entries[snapshot.cursor]!.after)
                : history.current;
          await kernel.session.setViewMode(state.mode, 0);
          kernel.session.adoptWorldCamera(state.camera);
          viewModeRef.current = state.mode;
          setViewModeState(state.mode);
          if (action === 'undo') history.undo();
          else history.redo();
        } finally {
          restoringCameraRef.current = false;
        }
        return history.snapshot;
      },
      frameAll,
      async setPreset(preset) {
        const kernel = kernelRef.current;
        if (!kernel) throw new Error('viewer is not ready');
        const camera = kernel.camera.worldCamera();
        if (viewModeRef.current === '2d' && preset !== 'top')
          throw new Error('This preset requires 3D or 2.5D navigation.');
        const settled = await kernel.session.transitionToWorldCamera(
          KernelCameraController.preset(camera, preset),
        );
        if (settled) recordCamera();
      },
      setPointSize(pointSize) {
        kernelRef.current?.session.setPointSize(pointSize);
      },
      setRendererOverlayPayload(layerId, payload) {
        const kernel = kernelRef.current;
        if (!kernel) return;
        kernel.session.setRendererOverlayPayload(layerId, 'hcad.renderer-overlay-mono@1', payload);
      },
      setViewMode(mode, options) {
        return changeViewMode(mode, options);
      },
      worldCamera() {
        return kernelRef.current?.camera.worldCamera() ?? null;
      },
      adoptWorldCamera(camera) {
        const kernel = kernelRef.current;
        if (!kernel) throw new Error('viewer is not ready');
        const adopted = kernel.session.adoptWorldCamera(camera);
        recordCamera();
        return adopted;
      },
      async waitForNextPresentedFrame() {
        const kernel = kernelRef.current;
        if (!kernel) throw new Error('viewer is not ready');
        await kernel.session.waitForNextPresentedFrame();
      },
      diagnosticsSnapshot(lastFrames) {
        const kernel = kernelRef.current;
        if (!kernel) throw new Error('viewer is not ready');
        return kernel.session.diagnosticsSnapshot(lastFrames);
      },
      qualitySnapshot() {
        const kernel = kernelRef.current;
        if (!kernel) throw new Error('viewer is not ready');
        return kernel.session.qualitySnapshot();
      },
      sampleDiagnostics(request) {
        const kernel = kernelRef.current;
        if (!kernel) throw new Error('viewer is not ready');
        return kernel.session.sampleDiagnostics(request);
      },
      async captureRgba(request) {
        const kernel = kernelRef.current;
        if (!kernel) throw new Error('viewer is not ready');
        return await kernel.session.captureRgba(request);
      },
      captureRectangle() {
        const bounds = hostRef.current?.getBoundingClientRect();
        return bounds
          ? {
              x: Math.round(bounds.x),
              y: Math.round(bounds.y),
              width: Math.round(bounds.width),
              height: Math.round(bounds.height),
            }
          : null;
      },
      typedFenceRectangle(anchor, width, height) {
        if (![width, height].every(Number.isFinite) || width === 0 || height === 0) {
          throw new RangeError('Fence rectangle width and height must be finite and non-zero.');
        }
        const camera = kernelRef.current?.camera.worldCamera();
        if (!camera) throw new Error('Viewer camera is not ready.');
        const forward = normalizeVector({
          x: camera.target.x - camera.eye.x,
          y: camera.target.y - camera.eye.y,
          z: camera.target.z - camera.eye.z,
        });
        const right = normalizeVector(crossVector(forward, camera.up));
        const up = crossVector(right, forward);
        return rectangleOnCameraPlane(
          anchor,
          addScaledPoint(addScaledPoint(anchor, right, width), up, height),
          camera,
        );
      },
      setEntityAppearance(entityIds, options) {
        const kernel = kernelRef.current;
        if (!kernel) return;
        for (const entityId of entityIds) {
          const current = entityStylesRef.current.get(entityId);
          if (!current) continue;
          const next = {
            ...current,
            ...(options.opacity === undefined ? {} : { opacity: options.opacity }),
            ...(options.verticalExaggeration === undefined
              ? {}
              : { verticalExaggeration: options.verticalExaggeration }),
          };
          kernel.session.setEntityStyle(
            entityId,
            next,
            entityExaggerationDatumsRef.current.get(entityId) ?? 0,
          );
          entityStylesRef.current.set(entityId, next);
        }
      },
      setPointCloudDisplay(entityIds, display) {
        const kernel = kernelRef.current;
        if (!kernel) return;
        for (const entityId of entityIds) {
          kernel.session.setEntityPointSizeMultiplier(entityId, display.pointSizePixels);
          const bounds = loadedBoundsRef.current;
          if (!bounds) continue;
          const current = entityStylesRef.current.get(entityId) ?? POINT_CLOUD_STYLE;
          const next = {
            ...current,
            colorMode: renderPointCloudStyle(display, bounds).colorMode,
          };
          kernel.session.setEntityStyle(
            entityId,
            next,
            entityExaggerationDatumsRef.current.get(entityId) ?? 0,
          );
          entityStylesRef.current.set(entityId, next);
        }
      },
      setEntityVisibility(entityIds, visible) {
        const kernel = kernelRef.current;
        if (!kernel) return;
        kernel.navigation.gestures.clearCandidateIndicator();
        for (const entityId of entityIds) {
          entityVisibilityRef.current.set(entityId, visible);
          const active = activeViewingBoxBakeKeyRef.current
            ? viewingBoxBakeCacheRef.current.get(activeViewingBoxBakeKeyRef.current)
            : null;
          const proxy = active?.proxies.find((candidate) => candidate.sourceEntityId === entityId);
          if (proxy) {
            active!.originalVisibility.set(entityId, visible);
            kernel.scene.setEntityVisibility(entityId, false);
            proxy.handle.setVisible(visible);
          } else {
            kernel.scene.setEntityVisibility(entityId, visible);
          }
        }
        kernel.requestFrame();
      },
      residentEntityIds() {
        return [...entityVisibilityRef.current.keys()];
      },
      cycleCandidate(direction) {
        kernelRef.current?.navigation.cycleCandidate(direction);
      },
      setClipVolumes(volumes) {
        kernelRef.current?.navigation.gestures.clearCandidateIndicator();
        kernelRef.current?.session.setClipVolumes(volumes);
      },
      setAutomationClipVolumes(volumes) {
        const kernel = kernelRef.current;
        if (!kernel) throw new Error('viewer is not ready');
        kernel.navigation.gestures.clearCandidateIndicator();
        const next = new Set(volumes.map((volume) => volume.id));
        for (const id of automationClipIdsRef.current) {
          if (!next.has(id)) kernel.session.setScopedClipVolume(`automation:${id}`, null);
        }
        for (const volume of volumes) {
          kernel.session.setScopedClipVolume(`automation:${volume.id}`, volume);
        }
        automationClipIdsRef.current = next;
      },
      createViewingBoxAt(center, id) {
        const kernel = kernelRef.current;
        if (!kernel) return null;
        const camera = kernel.camera.worldCamera();
        const target = center
          ? {
              x: center.x,
              y: center.y,
              z: center.z ?? camera.target.z,
            }
          : camera.target;
        return createViewingBoxSeed(camera, target, id);
      },
      createViewingBoxFromSelection(entityIds, id) {
        let bounds: Bounds | null = null;
        for (const entityId of entityIds) {
          const entityBounds = entityBoundsRef.current.get(entityId);
          if (entityBounds) bounds = unionBounds(bounds, entityBounds);
        }
        if (!bounds) return null;
        return {
          id,
          center: {
            x: (bounds.min[0] + bounds.max[0]) * 0.5,
            y: (bounds.min[1] + bounds.max[1]) * 0.5,
            z: (bounds.min[2] + bounds.max[2]) * 0.5,
          },
          halfExtents: {
            x: Math.max(1e-6, (bounds.max[0] - bounds.min[0]) * 0.5),
            y: Math.max(1e-6, (bounds.max[1] - bounds.min[1]) * 0.5),
            z: Math.max(1e-6, (bounds.max[2] - bounds.min[2]) * 0.5),
          },
          rotation: [0, 0, 0, 1],
          mode: 'resize',
          enabled: true,
          operation: 'keepInside',
          lockMode: 'unlocked',
          bakeKey: null,
        };
      },
      setViewingBox(state) {
        const kernel = kernelRef.current;
        if (!kernel) return;
        if (viewingBoxScopeRef.current && viewingBoxScopeRef.current !== state?.id) {
          kernel.session.setScopedClipVolume(
            `builder:viewing-box:${viewingBoxScopeRef.current}`,
            null,
          );
        }
        viewingBoxScopeRef.current = state?.id ?? null;
        if (state) {
          kernel.session.setScopedClipVolume(
            `builder:viewing-box:${state.id}`,
            viewingBoxClipVolume(state),
          );
        }
      },
      async lockViewingBox(state, signal, onProgress) {
        const kernel = kernelRef.current;
        const api = window.himmelcad;
        if (!kernel || !api) throw new Error('Viewer bake bridge is not ready.');
        const sources = [...potreeSourcesRef.current.entries()].map(([entityId, source]) => ({
          entityId,
          source,
        }));
        if (sources.length === 0) return { ...state, lockMode: 'editFreeze', bakeKey: null };
        const rawKey = viewingBoxBakeCacheKey(
          state,
          sources.map(({ entityId, source }) => ({
            entityId,
            entityRevision: source.admission.entity.revision,
            placement: source.admission.entity.placement,
            datasetId: source.datasetId,
          })),
        );
        const bakeKey = await sha256Hex(new TextEncoder().encode(rawKey));
        const activatePreparedCache = (key: string, entry: ViewingBoxBakeCacheEntry): void => {
          const previousKey = activeViewingBoxBakeKeyRef.current;
          if (previousKey && previousKey !== key) {
            const previous = viewingBoxBakeCacheRef.current.get(previousKey);
            for (const proxy of previous?.proxies ?? []) proxy.handle.setVisible(false);
          }
          for (const proxy of entry.proxies) {
            proxy.handle.setVisible(entry.originalVisibility.get(proxy.sourceEntityId) ?? true);
            kernel.scene.setEntityVisibility(proxy.sourceEntityId, false);
          }
          activeViewingBoxBakeKeyRef.current = key;
        };
        if (
          state.lockMode === 'baked' &&
          state.bakeKey === bakeKey &&
          state.bakedSources &&
          state.bakedSources.length > 0
        ) {
          const proxies: ViewingBoxBakeCacheEntry['proxies'][number][] = [];
          const originalVisibility = new Map<EntityId, boolean>();
          try {
            for (const bakedSource of state.bakedSources) {
              throwIfViewingBoxBakeAborted(signal);
              const sourceEntityId = bakedSource.sourceEntityId as EntityId;
              const source = potreeSourcesRef.current.get(sourceEntityId);
              if (!source) throw new Error(`Baked source ${sourceEntityId} is no longer resident.`);
              const response = await fetch(bakedSource.metadataUrl, { signal });
              if (!response.ok)
                throw new Error(`Baked dataset ${bakedSource.datasetId} is missing.`);
              const metadata = new Uint8Array(await response.arrayBuffer());
              const proxyEntityId = `${sourceEntityId}:viewing-box:${state.id}` as EntityId;
              const admission = await bakedPointCloudAdmission(
                kernel,
                source.admission,
                proxyEntityId,
                metadata,
                bakedSource.pointCount,
              );
              const handle = await kernel.session.loadPotree(
                {
                  datasetId: bakedSource.datasetId,
                  metadataUri: bakedSource.metadataUrl,
                  admission,
                  style: renderPointCloudStyle(source.display, source.bounds),
                },
                { signal, operationId: `builder/viewing-box-restore/${state.id}` },
              );
              const visible = entityVisibilityRef.current.get(sourceEntityId) ?? true;
              // Keep every restored proxy dark until the complete set is ready.
              // Otherwise a late cancellation can briefly publish a mixed
              // source/proxy scene before the canonical lock is accepted.
              handle.setVisible(false);
              originalVisibility.set(sourceEntityId, visible);
              bakeProxySourcesRef.current.set(proxyEntityId, sourceEntityId);
              proxies.push({
                sourceEntityId,
                proxyEntityId,
                datasetId: bakedSource.datasetId,
                handle,
              });
            }
            await onProgress(1, 'Restored prepared viewing-box data');
            throwIfViewingBoxBakeAborted(signal);
            const entry: ViewingBoxBakeCacheEntry = {
              key: state.bakeKey,
              proxies,
              pointCount: state.bakedSources.reduce((sum, source) => sum + source.pointCount, 0),
              originalVisibility,
            };
            viewingBoxBakeCacheRef.current.set(state.bakeKey, entry);
            activatePreparedCache(state.bakeKey, entry);
            return state;
          } catch (error) {
            for (const proxy of proxies) {
              bakeProxySourcesRef.current.delete(proxy.proxyEntityId);
              if (proxy.handle.loaded) proxy.handle.unload();
            }
            for (const [entityId, visible] of originalVisibility) {
              kernel.scene.setEntityVisibility(entityId, visible);
            }
            throw error;
          }
        }
        const cached = viewingBoxBakeCacheRef.current.get(bakeKey);
        if (cached) {
          await onProgress(1, `Restored ${cached.pointCount.toLocaleString()} baked points`);
          throwIfViewingBoxBakeAborted(signal);
          activatePreparedCache(bakeKey, cached);
          return { ...state, lockMode: 'baked', bakeKey };
        }

        const baked: {
          sourceEntityId: EntityId;
          source: BuilderPointCloudOptions & { metadataUrl: string };
          result: Awaited<ReturnType<typeof bakePotreeViewingBox>>;
        }[] = [];
        for (let sourceIndex = 0; sourceIndex < sources.length; sourceIndex += 1) {
          const item = sources[sourceIndex]!;
          throwIfViewingBoxBakeAborted(signal);
          const result = await bakePotreeViewingBox({
            metadataUrl: item.source.metadataUrl,
            box: state,
            placement: item.source.admission.entity.placement,
            signal,
            onProgress: (fraction, phase) =>
              onProgress((sourceIndex + fraction) / sources.length, phase),
          });
          baked.push({ sourceEntityId: item.entityId, source: item.source, result });
        }
        const sourcePointCount = baked.reduce((sum, item) => sum + item.result.sourcePointCount, 0);
        const pointCount = baked.reduce((sum, item) => sum + item.result.pointCount, 0);
        if (
          (state.operation ?? 'keepInside') === 'removeInside' &&
          pointCount > sourcePointCount * 0.5
        ) {
          await onProgress(1, 'Copy scope retained for a majority outside result');
          throwIfViewingBoxBakeAborted(signal);
          return { ...state, lockMode: 'editFreeze', bakeKey: null };
        }

        const published: string[] = [];
        const bakedSources: NonNullable<KernelViewingBoxState['bakedSources']>[number][] = [];
        const proxies: ViewingBoxBakeCacheEntry['proxies'][number][] = [];
        const previousActiveKey = activeViewingBoxBakeKeyRef.current;
        try {
          for (const item of baked) {
            throwIfViewingBoxBakeAborted(signal);
            const publication = await api.viewingBoxBake.publish({
              cacheKey: `${rawKey}:${item.sourceEntityId}`,
              metadata: item.result.metadata,
              hierarchy: item.result.hierarchy,
              octree: item.result.octree,
            });
            published.push(publication.datasetId);
            bakedSources.push({
              sourceEntityId: item.sourceEntityId,
              datasetId: publication.datasetId,
              metadataUrl: publication.metadataUrl,
              pointCount: item.result.pointCount,
            });
            const proxyEntityId = `${item.sourceEntityId}:viewing-box:${state.id}` as EntityId;
            const admission = await bakedPointCloudAdmission(
              kernel,
              item.source.admission,
              proxyEntityId,
              item.result.metadata,
              item.result.pointCount,
            );
            const handle = await kernel.session.loadPotree(
              {
                datasetId: publication.datasetId,
                metadataUri: publication.metadataUrl,
                admission,
                style: renderPointCloudStyle(item.source.display, item.source.bounds),
              },
              { signal, operationId: `builder/viewing-box-bake/${state.id}` },
            );
            // Publication is atomic at the scene boundary: prepared proxies
            // remain hidden until every source is loaded and the final
            // cancellable progress callback has returned.
            handle.setVisible(false);
            bakeProxySourcesRef.current.set(proxyEntityId, item.sourceEntityId);
            proxies.push({
              sourceEntityId: item.sourceEntityId,
              proxyEntityId,
              datasetId: publication.datasetId,
              handle,
            });
          }
          const originalVisibility = new Map<EntityId, boolean>();
          for (const { entityId } of sources) {
            originalVisibility.set(entityId, entityVisibilityRef.current.get(entityId) ?? true);
          }
          await onProgress(1, `Locked ${pointCount.toLocaleString()} prepared points`);
          throwIfViewingBoxBakeAborted(signal);
          const entry: ViewingBoxBakeCacheEntry = {
            key: bakeKey,
            proxies,
            pointCount,
            originalVisibility,
          };
          viewingBoxBakeCacheRef.current.set(bakeKey, entry);
          activatePreparedCache(bakeKey, entry);
          return { ...state, lockMode: 'baked', bakeKey, bakedSources };
        } catch (error) {
          for (const proxy of proxies) {
            bakeProxySourcesRef.current.delete(proxy.proxyEntityId);
            if (proxy.handle.loaded) proxy.handle.unload();
          }
          await Promise.all(published.map((datasetId) => api.viewingBoxBake.revoke(datasetId)));
          for (const { entityId } of sources) {
            kernel.scene.setEntityVisibility(
              entityId,
              previousActiveKey ? false : (entityVisibilityRef.current.get(entityId) ?? true),
            );
          }
          throw error;
        }
      },
      unlockViewingBox(state) {
        const kernel = kernelRef.current;
        const bakeKey = state.bakeKey ?? activeViewingBoxBakeKeyRef.current;
        const cached = bakeKey ? viewingBoxBakeCacheRef.current.get(bakeKey) : null;
        if (kernel && cached) {
          for (const proxy of cached.proxies) proxy.handle.setVisible(false);
          for (const [entityId, visible] of cached.originalVisibility) {
            kernel.scene.setEntityVisibility(entityId, visible);
          }
          kernel.requestFrame();
        }
        activeViewingBoxBakeKeyRef.current = null;
        return { ...state, lockMode: 'unlocked', bakeKey: null, bakedSources: [] };
      },
      cancelViewingBoxDrag() {
        const interaction = viewingBoxInteractionRef.current;
        if (!interaction) return false;
        viewingBoxInteractionRef.current = null;
        pendingViewingBoxPreviewRef.current = null;
        if (viewingBoxPreviewFrameRef.current !== null) {
          cancelAnimationFrame(viewingBoxPreviewFrameRef.current);
          viewingBoxPreviewFrameRef.current = null;
        }
        viewingBoxRef.current = interaction.startState;
        const kernel = kernelRef.current;
        if (kernel) {
          kernel.session.setScopedClipVolume(
            `builder:viewing-box:${interaction.startState.id}`,
            viewingBoxClipVolume(interaction.startState),
          );
          drawViewingBoxOverlay(
            viewingBoxOverlayRef.current,
            hostRef.current,
            kernel,
            interaction.startState,
            null,
          );
          kernel.setInteracting(false);
          kernel.requestFrame();
        }
        setViewingBoxCursor('grab');
        return true;
      },
    }),
    [changeViewMode, frameAll, recordCamera],
  );

  const handleReady = useCallback(
    (handle: KernelViewportHandle) => {
      kernelRef.current = handle;
      if (import.meta.env.DEV || import.meta.env.VITE_HCAD_PERF_DEBUG === '1') {
        const performanceHandle = Object.assign(handle, {
          setViewMode: changeViewMode,
          cameraHistory: async (action: 'get' | 'clear'): Promise<unknown> => {
            const history = cameraHistoryRef.current;
            if (!history) throw new Error('Camera history is not ready.');
            if (action === 'clear') history.clear();
            else await history.flushPersistence();
            return history.snapshot;
          },
        });
        Object.assign(window, {
          __hcadBuilderKernel: performanceHandle,
          __hcadDrawSnapLatency: () => drawSnapLatencyRef.current.snapshot(),
        });
      }
      handle.session.setClearColor([0.008, 0.011, 0.016, 1]);
      const overlayAtlas = createKernelOverlayGlyphAtlas(document);
      handle.session.registerGlyphAtlas(
        overlayAtlas.hash,
        overlayAtlas.metadata,
        overlayAtlas.rgba8,
      );
      handle.session.setPointSize(pointSizeRef.current);
      const selected = new Set(
        [...callbacksRef.current.selectedEntityIds].filter(
          (id) => callbacksRef.current.isEntitySelectionHighlightable?.(id) ?? true,
        ),
      );
      for (const id of selected) {
        handle.session.setEntityInteractionState(id, { selected: true, hovered: false });
      }
      highlightedSelectionRef.current = selected;
      void handle.session.setViewMode(viewModeRef.current, 0).catch((error: unknown) => {
        callbacksRef.current.onLog('error', `Initial view mode failed: ${String(error)}`);
      });
      readyRef.current.resolve(handle);
      callbacksRef.current.onLog(
        'info',
        `Shared viewer ready (${handle.hardwarePolicy.deploymentProfile}, ${handle.session.diagnostics().capabilities.backend})`,
      );
    },
    [changeViewMode],
  );

  const handlePick = useCallback((candidate: KernelPickCandidate | null) => {
    const startedAt = performance.now();
    const remapped = remapViewingBoxCandidate(candidate, bakeProxySourcesRef.current);
    const resolved = remapped
      ? augmentDraftingCandidate(
          remapped,
          callbacksRef.current.constructionOrigin,
          entityOverlayGeometryRef.current,
          kernelRef.current,
          hostRef.current,
        )
      : null;
    const snappable = resolved
      ? (callbacksRef.current.isEntitySnappable?.(resolved.address.entityId as EntityId) ?? true)
      : false;
    activeSourcePositionRef.current = snappable ? resolved!.worldPosition : null;
    callbacksRef.current.onCursorSnap(snappable ? snapFromCandidate(resolved!) : null);
    drawSnapLatencyRef.current.record(performance.now() - startedAt);
  }, []);

  const handleCursor = useCallback((coordinate: KernelPickCandidate['worldPosition']) => {
    activeSourcePositionRef.current = coordinate;
    setCursor(coordinate);
  }, []);

  const handleError = useCallback((error: Error) => {
    readyRef.current.reject(error);
    callbacksRef.current.onLog('error', error.message);
  }, []);

  const handleDrop = useCallback((event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setDragging(false);
    const paths = Array.from(event.dataTransfer.files)
      .map((file) => (file as File & { readonly path?: string }).path ?? '')
      .filter((path) => /\.(?:las|laz|e57)$/i.test(path));
    if (paths.length > 0) void callbacksRef.current.onDropFiles(paths);
  }, []);

  const commitViewingBox = useCallback((state: KernelViewingBoxState) => {
    viewingBoxRef.current = state;
    callbacksRef.current.onViewingBoxChange?.(state);
  }, []);

  const applyViewingBoxPreview = useCallback(
    (state: KernelViewingBoxState, previewCap: boolean): void => {
      viewingBoxRef.current = state;
      const kernel = kernelRef.current;
      if (!kernel) return;
      kernel.session.setScopedClipVolume(
        `builder:viewing-box:${state.id}`,
        viewingBoxClipVolume(state, previewCap),
      );
      drawViewingBoxOverlay(
        viewingBoxOverlayRef.current,
        hostRef.current,
        kernel,
        state,
        hoveredViewingBoxHandle,
      );
      kernel.requestFrame();
    },
    [hoveredViewingBoxHandle],
  );

  const previewViewingBox = useCallback(
    (state: KernelViewingBoxState): void => {
      viewingBoxRef.current = state;
      pendingViewingBoxPreviewRef.current = state;
      if (viewingBoxPreviewFrameRef.current !== null) return;
      viewingBoxPreviewFrameRef.current = requestAnimationFrame(() => {
        viewingBoxPreviewFrameRef.current = null;
        const pending = pendingViewingBoxPreviewRef.current;
        pendingViewingBoxPreviewRef.current = null;
        if (pending) applyViewingBoxPreview(pending, false);
      });
    },
    [applyViewingBoxPreview],
  );

  const flushViewingBoxPreview = useCallback(
    (state: KernelViewingBoxState): void => {
      if (viewingBoxPreviewFrameRef.current !== null) {
        cancelAnimationFrame(viewingBoxPreviewFrameRef.current);
        viewingBoxPreviewFrameRef.current = null;
      }
      pendingViewingBoxPreviewRef.current = null;
      applyViewingBoxPreview(state, true);
    },
    [applyViewingBoxPreview],
  );

  useEffect(() => {
    if (!import.meta.env.DEV && import.meta.env.VITE_HCAD_PERF_DEBUG !== '1') return;
    const target = window as unknown as Record<string, unknown>;
    const key = '__hcadBuilderViewingBoxDebug';
    const previous = target[key];
    const debug = {
      async loadPrepared(
        metadataUrl: string,
        bounds: Bounds,
        expectedPoints: number,
        rawSourceContentHash: string,
      ): Promise<void> {
        const kernel = kernelRef.current;
        if (!kernel) throw new Error('viewer is not ready');
        const response = await fetch(metadataUrl);
        if (!response.ok) throw new Error(`metadata fetch failed: ${response.status}`);
        const metadataBytes = new Uint8Array(await response.arrayBuffer());
        const digest = new Uint8Array(
          await crypto.subtle.digest('SHA-256', metadataBytes.slice().buffer),
        );
        const metadataHash = [...digest].map((byte) => byte.toString(16).padStart(2, '0')).join('');
        const geometry: GeometryObject = {
          kind: 'pointCloud',
          dataset: {
            formatId: 'potree@2',
            metadata: {
              objectHash: metadataHash,
              mediaType: 'application/json',
              byteLength: metadataBytes.byteLength,
            },
            elementCount: expectedPoints,
          },
        };
        const selected: Representation = {
          role: 'canonical',
          geometryRef: kernel.session.geometryObjectContentHash(geometry),
          authority: 'authoritative',
          dependencyHash: null,
        };
        const entityWithoutVersion = {
          id: 'viewing-box-benchmark-cloud',
          revision: 1,
          typeId: 'hcad.point-cloud@1',
          name: 'Viewing box benchmark cloud',
          owner: null,
          layerIds: [],
          placement: null,
          representations: [selected],
          componentsRef: 'c1'.repeat(32),
          attributesRef: 'a1'.repeat(32),
          relationsRef: 'e1'.repeat(32),
          styleRef: null,
          schemaVersion: 1,
        };
        const entity: CanonicalEntity = {
          ...entityWithoutVersion,
          versionHash: kernel.session.canonicalEntityVersionHash({
            ...entityWithoutVersion,
            versionHash: '00'.repeat(32),
          }),
        };
        const admission: CanonicalRepresentationAdmission = {
          entity,
          selected,
          representationSlot: 'primary',
          expectedGeneration: null,
          resolvedGeometry: geometry,
        };
        await kernel.session.loadPotree(
          {
            datasetId: 'viewing-box-benchmark-dataset',
            metadataUri: new URL(metadataUrl, location.href).toString(),
            admission,
            preparedMetadata: { schemaVersion: 1, rawSourceContentHash, nodes: {} },
            style: POINT_CLOUD_STYLE,
          },
          { operationId: 'viewing-box-benchmark/load' },
        );
        const entityId = entity.id as EntityId;
        potreeSourcesRef.current.set(entityId, {
          datasetId: 'viewing-box-benchmark-dataset',
          admission,
          bounds,
          metadataUrl: new URL(metadataUrl, location.href).toString(),
        });
        entityBoundsRef.current.set(entityId, bounds);
        entityVisibilityRef.current.set(entityId, true);
        entityStylesRef.current.set(entityId, POINT_CLOUD_STYLE);
        loadedBoundsRef.current = unionBounds(loadedBoundsRef.current, bounds);

        const center = {
          x: (bounds.min[0] + bounds.max[0]) * 0.5,
          y: (bounds.min[1] + bounds.max[1]) * 0.5,
          z: (bounds.min[2] + bounds.max[2]) * 0.5,
        };
        // The parity fixture deliberately crosses the later reduced box so a
        // locked point proxy cannot accidentally disable clipping for CAD.
        const halfLine = Math.max(0.5, (bounds.max[0] - bounds.min[0]) * 0.25);
        const cadGeometry: GeometryObject = {
          kind: 'curve',
          curve: {
            kind: 'lineSegment',
            start: { x: center.x - halfLine, y: center.y, z: center.z },
            end: { x: center.x + halfLine, y: center.y, z: center.z },
          },
        };
        const cadSelected: Representation = {
          role: 'canonical',
          geometryRef: kernel.session.geometryObjectContentHash(cadGeometry),
          authority: 'authoritative',
          dependencyHash: null,
        };
        const cadEntityWithoutVersion = {
          id: 'viewing-box-benchmark-cad',
          revision: 1,
          typeId: 'hcad.curve@1',
          name: 'Viewing box benchmark CAD',
          owner: null,
          layerIds: [],
          placement: null,
          representations: [cadSelected],
          componentsRef: 'c2'.repeat(32),
          attributesRef: 'a2'.repeat(32),
          relationsRef: 'e2'.repeat(32),
          styleRef: null,
          schemaVersion: 1,
        };
        const cadEntity: CanonicalEntity = {
          ...cadEntityWithoutVersion,
          versionHash: kernel.session.canonicalEntityVersionHash({
            ...cadEntityWithoutVersion,
            versionHash: '00'.repeat(32),
          }),
        };
        kernel.session.loadCanonical([
          {
            admission: {
              entity: cadEntity,
              selected: cadSelected,
              representationSlot: 'primary',
              expectedGeneration: null,
              resolvedGeometry: cadGeometry,
            },
            style: IFC_STYLE,
          },
        ]);
        const cadEntityId = cadEntity.id as EntityId;
        entityBoundsRef.current.set(cadEntityId, bounds);
        entityVisibilityRef.current.set(cadEntityId, true);
        entityStylesRef.current.set(cadEntityId, IFC_STYLE);
        frameAll();
      },
      placeAtCameraTarget(): void {
        const camera = kernelRef.current?.camera.worldCamera();
        if (!camera) return;
        callbacksRef.current.onViewingBoxChange?.(
          createViewingBoxSeed(camera, camera.target, `viewing-box-${crypto.randomUUID()}`),
        );
      },
      setClipActive(active: boolean): void {
        const state = viewingBoxRef.current;
        const kernel = kernelRef.current;
        if (!state || !kernel) return;
        kernel.session.setScopedClipVolume(
          `builder:viewing-box:${state.id}`,
          active ? viewingBoxClipVolume(state) : null,
        );
        kernel.requestFrame();
      },
      scaleForBake(factor: number): void {
        const state = viewingBoxRef.current;
        if (!state || !Number.isFinite(factor) || factor <= 0 || factor > 1) {
          throw new RangeError('Viewing-box bake scale must be within (0, 1].');
        }
        const next: KernelViewingBoxState = {
          ...state,
          halfExtents: {
            x: state.halfExtents.x * factor,
            y: state.halfExtents.y * factor,
            z: state.halfExtents.z * factor,
          },
        };
        flushViewingBoxPreview(next);
        commitViewingBox(next);
      },
      remove(): void {
        viewingBoxRef.current = null;
        const scope = viewingBoxScopeRef.current;
        if (scope)
          kernelRef.current?.session.setScopedClipVolume(`builder:viewing-box:${scope}`, null);
        kernelRef.current?.requestFrame();
        callbacksRef.current.onViewingBoxChange?.(null);
      },
      handles(): unknown {
        const host = hostRef.current;
        const kernel = kernelRef.current;
        const state = viewingBoxRef.current;
        if (!host || !kernel || !state) return null;
        const geometry = viewingBoxOverlayGeometry(host, kernel, state);
        const rect = host.getBoundingClientRect();
        return geometry
          ? {
              host: { left: rect.left, top: rect.top },
              state,
              faces: geometry.faces,
              corners: geometry.cornerHandles,
              rings: geometry.rings,
            }
          : null;
      },
    };
    target[key] = debug;
    return () => {
      if (target[key] !== debug) return;
      if (previous === undefined) delete target[key];
      else target[key] = previous;
    };
  }, [commitViewingBox, flushViewingBoxPreview, frameAll]);

  const handleViewingBoxPointerDown = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      if (placingViewingBoxCenter && event.button === 0) {
        const host = hostRef.current;
        const kernel = kernelRef.current;
        if (!host || !kernel) return;
        const active = activeSourcePositionRef.current;
        const start =
          active && active.z !== null
            ? { x: active.x, y: active.y, z: active.z }
            : viewingBoxWorldPointOnTargetPlane(
                eventPoint(event, host),
                host,
                kernel.camera.worldCamera(),
              );
        if (!start) return;
        const seed = createViewingBoxSeed(kernel.camera.worldCamera(), start);
        event.preventDefault();
        event.stopPropagation();
        event.currentTarget.setPointerCapture(event.pointerId);
        kernel.setInteracting(true);
        viewingBoxPlacementRef.current = {
          pointerId: event.pointerId,
          startClientX: event.clientX,
          startClientY: event.clientY,
          start,
          seed,
          preview: seed,
          moved: false,
        };
        drawViewingBoxOverlay(viewingBoxOverlayRef.current, host, kernel, seed);
        kernel.requestFrame();
        return;
      }
      if (!viewingBoxEditing || event.button !== 0) return;
      const state = viewingBoxRef.current;
      const host = hostRef.current;
      const kernel = kernelRef.current;
      if (!state || !host || !kernel) return;
      const point = eventPoint(event, host);
      const handle = hitTestViewingBoxHandle(viewingBoxOverlayGeometry(host, kernel, state), point);
      if (!handle) return;
      event.preventDefault();
      event.stopPropagation();
      event.currentTarget.setPointerCapture(event.pointerId);
      kernel.setInteracting(true);
      viewingBoxInteractionRef.current =
        handle.kind === 'face'
          ? {
              kind: 'face',
              pointerId: event.pointerId,
              startClientX: event.clientX,
              startClientY: event.clientY,
              startState: state,
              handle,
              pointerMoved: false,
              moved: false,
            }
          : handle.kind === 'corner'
            ? {
                kind: 'corner',
                pointerId: event.pointerId,
                startClientX: event.clientX,
                startClientY: event.clientY,
                startState: state,
                handle,
                pointerMoved: false,
                moved: false,
              }
            : {
                kind: 'ring',
                pointerId: event.pointerId,
                startClientX: event.clientX,
                startClientY: event.clientY,
                startState: state,
                handle,
                startAngle: Math.atan2(point.y - handle.center.y, point.x - handle.center.x),
                pointerMoved: false,
                moved: false,
              };
      setViewingBoxCursor('grabbing');
    },
    [placingViewingBoxCenter, viewingBoxEditing],
  );

  const handleViewingBoxPointerMove = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      const placement = viewingBoxPlacementRef.current;
      if (placement) {
        if (placement.pointerId !== event.pointerId) return;
        event.preventDefault();
        event.stopPropagation();
        const host = hostRef.current;
        const kernel = kernelRef.current;
        if (!host || !kernel) return;
        if (
          Math.hypot(
            event.clientX - placement.startClientX,
            event.clientY - placement.startClientY,
          ) >= 4
        ) {
          placement.moved = true;
        }
        const end = viewingBoxWorldPointOnTargetPlane(
          eventPoint(event, host),
          host,
          kernel.camera.worldCamera(),
        );
        if (!end) return;
        placement.preview = viewingBoxFromViewportDrag(placement.seed, placement.start, end);
        drawViewingBoxOverlay(viewingBoxOverlayRef.current, host, kernel, placement.preview);
        kernel.requestFrame();
        return;
      }
      const interaction = viewingBoxInteractionRef.current;
      if (!interaction) {
        if (placingViewingBoxCenter || !viewingBoxEditing) return;
        const state = viewingBoxRef.current;
        const host = hostRef.current;
        const kernel = kernelRef.current;
        const geometry =
          state && host && kernel ? viewingBoxOverlayGeometry(host, kernel, state) : null;
        const nextHandle = geometry
          ? hitTestViewingBoxHandle(geometry, eventPoint(event, host!))
          : null;
        const nextHover =
          state && host && kernel
            ? (nextHandle ?? hitTestViewingBoxFace(geometry, eventPoint(event, host)))
            : null;
        setHoveredViewingBoxHandle(nextHover);
        const nextCursor = nextHandle ? 'grab' : 'default';
        setViewingBoxCursor((current) => (current === nextCursor ? current : nextCursor));
        return;
      }
      if (interaction.pointerId !== event.pointerId) return;
      event.preventDefault();
      event.stopPropagation();
      const deltaX = event.clientX - interaction.startClientX;
      const deltaY = event.clientY - interaction.startClientY;
      const distance = Math.hypot(deltaX, deltaY);
      if (distance >= 0.5) interaction.pointerMoved = true;
      if (distance >= 4) interaction.moved = true;
      if (interaction.kind === 'face') {
        const host = hostRef.current;
        const kernel = kernelRef.current;
        if (!host || !kernel) return;
        const signedDelta = solveViewingBoxFaceCursorDelta(
          interaction.startState,
          interaction.handle,
          { x: interaction.handle.point.x + deltaX, y: interaction.handle.point.y + deltaY },
          host.getBoundingClientRect(),
          kernel.camera.worldCamera(),
        );
        previewViewingBox(
          resizeViewingBoxFace(
            interaction.startState,
            interaction.handle.axis,
            interaction.handle.face,
            signedDelta,
            true,
          ),
        );
        return;
      }
      if (interaction.kind === 'corner') {
        const host = hostRef.current;
        const kernel = kernelRef.current;
        if (!host || !kernel) return;
        const signedDeltas = solveViewingBoxCornerCursorDeltas(
          interaction.startState,
          interaction.handle,
          { x: interaction.handle.point.x + deltaX, y: interaction.handle.point.y + deltaY },
          host.getBoundingClientRect(),
          kernel.camera.worldCamera(),
        );
        previewViewingBox(
          resizeViewingBoxCorner(interaction.startState, interaction.handle.faces, signedDeltas),
        );
        return;
      }
      const host = hostRef.current;
      if (!host) return;
      const point = eventPoint(event, host);
      const angle = Math.atan2(
        point.y - interaction.handle.center.y,
        point.x - interaction.handle.center.x,
      );
      previewViewingBox(
        rotateViewingBox(
          interaction.startState,
          interaction.handle.axis,
          normalizeAngle(angle - interaction.startAngle),
        ),
      );
    },
    [placingViewingBoxCenter, previewViewingBox, viewingBoxEditing],
  );

  const finishViewingBoxInteraction = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      const placement = viewingBoxPlacementRef.current;
      if (placement && placement.pointerId === event.pointerId) {
        event.preventDefault();
        event.stopPropagation();
        if (event.currentTarget.hasPointerCapture(event.pointerId)) {
          event.currentTarget.releasePointerCapture(event.pointerId);
        }
        viewingBoxPlacementRef.current = null;
        kernelRef.current?.setInteracting(false);
        if (event.type === 'pointercancel') {
          drawViewingBoxOverlay(
            viewingBoxOverlayRef.current,
            hostRef.current,
            kernelRef.current,
            viewingBoxRef.current,
          );
          kernelRef.current?.requestFrame();
        } else if (placement.moved) {
          callbacksRef.current.onViewportBox?.(placement.preview);
        } else {
          callbacksRef.current.onViewportPoint?.(placement.start);
        }
        return;
      }
      const interaction = viewingBoxInteractionRef.current;
      if (!interaction || interaction.pointerId !== event.pointerId) return;
      event.preventDefault();
      event.stopPropagation();
      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId);
      }
      viewingBoxInteractionRef.current = null;
      kernelRef.current?.setInteracting(false);
      if (event.type === 'pointercancel') {
        pendingViewingBoxPreviewRef.current = null;
        flushViewingBoxPreview(interaction.startState);
      } else if (!interaction.moved && interaction.pointerMoved) {
        // A sub-threshold drag is not a click and owns no journal transaction.
        flushViewingBoxPreview(interaction.startState);
      } else if (!interaction.moved) {
        commitViewingBox(
          setViewingBoxMode(
            viewingBoxRef.current ?? interaction.startState,
            interaction.kind === 'ring' ? 'resize' : 'rotate',
          ),
        );
      } else {
        const finalState = viewingBoxRef.current ?? interaction.startState;
        flushViewingBoxPreview(finalState);
        commitViewingBox(finalState);
      }
      setViewingBoxCursor('grab');
    },
    [commitViewingBox, flushViewingBoxPreview],
  );

  useEffect(
    () =>
      registerEscapeRung('drag', () => {
        const placement = viewingBoxPlacementRef.current;
        if (placement) {
          viewingBoxPlacementRef.current = null;
          drawViewingBoxOverlay(
            viewingBoxOverlayRef.current,
            hostRef.current,
            kernelRef.current,
            viewingBoxRef.current,
          );
          kernelRef.current?.setInteracting(false);
          kernelRef.current?.requestFrame();
          return true;
        }
        const interaction = viewingBoxInteractionRef.current;
        if (!interaction) return false;
        viewingBoxInteractionRef.current = null;
        pendingViewingBoxPreviewRef.current = null;
        flushViewingBoxPreview(interaction.startState);
        kernelRef.current?.setInteracting(false);
        setViewingBoxCursor('grab');
        return true;
      }),
    [flushViewingBoxPreview],
  );

  return (
    <div
      ref={hostRef}
      className={placingViewingBoxCenter ? `${styles.root} ${styles.placingCenter}` : styles.root}
      style={placingViewingBoxCenter ? undefined : { cursor: viewingBoxCursor }}
      onPointerDownCapture={handleViewingBoxPointerDown}
      onPointerMoveCapture={(event) => {
        pointerPositionRef.current = { x: event.clientX, y: event.clientY };
        if (fence && hostRef.current && kernelRef.current) {
          const rect = hostRef.current.getBoundingClientRect();
          fencePointerRef.current = kernelRef.current.camera.worldPointOnTargetPlane(
            ((event.clientX - rect.left) / rect.width) * 2 - 1,
            1 - ((event.clientY - rect.top) / rect.height) * 2,
          );
          drawViewingBoxOverlay(
            viewingBoxOverlayRef.current,
            hostRef.current,
            kernelRef.current,
            viewingBoxRef.current,
            hoveredViewingBoxHandle,
            viewingBoxEditing,
          );
          drawFenceOverlay(
            viewingBoxOverlayRef.current,
            hostRef.current,
            kernelRef.current,
            fence,
            fencePointerRef.current,
            true,
          );
        }
        handleViewingBoxPointerMove(event);
      }}
      onPointerUpCapture={finishViewingBoxInteraction}
      onPointerCancelCapture={finishViewingBoxInteraction}
      onDragEnter={(event) => {
        event.preventDefault();
        setDragging(true);
      }}
      onDragOver={(event) => event.preventDefault()}
      onDragLeave={(event) => {
        if (event.currentTarget === event.target) setDragging(false);
      }}
      onDrop={handleDrop}
    >
      <KernelViewport
        wasmLoader={wasmLoader}
        backend="automatic"
        presentationMode="windowMask"
        decodeWasmModuleUrl={decodeWasmUrl}
        authoritativeSectionTolerance={0.001}
        onReady={handleReady}
        onCameraGestureEnd={(cancelled) => {
          if (cancelled) {
            const previous = cameraHistoryRef.current?.current;
            if (previous) kernelRef.current?.session.adoptWorldCamera(previous.camera);
          } else recordCamera();
        }}
        onActivePick={handlePick}
        onCursorCoordinate={handleCursor}
        registerEscapeRung={registerEscapeRung}
        gestures={{
          isPickable: (candidate) => {
            const resolved = remapViewingBoxCandidate(candidate, bakeProxySourcesRef.current);
            return (
              callbacksRef.current.isEntityClickPickable?.(resolved.address.entityId as EntityId) ??
              true
            );
          },
          isSelected: (candidate) => {
            const resolved = remapViewingBoxCandidate(candidate, bakeProxySourcesRef.current);
            return callbacksRef.current.selectedEntityIds.has(
              resolved.address.entityId as EntityId,
            );
          },
          hasSelection: () => callbacksRef.current.selectedEntityIds.size > 0,
          select: (candidate) => {
            const resolved = remapViewingBoxCandidate(candidate, bakeProxySourcesRef.current);
            callbacksRef.current.onSelectEntity?.(resolved.address.entityId as EntityId, 'replace');
          },
          toggleSelection: (candidate) => {
            const resolved = remapViewingBoxCandidate(candidate, bakeProxySourcesRef.current);
            callbacksRef.current.onSelectEntity?.(resolved.address.entityId as EntityId, 'toggle');
          },
          clearSelection: () => callbacksRef.current.onClearSelection?.(),
          claimBlocked: (message) => callbacksRef.current.onLog('info', message),
          candidateSetChanged: (candidates, index) =>
            callbacksRef.current.onCandidateSet?.(
              candidates.map((candidate) =>
                remapViewingBoxCandidate(candidate, bakeProxySourcesRef.current),
              ),
              index,
            ),
          candidateSetCleared: () => callbacksRef.current.onCandidateSetClear?.(),
          openContextSurface: (candidate) =>
            callbacksRef.current.onContextSurface?.(
              candidate
                ? remapViewingBoxCandidate(candidate, bakeProxySourcesRef.current)
                : candidate,
              pointerPositionRef.current,
            ),
          routeRegistryShortcut: (event) => callbacksRef.current.onRegistryShortcut?.(event),
        }}
        onFrame={() => {
          updateSelectionRendererOverlay(
            kernelRef.current,
            hostRef.current,
            callbacksRef.current.selectedEntityIds,
            entityOverlayGeometryRef.current,
            selectionOverlayKeyRef,
          );
          drawViewingBoxOverlay(
            viewingBoxOverlayRef.current,
            hostRef.current,
            kernelRef.current,
            viewingBoxRef.current,
            hoveredViewingBoxHandle,
            viewingBoxEditing,
          );
          if (fence)
            drawFenceOverlay(
              viewingBoxOverlayRef.current,
              hostRef.current,
              kernelRef.current,
              fence,
              fencePointerRef.current,
              true,
            );
        }}
        onError={handleError}
      />
      {hudVisible && <BuilderHud kernelRef={kernelRef} />}
      <canvas ref={viewingBoxOverlayRef} className={styles.viewingBoxOverlay} aria-hidden />
      <output className={styles.coordinates} aria-label="Cursor coordinates">
        {cursor ? (
          <>
            <span>X</span> {formatCoordinate(cursor.x)} <span>Y</span> {formatCoordinate(cursor.y)}{' '}
            <span>Z</span> {cursor.z === null ? '—' : formatCoordinate(cursor.z)}
          </>
        ) : (
          'X —   Y —   Z —'
        )}
      </output>
      <div className={styles.viewModes} aria-label="View mode">
        {(['3d', '2.5d', '2d'] as const).map((mode) => (
          <OverlayChip
            key={mode}
            as="button"
            active={mode === viewMode}
            aria-pressed={mode === viewMode}
            onClick={() => changeViewMode(mode)}
          >
            {mode.toUpperCase()}
          </OverlayChip>
        ))}
      </div>
      {viewingBox && !viewingBoxPanelOpen ? (
        <OverlayChip
          as="button"
          className={styles.viewingBoxStatus}
          title={`${viewingBoxName} · ${(viewingBox.operation ?? 'keepInside') === 'keepInside' ? 'Keep inside' : 'Remove inside'}${(viewingBox.lockMode ?? 'unlocked') === 'unlocked' ? '' : ' · Locked'}`}
          aria-label={`Open viewing box ${viewingBoxName}${(viewingBox.lockMode ?? 'unlocked') === 'unlocked' ? '' : ', locked'}`}
          onClick={onOpenViewingBox}
        >
          <span aria-hidden>{(viewingBox.lockMode ?? 'unlocked') === 'unlocked' ? '□' : '🔒'}</span>
          <span className={styles.viewingBoxStatusName}>{viewingBoxName}</span>
        </OverlayChip>
      ) : null}
      {dragging ? <div className={styles.dropOverlay}>Drop LAS / LAZ / E57 to import</div> : null}
    </div>
  );
});

interface Bounds {
  readonly min: readonly [number, number, number];
  readonly max: readonly [number, number, number];
}

function drawViewingBoxOverlay(
  canvas: HTMLCanvasElement | null,
  host: HTMLDivElement | null,
  kernel: KernelViewportHandle | null,
  state: KernelViewingBoxState | null,
  hovered: ViewingBoxHandle | null = null,
  showHandles = true,
): void {
  if (!canvas || !host) return;
  const rect = host.getBoundingClientRect();
  const ratio = Math.max(1, globalThis.devicePixelRatio || 1);
  const width = Math.max(1, Math.round(rect.width * ratio));
  const height = Math.max(1, Math.round(rect.height * ratio));
  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width;
    canvas.height = height;
  }
  const context = canvas.getContext('2d');
  if (!context) return;
  context.setTransform(ratio, 0, 0, ratio, 0, 0);
  context.clearRect(0, 0, rect.width, rect.height);
  if (!kernel || !state) return;
  const geometry = viewingBoxOverlayGeometry(host, kernel, state);
  if (!geometry) return;
  const edges = [
    [0, 1],
    [0, 2],
    [0, 4],
    [1, 3],
    [1, 5],
    [2, 3],
    [2, 6],
    [3, 7],
    [4, 5],
    [4, 6],
    [5, 7],
    [6, 7],
  ] as const;
  const computed = getComputedStyle(host);
  const accent = computed.getPropertyValue('--hc-accent-base').trim() || computed.color;
  const support = computed.getPropertyValue('--hc-geometry-support').trim() || accent;
  const active = computed.getPropertyValue('--hc-warning').trim() || '#e8a33e';
  const foreground = computed.getPropertyValue('--hc-fg-strong').trim() || computed.color;
  context.save();
  context.lineWidth = 1.25;
  context.globalAlpha = state.enabled ? 0.92 : 0.58;
  context.strokeStyle = state.enabled ? accent : foreground;
  context.setLineDash(state.operation === 'removeInside' ? [6, 4] : state.enabled ? [] : [2, 4]);
  context.beginPath();
  for (const [fromIndex, toIndex] of edges) {
    const from = geometry.corners[fromIndex];
    const to = geometry.corners[toIndex];
    if (!from || !to) continue;
    context.moveTo(from.x, from.y);
    context.lineTo(to.x, to.y);
  }
  context.stroke();
  context.setLineDash([]);
  context.globalAlpha = 1;
  context.strokeStyle = support;
  context.fillStyle = support;
  const editable = showHandles && (state.lockMode ?? 'unlocked') === 'unlocked';
  const hoveredFace = editable && hovered?.kind === 'face' ? hovered : null;
  if (hoveredFace) {
    context.save();
    context.globalAlpha = 0.06;
    context.fillStyle = accent;
    drawPolygon(context, hoveredFace.polygon);
    context.restore();
  }
  if (editable && state.mode === 'rotate') {
    for (const [index, ring] of geometry.rings.entries()) {
      context.lineWidth = index === 0 ? 2.25 : 1.8;
      context.setLineDash(index === 0 ? [] : index === 1 ? [7, 3] : [2, 3]);
      drawPolyline(context, ring.points, true);
    }
    context.setLineDash([]);
  } else if (editable) {
    for (const handle of geometry.faces) {
      drawSquareGrip(
        context,
        handle.point,
        sameViewingBoxHandle(handle, hovered) ? active : support,
      );
    }
    for (const handle of geometry.cornerHandles) {
      drawSquareGrip(
        context,
        handle.point,
        sameViewingBoxHandle(handle, hovered) ? active : support,
      );
    }
  }
  context.restore();
}

function drawFenceOverlay(
  canvas: HTMLCanvasElement | null,
  host: HTMLDivElement | null,
  kernel: KernelViewportHandle | null,
  fence: BuilderFenceOverlayState,
  pointer: KernelWorldPoint | null,
  preserve = false,
): void {
  if (!canvas || !host || !kernel) return;
  const rect = host.getBoundingClientRect();
  const ratio = Math.max(1, globalThis.devicePixelRatio || 1);
  const context = canvas.getContext('2d');
  if (!context) return;
  context.setTransform(ratio, 0, 0, ratio, 0, 0);
  if (!preserve) context.clearRect(0, 0, rect.width, rect.height);
  const points = fence.vertices.flatMap((vertex) => {
    const projected = projectViewingBoxPoint(vertex, kernel.camera.worldCamera(), rect);
    return projected ? [projected] : [];
  });
  const projectedPointer = pointer
    ? projectViewingBoxPoint(pointer, kernel.camera.worldCamera(), rect)
    : null;
  if (points.length === 0) return;
  const computed = getComputedStyle(host);
  const accent = computed.getPropertyValue('--hc-accent-base').trim() || '#5aa7ff';
  const support = computed.getPropertyValue('--hc-geometry-support').trim() || accent;
  context.save();
  context.strokeStyle = accent;
  context.fillStyle = accent;
  context.lineWidth = 1.5;
  context.setLineDash(fence.closed ? [] : [6, 4]);
  context.beginPath();
  context.moveTo(points[0]!.x, points[0]!.y);
  for (const point of points.slice(1)) context.lineTo(point.x, point.y);
  if (fence.closed) context.closePath();
  else if (projectedPointer && fence.kind === 'polygon') {
    context.lineTo(projectedPointer.x, projectedPointer.y);
  }
  if (fence.closed) {
    context.save();
    context.globalAlpha = 0.08;
    context.fill();
    context.restore();
  }
  context.stroke();
  context.setLineDash([]);
  for (const [index, point] of points.entries()) {
    const closingHover =
      index === 0 &&
      !fence.closed &&
      fence.vertices.length >= 3 &&
      projectedPointer &&
      Math.hypot(point.x - projectedPointer.x, point.y - projectedPointer.y) <= 9;
    context.fillStyle = closingHover ? accent : support;
    context.fillRect(point.x - 3, point.y - 3, 6, 6);
    if (closingHover) {
      context.lineWidth = 2.5;
      context.strokeStyle = accent;
      context.strokeRect(point.x - 5, point.y - 5, 10, 10);
    }
  }
  context.restore();
}

function rectangleOnCameraPlane(
  start: KernelWorldPoint,
  end: KernelWorldPoint,
  camera: KernelWorldCamera,
): readonly KernelWorldPoint[] {
  const forward = normalizeVector({
    x: camera.target.x - camera.eye.x,
    y: camera.target.y - camera.eye.y,
    z: camera.target.z - camera.eye.z,
  });
  const right = normalizeVector(crossVector(forward, camera.up));
  const up = crossVector(right, forward);
  const delta = { x: end.x - start.x, y: end.y - start.y, z: end.z - start.z };
  const width = dotVector(delta, right);
  const height = dotVector(delta, up);
  const alongWidth = addScaledPoint(start, right, width);
  const alongHeight = addScaledPoint(start, up, height);
  return [start, alongWidth, addScaledPoint(alongWidth, up, height), alongHeight];
}

interface ViewingBoxOverlayGeometry {
  readonly corners: readonly (ScreenPoint | null)[];
  readonly center: ScreenPoint;
  readonly faces: readonly ViewingBoxFaceHandle[];
  readonly cornerHandles: readonly ViewingBoxCornerHandle[];
  readonly rings: readonly ViewingBoxRingHandle[];
}

function viewingBoxOverlayGeometry(
  host: HTMLDivElement,
  kernel: KernelViewportHandle,
  state: KernelViewingBoxState,
): ViewingBoxOverlayGeometry | null {
  const rect = host.getBoundingClientRect();
  const camera = kernel.camera.worldCamera();
  const axes = viewingBoxAxes(state);
  const extents = [state.halfExtents.x, state.halfExtents.y, state.halfExtents.z] as const;
  const corners = [-1, 1].flatMap((x) =>
    [-1, 1].flatMap((y) =>
      [-1, 1].map((z) =>
        projectViewingBoxPoint(
          localViewingBoxPoint(state.center, axes, extents, [x, y, z]),
          camera,
          rect,
        ),
      ),
    ),
  );
  const center = projectViewingBoxPoint(state.center, camera, rect);
  if (!center) return null;
  const axisNames = ['x', 'y', 'z'] as const;
  const faces: ViewingBoxFaceHandle[] = [];
  if (state.mode !== 'rotate') {
    for (let axisIndex = 0; axisIndex < axes.length; axisIndex += 1) {
      const axis = axes[axisIndex]!;
      const extent = extents[axisIndex]!;
      const axisName = axisNames[axisIndex]!;
      for (const face of [-1, 1] as const) {
        const worldPoint = addScaledPoint(state.center, axis, face * extent);
        const point = projectViewingBoxPoint(worldPoint, camera, rect);
        const positiveAxisPoint = projectViewingBoxPoint(
          addScaledPoint(worldPoint, axis, 1),
          camera,
          rect,
        );
        if (!point || !positiveAxisPoint) continue;
        const screenX = positiveAxisPoint.x - point.x;
        const screenY = positiveAxisPoint.y - point.y;
        const pixelsPerWorldUnit = Math.hypot(screenX, screenY);
        if (pixelsPerWorldUnit < 1e-5) continue;
        const polygon = viewingBoxFacePolygon(corners, axisIndex, face);
        if (!polygon) continue;
        faces.push({
          kind: 'face',
          axis: axisName,
          face,
          point,
          screenAxis: {
            x: screenX / pixelsPerWorldUnit,
            y: screenY / pixelsPerWorldUnit,
          },
          pixelsPerWorldUnit,
          polygon,
        });
      }
    }
  }
  const cornerHandles: ViewingBoxCornerHandle[] = [];
  if (state.mode !== 'rotate') {
    let cornerIndex = 0;
    for (const x of [-1, 1] as const) {
      for (const y of [-1, 1] as const) {
        for (const z of [-1, 1] as const) {
          const point = corners[cornerIndex++];
          if (!point) continue;
          const projected = axes.map((axis) =>
            projectViewingBoxPoint(
              addScaledPoint(localViewingBoxPoint(state.center, axes, extents, [x, y, z]), axis, 1),
              camera,
              rect,
            ),
          );
          if (projected.some((value) => value === null)) continue;
          const screenAxes = projected.map((value) => ({
            x: value!.x - point.x,
            y: value!.y - point.y,
          })) as [ScreenPoint, ScreenPoint, ScreenPoint];
          const pixels = screenAxes.map((value) => Math.hypot(value.x, value.y)) as [
            number,
            number,
            number,
          ];
          if (pixels.some((value) => value < 1e-5)) continue;
          cornerHandles.push({
            kind: 'corner',
            faces: [x, y, z],
            point,
            screenAxes: screenAxes.map((value, index) => ({
              x: value.x / pixels[index]!,
              y: value.y / pixels[index]!,
            })) as [ScreenPoint, ScreenPoint, ScreenPoint],
            pixelsPerWorldUnit: pixels,
          });
        }
      }
    }
  }
  const rings: ViewingBoxRingHandle[] = [];
  if (state.mode === 'rotate') {
    for (let axisIndex = 0; axisIndex < axes.length; axisIndex += 1) {
      const firstPlaneIndex = (axisIndex + 1) % 3;
      const secondPlaneIndex = (axisIndex + 2) % 3;
      const radius = Math.max(extents[firstPlaneIndex]!, extents[secondPlaneIndex]!) * 1.28;
      const points: ScreenPoint[] = [];
      for (let sample = 0; sample <= 72; sample += 1) {
        const angle = (sample / 72) * Math.PI * 2;
        const worldPoint = addScaledPoint(
          addScaledPoint(state.center, axes[firstPlaneIndex]!, Math.cos(angle) * radius),
          axes[secondPlaneIndex]!,
          Math.sin(angle) * radius,
        );
        const point = projectViewingBoxPoint(worldPoint, camera, rect);
        if (point) points.push(point);
      }
      if (points.length > 2) {
        rings.push({ kind: 'ring', axis: axisNames[axisIndex]!, center, points });
      }
    }
  }
  return { corners, center, faces, cornerHandles, rings };
}

function projectViewingBoxPoint(
  point: KernelWorldPoint,
  camera: KernelWorldCamera,
  hostRect: DOMRect,
): { readonly x: number; readonly y: number } | null {
  const forward = normalizeVector({
    x: camera.target.x - camera.eye.x,
    y: camera.target.y - camera.eye.y,
    z: camera.target.z - camera.eye.z,
  });
  const right = normalizeVector(crossVector(forward, camera.up));
  const up = crossVector(right, forward);
  const relative = {
    x: point.x - camera.eye.x,
    y: point.y - camera.eye.y,
    z: point.z - camera.eye.z,
  };
  const cameraX = dotVector(relative, right);
  const cameraY = dotVector(relative, up);
  const depth = dotVector(relative, forward);
  let ndcX: number;
  let ndcY: number;
  if (camera.projection.kind === 'perspective') {
    if (depth <= camera.projection.near) return null;
    const halfHeight = depth * Math.tan(camera.projection.verticalFovRadians * 0.5);
    ndcX = cameraX / (halfHeight * camera.projection.aspect);
    ndcY = cameraY / halfHeight;
  } else {
    ndcX = cameraX / (camera.projection.verticalSpan * 0.5 * camera.projection.aspect);
    ndcY = cameraY / (camera.projection.verticalSpan * 0.5);
  }
  if (!Number.isFinite(ndcX) || !Number.isFinite(ndcY)) return null;
  return {
    x: ((ndcX + 1) * hostRect.width) / 2,
    y: ((1 - ndcY) * hostRect.height) / 2,
  };
}

function updateSelectionRendererOverlay(
  kernel: KernelViewportHandle | null,
  host: HTMLDivElement | null,
  selectedEntityIds: ReadonlySet<EntityId>,
  geometryByEntity: ReadonlyMap<
    EntityId,
    Pick<CanonicalRepresentationAdmission, 'entity' | 'resolvedGeometry'>
  >,
  previousKey: { current: string },
): void {
  if (!kernel || !host) return;
  const camera = kernel.camera.worldCamera();
  const rect = host.getBoundingClientRect();
  const selected = [...selectedEntityIds].sort();
  const key = JSON.stringify([
    camera,
    rect.width,
    rect.height,
    selected.map((id) => [id, geometryByEntity.get(id)?.entity.versionHash ?? null]),
  ]);
  if (key === previousKey.current) return;
  previousKey.current = key;
  if (selected.length === 0) {
    kernel.session.setRendererOverlayPayload(
      'selection',
      'hcad.renderer-overlay-mono@1',
      EMPTY_RENDERER_OVERLAY,
    );
    return;
  }
  const token = getComputedStyle(host).getPropertyValue('--hc-geometry-selection').trim();
  const color = cssColorToLinearRgba(token || '#ff9f1c');
  const quads: KernelRendererOverlayPayload['quads'][number][] = [];
  for (const entityId of selected) {
    const admission = geometryByEntity.get(entityId);
    if (!admission) continue;
    const points = selectionGeometryPoints(admission);
    if (admission.resolvedGeometry.kind === 'point') {
      const point = points[0];
      if (point) quads.push(overlayAnchorSquare(`selection:${entityId}`, point, color, 6));
      continue;
    }
    if (admission.resolvedGeometry.kind !== 'curve' || points.length < 2) continue;
    const previous = points.at(-2)!;
    const end = points.at(-1)!;
    const previousScreen = projectViewingBoxPoint(previous, camera, rect);
    const endScreen = projectViewingBoxPoint(end, camera, rect);
    if (!previousScreen || !endScreen) continue;
    quads.push(
      ...overlayDirectionArrow(
        `selection:${entityId}:direction`,
        end,
        [previousScreen.x, previousScreen.y],
        [endScreen.x, endScreen.y],
        color,
        8,
      ),
    );
  }
  kernel.session.setRendererOverlayPayload('selection', 'hcad.renderer-overlay-mono@1', {
    lines: [],
    quads,
    labels: [],
  });
}

function selectionGeometryPoints(
  admission: Pick<CanonicalRepresentationAdmission, 'entity' | 'resolvedGeometry'>,
): KernelWorldPoint[] {
  const geometry = admission.resolvedGeometry;
  const positions =
    geometry.kind === 'point'
      ? [geometry.position]
      : geometry.kind === 'curve' && geometry.curve.kind === 'lineSegment'
        ? [geometry.curve.start, geometry.curve.end]
        : geometry.kind === 'curve' && geometry.curve.kind === 'polyline'
          ? geometry.curve.positions
          : [];
  return positions.flatMap((position) => {
    if (position.z === null) return [];
    const point = { x: position.x, y: position.y, z: position.z };
    const matrix = admission.entity.placement;
    if (!matrix) return [point];
    return [
      {
        x: matrix[0] * point.x + matrix[4] * point.y + matrix[8] * point.z + matrix[12],
        y: matrix[1] * point.x + matrix[5] * point.y + matrix[9] * point.z + matrix[13],
        z: matrix[2] * point.x + matrix[6] * point.y + matrix[10] * point.z + matrix[14],
      },
    ];
  });
}

function viewingBoxWorldPointOnTargetPlane(
  point: ScreenPoint,
  host: HTMLDivElement,
  camera: KernelWorldCamera,
): KernelWorldPoint | null {
  const rect = host.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) return null;
  const ndcX = (point.x / rect.width) * 2 - 1;
  const ndcY = 1 - (point.y / rect.height) * 2;
  const forward = normalizeVector({
    x: camera.target.x - camera.eye.x,
    y: camera.target.y - camera.eye.y,
    z: camera.target.z - camera.eye.z,
  });
  const right = normalizeVector(crossVector(forward, camera.up));
  const up = crossVector(right, forward);
  const targetDistance = dotVector(
    {
      x: camera.target.x - camera.eye.x,
      y: camera.target.y - camera.eye.y,
      z: camera.target.z - camera.eye.z,
    },
    forward,
  );
  if (camera.projection.kind === 'orthographic') {
    return addScaledPoint(
      addScaledPoint(
        addScaledPoint(camera.eye, forward, targetDistance),
        right,
        ndcX * camera.projection.verticalSpan * 0.5 * camera.projection.aspect,
      ),
      up,
      ndcY * camera.projection.verticalSpan * 0.5,
    );
  }
  const halfHeight = Math.tan(camera.projection.verticalFovRadians * 0.5);
  const direction = normalizeVector(
    addScaledPoint(
      addScaledPoint(forward, right, ndcX * halfHeight * camera.projection.aspect),
      up,
      ndcY * halfHeight,
    ),
  );
  const denominator = dotVector(direction, forward);
  if (denominator <= 1e-8) return null;
  return addScaledPoint(camera.eye, direction, targetDistance / denominator);
}

function createViewingBoxSeed(
  camera: KernelWorldCamera,
  target: KernelWorldPoint,
  id?: string,
): KernelViewingBoxState {
  const forward = normalizeVector({
    x: camera.target.x - camera.eye.x,
    y: camera.target.y - camera.eye.y,
    z: camera.target.z - camera.eye.z,
  });
  const cameraDistance = Math.hypot(
    camera.eye.x - camera.target.x,
    camera.eye.y - camera.target.y,
    camera.eye.z - camera.target.z,
  );
  const targetDistance = dotVector(
    { x: target.x - camera.eye.x, y: target.y - camera.eye.y, z: target.z - camera.eye.z },
    forward,
  );
  const distance = Math.max(
    camera.projection.near * 2,
    targetDistance > 0 ? targetDistance : cameraDistance,
  );
  const visibleHeight =
    camera.projection.kind === 'orthographic'
      ? camera.projection.verticalSpan
      : 2 * distance * Math.tan(camera.projection.verticalFovRadians * 0.5);
  return viewingBoxFromViewport({
    center: target,
    visibleWidth: visibleHeight * camera.projection.aspect,
    visibleHeight,
    visibleDepth: visibleHeight,
    viewFraction: 0.6,
    uniform: true,
    ...(id ? { id } : {}),
  });
}

function solveViewingBoxFaceCursorDelta(
  state: KernelViewingBoxState,
  handle: ViewingBoxFaceHandle,
  target: ScreenPoint,
  rect: DOMRect,
  camera: KernelWorldCamera,
): number {
  let signedDelta =
    ((target.x - handle.point.x) * handle.screenAxis.x +
      (target.y - handle.point.y) * handle.screenAxis.y) /
    handle.pixelsPerWorldUnit;
  const epsilon = Math.max(1e-5, state.halfExtents[handle.axis] * 1e-4);
  for (let iteration = 0; iteration < 5; iteration += 1) {
    const current = viewingBoxFaceScreenPoint(
      resizeViewingBoxFace(state, handle.axis, handle.face, signedDelta, true),
      handle.axis,
      handle.face,
      rect,
      camera,
    );
    const next = viewingBoxFaceScreenPoint(
      resizeViewingBoxFace(state, handle.axis, handle.face, signedDelta + epsilon, true),
      handle.axis,
      handle.face,
      rect,
      camera,
    );
    if (!current || !next) break;
    const derivative = {
      x: (next.x - current.x) / epsilon,
      y: (next.y - current.y) / epsilon,
    };
    const normSquared = derivative.x * derivative.x + derivative.y * derivative.y;
    if (normSquared < 1e-10) break;
    signedDelta +=
      (derivative.x * (target.x - current.x) + derivative.y * (target.y - current.y)) / normSquared;
  }
  return signedDelta;
}

function solveViewingBoxCornerCursorDeltas(
  state: KernelViewingBoxState,
  handle: ViewingBoxCornerHandle,
  target: ScreenPoint,
  rect: DOMRect,
  camera: KernelWorldCamera,
): KernelWorldPoint {
  const values = [0, 0, 0];
  const epsilon = Math.max(
    1e-5,
    Math.min(state.halfExtents.x, state.halfExtents.y, state.halfExtents.z) * 1e-4,
  );
  for (let iteration = 0; iteration < 5; iteration += 1) {
    const deltas = { x: values[0]!, y: values[1]!, z: values[2]! };
    const current = viewingBoxCornerScreenPoint(
      resizeViewingBoxCorner(state, handle.faces, deltas),
      handle.faces,
      rect,
      camera,
    );
    if (!current) break;
    const columns: ScreenPoint[] = [];
    for (let axis = 0; axis < 3; axis += 1) {
      const perturbed = [...values];
      perturbed[axis] = perturbed[axis]! + epsilon;
      const point = viewingBoxCornerScreenPoint(
        resizeViewingBoxCorner(state, handle.faces, {
          x: perturbed[0]!,
          y: perturbed[1]!,
          z: perturbed[2]!,
        }),
        handle.faces,
        rect,
        camera,
      );
      if (!point) return deltas;
      columns.push({ x: (point.x - current.x) / epsilon, y: (point.y - current.y) / epsilon });
    }
    const a00 = columns.reduce((sum, column) => sum + column.x * column.x, 0);
    const a01 = columns.reduce((sum, column) => sum + column.x * column.y, 0);
    const a11 = columns.reduce((sum, column) => sum + column.y * column.y, 0);
    const determinant = a00 * a11 - a01 * a01;
    if (Math.abs(determinant) < 1e-12) break;
    const residualX = target.x - current.x;
    const residualY = target.y - current.y;
    const planeX = (a11 * residualX - a01 * residualY) / determinant;
    const planeY = (-a01 * residualX + a00 * residualY) / determinant;
    for (let axis = 0; axis < 3; axis += 1) {
      values[axis] = values[axis]! + columns[axis]!.x * planeX + columns[axis]!.y * planeY;
    }
  }
  return { x: values[0]!, y: values[1]!, z: values[2]! };
}

function viewingBoxFaceScreenPoint(
  state: KernelViewingBoxState,
  axis: KernelViewingBoxAxis,
  face: KernelViewingBoxFace,
  rect: DOMRect,
  camera: KernelWorldCamera,
): ScreenPoint | null {
  const index = axis === 'x' ? 0 : axis === 'y' ? 1 : 2;
  const vector = viewingBoxAxes(state)[index];
  return projectViewingBoxPoint(
    addScaledPoint(state.center, vector, face * state.halfExtents[axis]),
    camera,
    rect,
  );
}

function viewingBoxCornerScreenPoint(
  state: KernelViewingBoxState,
  faces: readonly [KernelViewingBoxFace, KernelViewingBoxFace, KernelViewingBoxFace],
  rect: DOMRect,
  camera: KernelWorldCamera,
): ScreenPoint | null {
  return projectViewingBoxPoint(
    localViewingBoxPoint(
      state.center,
      viewingBoxAxes(state),
      [state.halfExtents.x, state.halfExtents.y, state.halfExtents.z],
      faces,
    ),
    camera,
    rect,
  );
}

function drawSquareGrip(
  context: CanvasRenderingContext2D,
  point: ScreenPoint,
  color: string,
): void {
  context.save();
  context.fillStyle = color;
  context.fillRect(point.x - 4, point.y - 4, 8, 8);
  context.restore();
}

function drawPolygon(context: CanvasRenderingContext2D, points: readonly ScreenPoint[]): void {
  const first = points[0];
  if (!first) return;
  context.beginPath();
  context.moveTo(first.x, first.y);
  for (const point of points.slice(1)) context.lineTo(point.x, point.y);
  context.closePath();
  context.fill();
}

function sameViewingBoxHandle(left: ViewingBoxHandle, right: ViewingBoxHandle | null): boolean {
  if (!right || left.kind !== right.kind) return false;
  if (left.kind === 'face' && right.kind === 'face') {
    return left.axis === right.axis && left.face === right.face;
  }
  if (left.kind === 'corner' && right.kind === 'corner') {
    return left.faces.every((face, index) => face === right.faces[index]);
  }
  return left.kind === 'ring' && right.kind === 'ring' && left.axis === right.axis;
}

function viewingBoxFacePolygon(
  corners: readonly (ScreenPoint | null)[],
  axis: number,
  face: KernelViewingBoxFace,
): readonly ScreenPoint[] | null {
  const indices =
    axis === 0
      ? face === -1
        ? [0, 1, 3, 2]
        : [4, 5, 7, 6]
      : axis === 1
        ? face === -1
          ? [0, 1, 5, 4]
          : [2, 3, 7, 6]
        : face === -1
          ? [0, 2, 6, 4]
          : [1, 3, 7, 5];
  const polygon = indices.map((index) => corners[index] ?? null);
  return polygon.some((point) => point === null) ? null : (polygon as ScreenPoint[]);
}

function drawPolyline(
  context: CanvasRenderingContext2D,
  points: readonly ScreenPoint[],
  close: boolean,
): void {
  const first = points[0];
  if (!first) return;
  context.beginPath();
  context.moveTo(first.x, first.y);
  for (let index = 1; index < points.length; index += 1) {
    const point = points[index]!;
    context.lineTo(point.x, point.y);
  }
  if (close) context.closePath();
  context.stroke();
}

function hitTestViewingBoxHandle(
  geometry: ViewingBoxOverlayGeometry | null,
  point: ScreenPoint,
): ViewingBoxHandle | null {
  if (!geometry) return null;
  let closest: { readonly handle: ViewingBoxHandle; readonly distance: number } | null = null;
  for (const handle of geometry.faces) {
    const distance = Math.hypot(point.x - handle.point.x, point.y - handle.point.y);
    if (distance <= 15 && (!closest || distance < closest.distance)) closest = { handle, distance };
  }
  for (const handle of geometry.cornerHandles) {
    const distance = Math.hypot(point.x - handle.point.x, point.y - handle.point.y);
    if (distance <= 10 && (!closest || distance < closest.distance)) closest = { handle, distance };
  }
  for (const handle of geometry.rings) {
    const distance = distanceToPolyline(point, handle.points);
    if (distance <= 9 && (!closest || distance < closest.distance)) closest = { handle, distance };
  }
  return closest?.handle ?? null;
}

function hitTestViewingBoxFace(
  geometry: ViewingBoxOverlayGeometry | null,
  point: ScreenPoint,
): ViewingBoxFaceHandle | null {
  if (!geometry) return null;
  return (
    geometry.faces
      .filter((face) => pointInPolygon(point, face.polygon))
      .sort(
        (left, right) =>
          Math.hypot(point.x - left.point.x, point.y - left.point.y) -
          Math.hypot(point.x - right.point.x, point.y - right.point.y),
      )[0] ?? null
  );
}

function pointInPolygon(point: ScreenPoint, polygon: readonly ScreenPoint[]): boolean {
  let inside = false;
  for (
    let current = 0, previous = polygon.length - 1;
    current < polygon.length;
    previous = current++
  ) {
    const start = polygon[current]!;
    const end = polygon[previous]!;
    if (
      start.y > point.y !== end.y > point.y &&
      point.x < ((end.x - start.x) * (point.y - start.y)) / (end.y - start.y) + start.x
    ) {
      inside = !inside;
    }
  }
  return inside;
}

function distanceToPolyline(point: ScreenPoint, points: readonly ScreenPoint[]): number {
  let closest = Number.POSITIVE_INFINITY;
  for (let index = 1; index < points.length; index += 1) {
    closest = Math.min(closest, distanceToSegment(point, points[index - 1]!, points[index]!));
  }
  return closest;
}

function distanceToSegment(point: ScreenPoint, start: ScreenPoint, end: ScreenPoint): number {
  const deltaX = end.x - start.x;
  const deltaY = end.y - start.y;
  const lengthSquared = deltaX * deltaX + deltaY * deltaY;
  if (lengthSquared <= 1e-12) return Math.hypot(point.x - start.x, point.y - start.y);
  const projection = Math.max(
    0,
    Math.min(1, ((point.x - start.x) * deltaX + (point.y - start.y) * deltaY) / lengthSquared),
  );
  return Math.hypot(
    point.x - (start.x + projection * deltaX),
    point.y - (start.y + projection * deltaY),
  );
}

function eventPoint(event: ReactPointerEvent<HTMLDivElement>, host: HTMLDivElement): ScreenPoint {
  const rect = host.getBoundingClientRect();
  return { x: event.clientX - rect.left, y: event.clientY - rect.top };
}

function normalizeAngle(angle: number): number {
  return Math.atan2(Math.sin(angle), Math.cos(angle));
}

function addScaledPoint(
  point: KernelWorldPoint,
  direction: KernelWorldPoint,
  scale: number,
): KernelWorldPoint {
  return {
    x: point.x + direction.x * scale,
    y: point.y + direction.y * scale,
    z: point.z + direction.z * scale,
  };
}

function localViewingBoxPoint(
  center: KernelWorldPoint,
  axes: readonly [KernelWorldPoint, KernelWorldPoint, KernelWorldPoint],
  extents: readonly [number, number, number],
  signs: readonly [number, number, number],
): KernelWorldPoint {
  let point = center;
  for (let index = 0; index < axes.length; index += 1) {
    point = addScaledPoint(point, axes[index]!, signs[index]! * extents[index]!);
  }
  return point;
}

function normalizeVector(vector: KernelWorldPoint): KernelWorldPoint {
  const length = Math.hypot(vector.x, vector.y, vector.z);
  return length > 1e-12
    ? { x: vector.x / length, y: vector.y / length, z: vector.z / length }
    : { x: 1, y: 0, z: 0 };
}

function crossVector(left: KernelWorldPoint, right: KernelWorldPoint): KernelWorldPoint {
  return {
    x: left.y * right.z - left.z * right.y,
    y: left.z * right.x - left.x * right.z,
    z: left.x * right.y - left.y * right.x,
  };
}

function dotVector(left: KernelWorldPoint, right: KernelWorldPoint): number {
  return left.x * right.x + left.y * right.y + left.z * right.z;
}

function unionBounds(current: Bounds | null, next: Bounds): Bounds {
  if (!current) return next;
  return {
    min: [
      Math.min(current.min[0], next.min[0]),
      Math.min(current.min[1], next.min[1]),
      Math.min(current.min[2], next.min[2]),
    ],
    max: [
      Math.max(current.max[0], next.max[0]),
      Math.max(current.max[1], next.max[1]),
      Math.max(current.max[2], next.max[2]),
    ],
  };
}

function preparedHierarchyBounds(manifestBytes: Uint8Array): Bounds {
  const parsed = JSON.parse(new TextDecoder().decode(manifestBytes)) as unknown;
  if (!isRecord(parsed) || !Array.isArray(parsed.tiles)) {
    throw new Error('Prepared hierarchy manifest has no tile table');
  }
  let result: Bounds | null = null;
  for (const tile of parsed.tiles) {
    if (!isRecord(tile) || !isRecord(tile.bounds) || tile.bounds.kind !== 'axisAlignedBox') {
      continue;
    }
    const box = tile.bounds.bounds;
    if (!isRecord(box) || !isRecord(box.min) || !isRecord(box.max)) continue;
    const values = [box.min.x, box.min.y, box.min.z, box.max.x, box.max.y, box.max.z];
    if (!values.every((value) => typeof value === 'number' && Number.isFinite(value))) continue;
    result = unionBounds(result, {
      min: [values[0] as number, values[1] as number, values[2] as number],
      max: [values[3] as number, values[4] as number, values[5] as number],
    });
  }
  if (!result) throw new Error('Prepared hierarchy manifest has no finite axis-aligned bounds');
  return result;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function tuplePoint(value: readonly [number, number, number]): Vec3 {
  return { x: value[0], y: value[1], z: value[2] };
}

function tuplePosition(value: readonly [number, number, number]): {
  x: number;
  y: number;
  z: number;
} {
  return { x: value[0], y: value[1], z: value[2] };
}

function rasterCorner(
  origin: readonly [number, number, number],
  columnStep: readonly [number, number, number],
  rowStep: readonly [number, number, number],
  width: number,
  height: number,
): readonly [number, number, number] {
  return [
    origin[0] + columnStep[0] * Math.max(0, width - 1) + rowStep[0] * Math.max(0, height - 1),
    origin[1] + columnStep[1] * Math.max(0, width - 1) + rowStep[1] * Math.max(0, height - 1),
    origin[2] + columnStep[2] * Math.max(0, width - 1) + rowStep[2] * Math.max(0, height - 1),
  ];
}

function developmentRasterPreviewAdmission(
  kernel: KernelViewportHandle,
  entityId: EntityId,
  name: string,
  geometry: GeometryObject,
  style: KernelRenderStyle,
): KernelCanonicalRenderAdmission {
  const selected: Representation = {
    role: 'canonical',
    geometryRef: kernel.session.geometryObjectContentHash(geometry),
    authority: 'authoritative',
    dependencyHash: null,
  };
  const entityWithoutHash = {
    id: entityId,
    revision: 1,
    typeId: geometry.kind === 'rasterImage' ? 'hcad.raster-image@1' : 'hcad.geometry@1',
    name,
    owner: null,
    layerIds: [],
    placement: null,
    representations: [selected],
    componentsRef: DEV_RASTER_COMPONENTS_HASH,
    attributesRef: DEV_RASTER_ATTRIBUTES_HASH,
    relationsRef: DEV_RASTER_RELATIONS_HASH,
    styleRef: null,
    schemaVersion: 1,
  } satisfies Omit<CanonicalEntity, 'versionHash'>;
  const hashInput: CanonicalEntity = { ...entityWithoutHash, versionHash: '00'.repeat(32) };
  const entity: CanonicalEntity = {
    ...entityWithoutHash,
    versionHash: kernel.session.canonicalEntityVersionHash(hashInput),
  };
  return {
    admission: {
      entity,
      selected,
      representationSlot: 'primary',
      expectedGeneration: null,
      resolvedGeometry: geometry,
    },
    style,
  };
}

function augmentDraftingCandidate(
  candidate: KernelPickCandidate,
  origin: KernelWorldPoint | null | undefined,
  geometryByEntity: ReadonlyMap<
    EntityId,
    Pick<CanonicalRepresentationAdmission, 'entity' | 'resolvedGeometry'>
  >,
  kernel: KernelViewportHandle | null,
  host: HTMLDivElement | null,
): KernelPickCandidate {
  if (candidate.snapKind !== 'edge' || !kernel || !host) return candidate;
  if (candidate.worldPosition.z === null) return candidate;
  const cursorWorld: KernelWorldPoint = {
    x: candidate.worldPosition.x,
    y: candidate.worldPosition.y,
    z: candidate.worldPosition.z,
  };
  const source = geometryByEntity.get(candidate.address.entityId as EntityId);
  const sourceSegments = source ? curveLineSegments(source.resolvedGeometry) : [];
  if (sourceSegments.length === 0) return candidate;
  const rect = host.getBoundingClientRect();
  const camera = kernel.camera.worldCamera();
  const cursorScreen = projectViewingBoxPoint(cursorWorld, camera, rect);
  if (!cursorScreen) return candidate;
  let bestIntersection: KernelWorldPoint | null = null;
  let bestIntersectionPixels = 9;
  for (const [entityId, admission] of geometryByEntity) {
    if (entityId === candidate.address.entityId) continue;
    for (const left of sourceSegments) {
      for (const right of curveLineSegments(admission.resolvedGeometry)) {
        const intersection = lineIntersectionXY(left, right);
        if (!intersection) continue;
        const screen = projectViewingBoxPoint(intersection, camera, rect);
        if (!screen) continue;
        const pixels = Math.hypot(screen.x - cursorScreen.x, screen.y - cursorScreen.y);
        if (pixels <= bestIntersectionPixels) {
          bestIntersectionPixels = pixels;
          bestIntersection = intersection;
        }
      }
    }
  }
  if (bestIntersection) {
    return {
      ...candidate,
      worldPosition: bestIntersection,
      presentationPosition: bestIntersection,
      snapKind: 'intersection',
      pixelDistance: bestIntersectionPixels,
    };
  }
  if (!origin) return candidate;
  let bestFoot: KernelWorldPoint | null = null;
  let bestFootPixels = 9;
  for (const segment of sourceSegments) {
    const foot = perpendicularFoot(origin, segment);
    const screen = projectViewingBoxPoint(foot, camera, rect);
    if (!screen) continue;
    const pixels = Math.hypot(screen.x - cursorScreen.x, screen.y - cursorScreen.y);
    if (pixels <= bestFootPixels) {
      bestFootPixels = pixels;
      bestFoot = foot;
    }
  }
  return bestFoot
    ? {
        ...candidate,
        worldPosition: bestFoot,
        presentationPosition: bestFoot,
        snapKind: 'perpendicular',
        pixelDistance: bestFootPixels,
      }
    : candidate;
}

function curveLineSegments(
  geometry: GeometryObject,
): readonly (readonly [KernelWorldPoint, KernelWorldPoint])[] {
  if (geometry.kind !== 'curve') return [];
  const curve = geometry.curve;
  const positions =
    curve.kind === 'lineSegment'
      ? [curve.start, curve.end]
      : curve.kind === 'polyline'
        ? curve.positions
        : [];
  const points = positions.flatMap((point) =>
    point.z === null ? [] : [{ x: point.x, y: point.y, z: point.z }],
  );
  const segments: (readonly [KernelWorldPoint, KernelWorldPoint])[] = [];
  for (let index = 1; index < points.length; index += 1) {
    segments.push([points[index - 1]!, points[index]!]);
  }
  if (curve.kind === 'polyline' && curve.closed && points.length > 2) {
    segments.push([points.at(-1)!, points[0]!]);
  }
  return segments;
}

function lineIntersectionXY(
  left: readonly [KernelWorldPoint, KernelWorldPoint],
  right: readonly [KernelWorldPoint, KernelWorldPoint],
): KernelWorldPoint | null {
  const [a, b] = left;
  const [c, d] = right;
  const denominator = (b.x - a.x) * (d.y - c.y) - (b.y - a.y) * (d.x - c.x);
  if (Math.abs(denominator) <= 1e-12) return null;
  const t = ((c.x - a.x) * (d.y - c.y) - (c.y - a.y) * (d.x - c.x)) / denominator;
  const u = ((c.x - a.x) * (b.y - a.y) - (c.y - a.y) * (b.x - a.x)) / denominator;
  if (t < 0 || t > 1 || u < 0 || u > 1) return null;
  return {
    x: a.x + (b.x - a.x) * t,
    y: a.y + (b.y - a.y) * t,
    z: a.z + (b.z - a.z) * t,
  };
}

function perpendicularFoot(
  point: KernelWorldPoint,
  [start, end]: readonly [KernelWorldPoint, KernelWorldPoint],
): KernelWorldPoint {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const run = dx * dx + dy * dy;
  const t =
    run === 0
      ? 0
      : Math.max(0, Math.min(1, ((point.x - start.x) * dx + (point.y - start.y) * dy) / run));
  return {
    x: start.x + dx * t,
    y: start.y + dy * t,
    z: start.z + (end.z - start.z) * t,
  };
}

function snapFromCandidate(candidate: KernelPickCandidate): SnapResult {
  const primitiveId = candidate.address.primitiveId;
  const datasetKind =
    candidate.snapKind === 'rasterSample'
      ? ('grid' as const)
      : candidate.snapKind === 'point'
        ? ('point-cloud' as const)
        : candidate.snapKind === 'surface'
          ? ('mesh' as const)
          : ('cad' as const);
  const primitive =
    primitiveId === null
      ? ({ kind: 'free' } as const)
      : candidate.snapKind === 'point'
        ? ({ kind: 'point', pointIndex: primitiveId } as const)
        : candidate.snapKind === 'vertex' || candidate.snapKind === 'midpoint'
          ? ({ kind: 'vertex', vertexIndex: primitiveId } as const)
          : candidate.snapKind === 'edge' ||
              candidate.snapKind === 'intersection' ||
              candidate.snapKind === 'perpendicular'
            ? ({ kind: 'edge', edgeIndex: primitiveId } as const)
            : candidate.snapKind === 'rasterSample'
              ? ({ kind: 'grid' } as const)
              : ({ kind: 'face', faceIndex: primitiveId } as const);
  return {
    position: candidate.worldPosition,
    kind: snapKind(candidate.snapKind),
    entity: candidate.address.entityId as EntityId,
    confidence: 1 / (1 + Math.max(0, candidate.pixelDistance)),
    source: datasetKind,
    distancePx: candidate.pixelDistance,
    stable: true,
    candidateId: `${candidate.snapKind}:${candidate.address.renderProxyId}:${candidate.address.tileId ?? ''}:${String(candidate.address.primitiveId ?? '')}`,
    target: {
      datasetKind,
      entityId: candidate.address.entityId as EntityId,
      ...(candidate.address.datasetId ? { layerId: candidate.address.datasetId } : {}),
      ...(candidate.address.tileId ? { tileId: candidate.address.tileId } : {}),
      primitive,
      exact: true,
    },
  };
}

function remapViewingBoxCandidate(
  candidate: KernelPickCandidate,
  proxySources: ReadonlyMap<EntityId, EntityId>,
): KernelPickCandidate;
function remapViewingBoxCandidate(
  candidate: KernelPickCandidate | null,
  proxySources: ReadonlyMap<EntityId, EntityId>,
): KernelPickCandidate | null;
function remapViewingBoxCandidate(
  candidate: KernelPickCandidate | null,
  proxySources: ReadonlyMap<EntityId, EntityId>,
): KernelPickCandidate | null {
  if (!candidate) return null;
  const source = proxySources.get(candidate.address.entityId as EntityId);
  return source ? { ...candidate, address: { ...candidate.address, entityId: source } } : candidate;
}

async function bakedPointCloudAdmission(
  kernel: KernelViewportHandle,
  source: CanonicalRepresentationAdmission,
  entityId: EntityId,
  metadata: Uint8Array,
  pointCount: number,
): Promise<CanonicalRepresentationAdmission> {
  const geometry: GeometryObject = {
    kind: 'pointCloud',
    dataset: {
      formatId: 'potree@2',
      metadata: {
        objectHash: await sha256Hex(metadata),
        mediaType: 'application/json',
        byteLength: metadata.byteLength,
      },
      elementCount: pointCount,
    },
  };
  const selected: Representation = {
    ...source.selected,
    geometryRef: kernel.session.geometryObjectContentHash(geometry),
  };
  const entityWithoutHash = {
    ...source.entity,
    id: entityId,
    revision: 0,
    name: `${source.entity.name} — locked viewing box`,
    representations: source.entity.representations.map((representation) =>
      representation.role === source.selected.role &&
      representation.geometryRef === source.selected.geometryRef
        ? selected
        : representation,
    ),
  };
  const hashInput: CanonicalEntity = { ...entityWithoutHash, versionHash: '00'.repeat(32) };
  return {
    entity: {
      ...entityWithoutHash,
      versionHash: kernel.session.canonicalEntityVersionHash(hashInput),
    },
    selected,
    representationSlot: `viewing-box:${source.representationSlot}`,
    expectedGeneration: null,
    resolvedGeometry: geometry,
  };
}

function throwIfViewingBoxBakeAborted(signal: AbortSignal): void {
  if (signal.aborted) throw new DOMException('Viewing-box bake cancelled.', 'AbortError');
}

function snapKind(kind: KernelPickCandidate['snapKind']): SnapKind {
  switch (kind) {
    case 'point':
      return 'Point';
    case 'vertex':
    case 'midpoint':
      return 'Vertex';
    case 'edge':
    case 'intersection':
    case 'perpendicular':
      return 'Edge';
    case 'surface':
      return 'Face';
    case 'rasterSample':
      return 'Grid';
  }
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes.slice().buffer));
  return [...digest].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function decodeImageDimensions(imageUrl: string): Promise<{ width: number; height: number }> {
  const response = await fetch(imageUrl);
  if (!response.ok) throw new Error(`Raster image request failed (${response.status})`);
  const bitmap = await createImageBitmap(await response.blob());
  const width = bitmap.width;
  const height = bitmap.height;
  bitmap.close();
  return { width, height };
}

async function loadPreparedRaster(
  kernel: KernelViewportHandle,
  imageUrl: string,
  depthUrl: string | null,
  width: number,
  height: number,
  options: BuilderRasterImageOptions,
  elevations: { readonly min: number; readonly max: number },
): Promise<void> {
  const datasetId = `builder-raster:${options.entityId}`;
  const formatId = 'himmelcad-prepared-hierarchy@1';
  const sourceTiles = options.tiles ?? [{ x: 0, y: 0, width, height, imageUrl, depthUrl }];
  const tiles = await Promise.all(
    sourceTiles.map(async (tile, index) => {
      const tileDepthUrl = depthUrl ? (tile.depthUrl ?? depthUrl) : null;
      let depthBytes: Uint8Array | null = null;
      let depthHash: string | null = null;
      if (tileDepthUrl) {
        const response = await fetch(tileDepthUrl);
        if (!response.ok) throw new Error(`DEM tile request failed (${response.status})`);
        depthBytes = new Uint8Array(await response.arrayBuffer());
        const expected = tile.width * tile.height * Float32Array.BYTES_PER_ELEMENT;
        if (depthBytes.byteLength !== expected) {
          throw new Error(
            `DEM tile mismatch: expected ${expected} bytes, received ${depthBytes.byteLength}`,
          );
        }
        const elevations = new Float32Array(
          depthBytes.buffer,
          depthBytes.byteOffset,
          depthBytes.byteLength / Float32Array.BYTES_PER_ELEMENT,
        );
        if (
          !elevations.some((value) => Number.isFinite(value) && Math.abs(value - 482.75) > 1e-5)
        ) {
          return null;
        }
        depthHash = await sha256Hex(depthBytes);
      }
      const tileOrigin: readonly [number, number, number] = [
        options.origin[0] + options.columnStep[0] * tile.x + options.rowStep[0] * tile.y,
        options.origin[1] + options.columnStep[1] * tile.x + options.rowStep[1] * tile.y,
        options.origin[2],
      ];
      const tileLast = rasterCorner(
        tileOrigin,
        options.columnStep,
        options.rowStep,
        tile.width,
        tile.height,
      );
      return {
        id: `tile-${index}`,
        bounds: {
          kind: 'axisAlignedBox' as const,
          bounds: {
            min: {
              x: Math.min(tileOrigin[0], tileLast[0]),
              y: Math.min(tileOrigin[1], tileLast[1]),
              z: elevations.min,
            },
            max: {
              x: Math.max(tileOrigin[0], tileLast[0]),
              y: Math.max(tileOrigin[1], tileLast[1]),
              z: elevations.max,
            },
          },
        },
        content: {
          kind: 'raster',
          uri: tile.imageUrl,
          byteOffset: null,
          byteLength: null,
          primitiveCount: tile.width * tile.height,
          contentHash: null,
          decoderParameters: {
            schemaVersion: 1,
            width: tile.width,
            height: tile.height,
            mapping: {
              origin: [tileOrigin[0], tileOrigin[1]],
              columnStep: [options.columnStep[0], options.columnStep[1]],
              rowStep: [options.rowStep[0], options.rowStep[1]],
            },
            topology: {
              kind: 'continuous',
              maximumHeightJump: 8,
              diagonal: 'topLeftToBottomRight',
            },
            colorEncoding: 'encodedImage',
            elevationEncoding: depthBytes
              ? { kind: 'float32LittleEndian' }
              : { kind: 'constant', value: options.origin[2] },
            noData: depthBytes ? { kind: 'numeric', value: 482.75 } : { kind: 'none' },
            elevationReference: depthBytes
              ? {
                  uri: tileDepthUrl!,
                  byteOffset: 0,
                  byteLength: depthBytes.byteLength,
                  contentHash: depthHash!,
                }
              : null,
            validityReference: null,
            confidenceReference: null,
            triangleMaskReference: null,
          },
        },
      };
    }),
  );
  const renderableTiles = tiles.filter((tile): tile is NonNullable<typeof tile> => tile !== null);
  const manifest = {
    schemaVersion: 1,
    roots: renderableTiles.map((tile) => tile.id),
    tiles: renderableTiles.map((tile) => ({
      id: tile.id,
      parent: null,
      children: [],
      bounds: tile.bounds,
      contentTransform: IDENTITY,
      geometricError: 0,
      refinement: 'replace',
      contents: [tile.content],
      childPage: null,
    })),
  };
  const manifestBytes = new TextEncoder().encode(JSON.stringify(manifest));
  const manifestHash = await sha256Hex(manifestBytes);
  const geometry: GeometryObject = {
    kind: 'rasterImage',
    raster: {
      pixels: {
        objectHash: manifestHash,
        mediaType: formatId,
        byteLength: manifestBytes.byteLength,
      },
      width,
      height,
      mapping: {
        kind: 'orthoGrid',
        origin: tuplePosition(options.origin),
        columnStep: tuplePosition(options.columnStep),
        rowStep: tuplePosition(options.rowStep),
      },
      depth: null,
    },
  };
  const renderAdmission = developmentRasterPreviewAdmission(
    kernel,
    options.entityId,
    options.sourceName,
    geometry,
    RASTER_STYLE,
  );
  kernel.session.loadPreparedHierarchy({
    datasetId,
    formatId,
    manifestUri: `${imageUrl}#${encodeURIComponent(options.entityId)}`,
    manifestBytes,
    admissions: [{ ...renderAdmission, datasetId, exaggerationDatum: elevations.min }],
    ...(depthUrl === null
      ? {
          viewPolicies: {
            [options.entityId]: {
              availability: 'planOnly' as const,
              sourceHeight: 'unknown' as const,
            },
          },
        }
      : {}),
  });
  kernel.requestFrame();
}

function formatCoordinate(value: number): string {
  return Number.isFinite(value) ? value.toFixed(3) : '—';
}

function createDeferred<T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
  readonly reject: (reason: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function BuilderHud({
  kernelRef,
}: {
  readonly kernelRef: { readonly current: KernelViewportHandle | null };
}): JSX.Element {
  const outputRef = useRef<HTMLOutputElement | null>(null);
  useEffect(() => {
    const update = (): void => {
      const output = outputRef.current;
      const kernel = kernelRef.current;
      if (!output || !kernel) return;
      const snapshot = kernel.session.hudDiagnosticsWindow();
      const frame = snapshot.lastFrame;
      const quality = kernel.session.qualitySnapshot();
      const reasons =
        frame?.deadlineReasonCodes.filter((reason) => reason !== 'within_target') ?? [];
      const budget = reasons[0] ? (budgetLabels[reasons[0]] ?? reasons[0]) : frame ? 'within' : '—';
      const p95 = snapshot.presentedFrameIntervalMs?.p95 ?? null;
      const setText = (selector: string, value: string): void => {
        const element = output.querySelector<HTMLElement>(selector);
        if (element) element.textContent = value;
      };
      const idle = output.querySelector<HTMLElement>('[data-hud-idle]');
      const metrics = output.querySelector<HTMLElement>('[data-hud-metrics]');
      if (idle) idle.hidden = p95 !== null;
      if (metrics) metrics.hidden = p95 === null;
      setText('[data-hud-p95]', p95?.toFixed(1) ?? '—');
      setText('[data-hud-p50]', snapshot.presentedFrameIntervalMs?.p50.toFixed(1) ?? '—');
      setText('[data-hud-points]', frame ? (frame.primitives.points / 1_000_000).toFixed(1) : '—');
      setText('[data-hud-quality]', `${quality.class}-${quality.tier}`);
      setText('[data-hud-budget]', budget);
      setText(
        '[data-hud-backlog]',
        frame ? String(frame.requestBacklog + frame.decodeBacklog + frame.uploadBacklog) : '—',
      );
      const p95Element = output.querySelector<HTMLElement>('[data-hud-p95]');
      if (p95Element) {
        p95Element.dataset.tone =
          p95 !== null && p95 > 2 * quality.targets.motionFrameMs
            ? 'error'
            : p95 !== null && p95 > quality.targets.motionFrameMs
              ? 'warning'
              : 'normal';
      }
    };
    update();
    const timer = window.setInterval(update, 250);
    return () => window.clearInterval(timer);
  }, [kernelRef]);
  const budgetLabels: Partial<Record<KernelDeadlineReasonCode, string>> = {
    gpu_deadline: 'gpu',
    cpu_deadline: 'cpu',
    recovery_headroom: 'recovery',
    invalid_timing: 'timing',
    resource_budget: 'resource',
    frame_budget: 'frame',
    invalid_benefit: 'benefit',
    protected_work_over_budget: 'protected',
    'budget:points': 'points',
    'budget:bytes': 'bytes',
    'decode:backlog': 'decode',
    'upload:backlog': 'upload',
  };
  return (
    <ViewportHud
      outputRef={outputRef}
      p95={null}
      p50={null}
      points={null}
      targetMs={Infinity}
      quality={null}
      budget="—"
      backlog={null}
    />
  );
}

interface CameraHistoryState {
  readonly camera: KernelWorldCamera;
  readonly mode: KernelViewMode;
}
function parseCameraHistory(input: unknown): CameraHistoryState {
  const state = input as CameraHistoryState;
  if (!state || !['3d', '2d', '2.5d'].includes(state.mode))
    throw new TypeError('Invalid camera history mode');
  new KernelCameraController(1, 1).adoptWorldCamera(state.camera);
  return state;
}
