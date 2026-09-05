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

import { LocalStorageViewHistoryPersistence, ViewLocalHistory } from '@himmelcad/app';
import type { EntityId, SnapKind, SnapResult, SourcePosition3, Vec3 } from '@himmelcad/data';
import { ViewportHud, OverlayChip, registerEscapeRung } from '@himmelcad/ui';
import {
  KernelCameraController,
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
  type KernelRgbaCaptureRequest,
  type KernelRgbaCaptureResult,
  type KernelRenderStyle,
  type KernelViewingBoxAxis,
  type KernelViewingBoxFace,
  type KernelViewingBoxState,
  type KernelViewMode,
  type KernelWorldCamera,
  type KernelWorldPoint,
  type Representation,
  resizeViewingBoxFace,
  rotateViewingBox,
  setViewingBoxMode,
  viewingBoxAxes,
  viewingBoxClipVolume,
  viewingBoxFromViewport,
} from '@himmelcad/viewer/kernel';
import { KernelViewport, type KernelViewportHandle } from '@himmelcad/viewer/kernel/react';

import styles from './BuilderKernelViewport.module.css';

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

export interface BuilderPointCloudOptions {
  readonly datasetId: string;
  /** Exact admission already committed by the canonical project runtime. */
  readonly admission: CanonicalRepresentationAdmission;
  readonly bounds: {
    readonly min: readonly [number, number, number];
    readonly max: readonly [number, number, number];
  };
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
  loadCanonicalPackage(package_: BuilderCanonicalImportPackage): Promise<readonly EntityId[]>;
  loadRasterImage(imageUrl: string, options: BuilderRasterImageOptions): Promise<void>;
  loadDrapedRaster(
    imageUrl: string,
    depthUrl: string,
    options: BuilderRasterImageOptions,
  ): Promise<void>;
  cameraHistory(action: 'undo' | 'redo'): Promise<void>;
  frameAll(): void;
  setPreset(preset: 'top' | 'front' | 'right' | 'isometric'): void;
  setPointSize(pointSize: number): void;
  setViewMode(mode: KernelViewMode): Promise<void>;
  worldCamera(): KernelWorldCamera | null;
  adoptWorldCamera(camera: KernelWorldCamera): KernelWorldCamera;
  waitForNextPresentedFrame(): Promise<void>;
  diagnosticsSnapshot(lastFrames?: number): KernelDiagnosticsSnapshot;
  sampleDiagnostics(request: KernelDiagnosticsSampleRequest): Promise<KernelDiagnosticsSampleResult>;
  captureRgba(request: KernelRgbaCaptureRequest): Promise<KernelRgbaCaptureResult>;
  captureRectangle(): { x: number; y: number; width: number; height: number } | null;
  setEntityAppearance(
    entityIds: readonly EntityId[],
    options: { readonly opacity?: number; readonly verticalExaggeration?: number },
  ): void;
  setEntityVisibility(entityIds: readonly EntityId[], visible: boolean): void;
  setClipVolumes(volumes: readonly KernelClipVolume[]): void;
  setAutomationClipVolumes(volumes: readonly KernelClipVolume[]): void;
  createViewingBoxAt(center?: SourcePosition3): KernelViewingBoxState | null;
  setViewingBox(state: KernelViewingBoxState | null): void;
}

interface BuilderKernelViewportProps {
  readonly projectId?: string;
  readonly hudVisible?: boolean;
  readonly pointSize: number;
  readonly onCursorSnap: (snap: SnapResult | null) => void;
  readonly onDropFiles: (paths: string[]) => void | Promise<void>;
  readonly onLog: (level: 'debug' | 'info' | 'warn' | 'error', message: string) => void;
  readonly viewingBox?: KernelViewingBoxState | null;
  readonly placingViewingBoxCenter?: boolean;
  readonly onViewportPoint?: (position: SourcePosition3) => void;
  readonly onViewingBoxChange?: (state: KernelViewingBoxState | null) => void;
  readonly selectedEntityIds?: ReadonlySet<EntityId>;
  readonly onSelectEntity?: (id: EntityId, mode: 'replace' | 'toggle') => void;
  readonly onClearSelection?: () => void;
  readonly isEntityClickPickable?: (id: EntityId) => boolean;
  readonly isEntitySelectionHighlightable?: (id: EntityId) => boolean;
  readonly onCandidateSet?: (candidates: readonly KernelPickCandidate[], index: number) => void;
  readonly onCandidateSetClear?: () => void;
  readonly onContextSurface?: (
    candidate: KernelPickCandidate | null,
    position: { readonly x: number; readonly y: number },
  ) => void;
  readonly onRegistryShortcut?: (event: KeyboardEvent) => void;
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
}

interface ViewingBoxRingHandle {
  readonly kind: 'ring';
  readonly axis: KernelViewingBoxAxis;
  readonly center: ScreenPoint;
  readonly points: readonly ScreenPoint[];
}

type ViewingBoxHandle = ViewingBoxFaceHandle | ViewingBoxRingHandle;

type ViewingBoxPointerInteraction =
  | {
      readonly kind: 'face';
      readonly pointerId: number;
      readonly startClientX: number;
      readonly startClientY: number;
      readonly startState: KernelViewingBoxState;
      readonly handle: ViewingBoxFaceHandle;
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
      moved: boolean;
    };

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
    viewingBox = null,
    placingViewingBoxCenter = false,
    onViewportPoint,
    onViewingBoxChange,
    selectedEntityIds = new Set<EntityId>(),
    onSelectEntity,
    onClearSelection,
    isEntityClickPickable,
    isEntitySelectionHighlightable,
    onCandidateSet,
    onCandidateSetClear,
    onContextSurface,
    onRegistryShortcut,
  },
  ref,
): JSX.Element {
  const kernelRef = useRef<KernelViewportHandle | null>(null);
  const cameraHistoryRef = useRef<ViewLocalHistory<CameraHistoryState> | null>(null);
  const restoringCameraRef = useRef(false);
  const recordCamera = useCallback(() => {
    const kernel = kernelRef.current;
    if (kernel && !restoringCameraRef.current) cameraHistoryRef.current?.commit({ camera: kernel.camera.worldCamera(), mode: viewModeRef.current }, crypto.randomUUID());
  }, []);
  useEffect(() => {
    let cancelled = false;
    cameraHistoryRef.current = null;
    if (!projectId) return;
    void readyRef.current.promise.then(async (kernel) => {
      if (cancelled) return;
      const history = new ViewLocalHistory(projectId, 'camera', { camera: kernel.camera.worldCamera(), mode: viewModeRef.current }, parseCameraHistory,
        new LocalStorageViewHistoryPersistence(window.localStorage, 'camera'),
        (message) => callbacksRef.current.onLog('warn', message));
      await history.open();
      if (cancelled) return;
      restoringCameraRef.current = true;
      try {
        const state = history.current;
        await kernel.session.setViewMode(state.mode, 0);
        if (cancelled) return;
        kernel.session.adoptWorldCamera(state.camera);
        viewModeRef.current = state.mode;
        setViewModeState(state.mode);
        cameraHistoryRef.current = history;
      } finally { restoringCameraRef.current = false; }
    }).catch((error: unknown) => callbacksRef.current.onLog('error', String(error)));
    return () => { cancelled = true; cameraHistoryRef.current = null; };
  }, [projectId]);
  const hostRef = useRef<HTMLDivElement | null>(null);
  const viewingBoxOverlayRef = useRef<HTMLCanvasElement | null>(null);
  const readyRef = useRef(createDeferred<KernelViewportHandle>());
  const loadedBoundsRef = useRef<Bounds | null>(null);
  const entityStylesRef = useRef(new Map<EntityId, KernelRenderStyle>());
  const entityExaggerationDatumsRef = useRef(new Map<EntityId, number>());
  const callbacksRef = useRef({
    onCursorSnap,
    onDropFiles,
    onLog,
    onViewportPoint,
    onViewingBoxChange,
    selectedEntityIds,
    onSelectEntity,
    onClearSelection,
    isEntityClickPickable,
    isEntitySelectionHighlightable,
    onCandidateSet,
    onCandidateSetClear,
    onContextSurface,
    onRegistryShortcut,
  });
  const pointerPositionRef = useRef({ x: 0, y: 0 });
  const activeSourcePositionRef = useRef<SourcePosition3 | null>(null);
  const viewingBoxRef = useRef(viewingBox);
  const viewingBoxInteractionRef = useRef<ViewingBoxPointerInteraction | null>(null);
  const pendingViewingBoxPreviewRef = useRef<KernelViewingBoxState | null>(null);
  const viewingBoxPreviewFrameRef = useRef<number | null>(null);
  const pointSizeRef = useRef(pointSize);
  const viewModeRef = useRef<KernelViewMode>('3d');
  const automationClipIdsRef = useRef(new Set<string>());
  const highlightedSelectionRef = useRef(new Set<EntityId>());
  callbacksRef.current = {
    onCursorSnap,
    onDropFiles,
    onLog,
    onViewportPoint,
    onViewingBoxChange,
    selectedEntityIds,
    onSelectEntity,
    onClearSelection,
    isEntityClickPickable,
    isEntitySelectionHighlightable,
    onCandidateSet,
    onCandidateSetClear,
    onContextSurface,
    onRegistryShortcut,
  };
  viewingBoxRef.current = viewingBox;
  const [cursor, setCursor] = useState<SourcePosition3 | null>(null);
  const [viewMode, setViewModeState] = useState<KernelViewMode>('3d');
  const [dragging, setDragging] = useState(false);
  const [viewingBoxCursor, setViewingBoxCursor] = useState<'default' | 'grab' | 'grabbing'>(
    'default',
  );

  useEffect(() => {
    pointSizeRef.current = pointSize;
    kernelRef.current?.session.setPointSize(pointSize);
  }, [pointSize]);

  useEffect(() => {
    const kernel = kernelRef.current;
    if (!kernel) return;
    const next = new Set(
      [...selectedEntityIds].filter(
        (id) => callbacksRef.current.isEntitySelectionHighlightable?.(id) ?? true,
      ),
    );
    for (const id of highlightedSelectionRef.current) {
      if (!next.has(id)) kernel.session.setEntityInteractionState(id, { selected: false, hovered: false });
    }
    for (const id of next) {
      if (!highlightedSelectionRef.current.has(id)) {
        kernel.session.setEntityInteractionState(id, { selected: true, hovered: false });
      }
    }
    highlightedSelectionRef.current = next;
  }, [selectedEntityIds]);

  useEffect(() => {
    drawViewingBoxOverlay(
      viewingBoxOverlayRef.current,
      hostRef.current,
      kernelRef.current,
      viewingBox,
    );
  }, [viewingBox]);

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

  const changeViewMode = useCallback(async (mode: KernelViewMode): Promise<void> => {
    viewModeRef.current = mode;
    setViewModeState(mode);
    await kernelRef.current?.session.setViewMode(mode).catch((error: unknown) => {
      callbacksRef.current.onLog('error', `View mode change failed: ${String(error)}`);
      throw error;
    });
    recordCamera();
  }, [recordCamera]);

  useImperativeHandle(
    ref,
    () => ({
      async loadPotreePointCloud(metadataUrl, options) {
        const kernel = await readyRef.current.promise;
        const entityId = options.admission.entity.id as EntityId;
        if (options.admission.resolvedGeometry.kind !== 'pointCloud') {
          throw new Error('committed LAS admission does not resolve to point-cloud geometry');
        }
        await kernel.session.loadPotree(
          {
            datasetId: options.datasetId,
            metadataUri: metadataUrl,
            admission: options.admission,
            style: POINT_CLOUD_STYLE,
          },
          { operationId: `builder/load/${entityId}` },
        );
        entityStylesRef.current.set(entityId, POINT_CLOUD_STYLE);
        entityExaggerationDatumsRef.current.set(entityId, options.bounds.min[2]);
        loadedBoundsRef.current = unionBounds(loadedBoundsRef.current, options.bounds);
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
        for (const id of loaded) {
          entityStylesRef.current.set(id, IFC_STYLE);
          entityExaggerationDatumsRef.current.set(id, 0);
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
        const history = cameraHistoryRef.current, kernel = kernelRef.current;
        if (!history || !kernel || restoringCameraRef.current) throw new Error('Camera history is not ready');
        restoringCameraRef.current = true;
        try {
          const state = action === 'undo' ? history.undo() : history.redo();
          await kernel.session.setViewMode(state.mode, 0);
          kernel.session.adoptWorldCamera(state.camera);
          viewModeRef.current = state.mode;
          setViewModeState(state.mode);
        } finally { restoringCameraRef.current = false; }
      },
      frameAll,
      setPreset(preset) {
        const kernel = kernelRef.current;
        if (!kernel) throw new Error('viewer is not ready');
        const camera = kernel.camera.worldCamera();
        if (viewModeRef.current === '2d' && preset !== 'top') throw new Error('This preset requires 3D or 2.5D navigation.');
        const distance = Math.hypot(camera.eye.x - camera.target.x, camera.eye.y - camera.target.y, camera.eye.z - camera.target.z);
        // KernelCameraController.eye/worldCamera: Z up, yaw zero looks from -Y.
        const axis = preset === 'top' ? [0, 0, 1] : preset === 'front' ? [0, -1, 0] : preset === 'right' ? [1, 0, 0] : [0, -Math.SQRT1_2, Math.SQRT1_2];
        kernel.session.adoptWorldCamera({ ...camera,
          eye: { x: camera.target.x + axis[0]! * distance, y: camera.target.y + axis[1]! * distance, z: camera.target.z + axis[2]! * distance },
          up: preset === 'top' ? { x: 0, y: 1, z: 0 } : { x: 0, y: 0, z: 1 },
        });
        recordCamera();
      },
      setPointSize(pointSize) {
        kernelRef.current?.session.setPointSize(pointSize);
      },
      setViewMode(mode) {
        return changeViewMode(mode);
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
      setEntityVisibility(entityIds, visible) {
        const kernel = kernelRef.current;
        if (!kernel) return;
        kernel.navigation.gestures.clearCandidateIndicator();
        for (const entityId of entityIds) kernel.scene.setEntityVisibility(entityId, visible);
        kernel.requestFrame();
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
      createViewingBoxAt(center) {
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
          {
            x: target.x - camera.eye.x,
            y: target.y - camera.eye.y,
            z: target.z - camera.eye.z,
          },
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
          viewFraction: 0.25,
          uniform: true,
        });
      },
      setViewingBox(state) {
        kernelRef.current?.session.setScopedClipVolume(
          'builder:viewing-box',
          state ? viewingBoxClipVolume(state) : null,
        );
      },
    }),
    [changeViewMode, frameAll, viewMode],
  );

  const handleReady = useCallback((handle: KernelViewportHandle) => {
    kernelRef.current = handle;
    if (import.meta.env.DEV) Object.assign(window, { __hcadBuilderKernel: handle });
    handle.session.setClearColor([0.008, 0.011, 0.016, 1]);
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
  }, []);

  const handlePick = useCallback((candidate: KernelPickCandidate | null) => {
    activeSourcePositionRef.current = candidate?.worldPosition ?? null;
    callbacksRef.current.onCursorSnap(candidate ? snapFromCandidate(candidate) : null);
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
      .filter((path) => /\.(?:las|laz)$/i.test(path));
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
        'builder:viewing-box',
        viewingBoxClipVolume(state, previewCap),
      );
      drawViewingBoxOverlay(viewingBoxOverlayRef.current, hostRef.current, kernel, state);
      kernel.requestFrame();
    },
    [],
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
    if (!import.meta.env.DEV) return;
    const target = window as unknown as Record<string, unknown>;
    const key = '__hcadBuilderViewingBoxDebug';
    const previous = target[key];
    target[key] = {
      placeAtCameraTarget(): void {
        const cameraTarget = kernelRef.current?.camera.worldCamera().target;
        if (cameraTarget) callbacksRef.current.onViewportPoint?.(cameraTarget);
      },
      remove(): void {
        viewingBoxRef.current = null;
        kernelRef.current?.session.setScopedClipVolume('builder:viewing-box', null);
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
              rings: geometry.rings,
            }
          : null;
      },
    };
    return () => {
      if (previous === undefined) delete target[key];
      else target[key] = previous;
    };
  }, []);

  const handleViewingBoxPointerDown = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      if (placingViewingBoxCenter || event.button !== 0) return;
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
              moved: false,
            };
      setViewingBoxCursor('grabbing');
    },
    [placingViewingBoxCenter],
  );

  const handleViewingBoxPointerMove = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      const interaction = viewingBoxInteractionRef.current;
      if (!interaction) {
        if (placingViewingBoxCenter) return;
        const state = viewingBoxRef.current;
        const host = hostRef.current;
        const kernel = kernelRef.current;
        const nextCursor =
          state && host && kernel
            ? hitTestViewingBoxHandle(
                viewingBoxOverlayGeometry(host, kernel, state),
                eventPoint(event, host),
              )
              ? 'grab'
              : 'default'
            : 'default';
        setViewingBoxCursor((current) => (current === nextCursor ? current : nextCursor));
        return;
      }
      if (interaction.pointerId !== event.pointerId) return;
      event.preventDefault();
      event.stopPropagation();
      const deltaX = event.clientX - interaction.startClientX;
      const deltaY = event.clientY - interaction.startClientY;
      if (Math.hypot(deltaX, deltaY) >= 4) interaction.moved = true;
      if (interaction.kind === 'face') {
        const signedDelta =
          (deltaX * interaction.handle.screenAxis.x + deltaY * interaction.handle.screenAxis.y) /
          interaction.handle.pixelsPerWorldUnit;
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
    [placingViewingBoxCenter, previewViewingBox],
  );

  const finishViewingBoxInteraction = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      const interaction = viewingBoxInteractionRef.current;
      if (!interaction || interaction.pointerId !== event.pointerId) return;
      event.preventDefault();
      event.stopPropagation();
      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId);
      }
      viewingBoxInteractionRef.current = null;
      kernelRef.current?.setInteracting(false);
      if (!interaction.moved && event.type !== 'pointercancel') {
        commitViewingBox(
          setViewingBoxMode(
            viewingBoxRef.current ?? interaction.startState,
            interaction.kind === 'face' ? 'rotate' : 'resize',
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

  return (
    <div
      ref={hostRef}
      className={placingViewingBoxCenter ? `${styles.root} ${styles.placingCenter}` : styles.root}
      style={placingViewingBoxCenter ? undefined : { cursor: viewingBoxCursor }}
      onPointerDownCapture={handleViewingBoxPointerDown}
      onPointerMoveCapture={(event) => {
        pointerPositionRef.current = { x: event.clientX, y: event.clientY };
        handleViewingBoxPointerMove(event);
      }}
      onPointerUpCapture={finishViewingBoxInteraction}
      onPointerCancelCapture={finishViewingBoxInteraction}
      onPointerUp={(event) => {
        if (event.button !== 0 || !placingViewingBoxCenter) return;
        const position =
          activeSourcePositionRef.current ?? kernelRef.current?.camera.worldCamera().target;
        if (position) callbacksRef.current.onViewportPoint?.(position);
      }}
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
          isPickable: (candidate) =>
            callbacksRef.current.isEntityClickPickable?.(candidate.address.entityId as EntityId) ??
            true,
          isSelected: (candidate) =>
            callbacksRef.current.selectedEntityIds.has(candidate.address.entityId as EntityId),
          hasSelection: () => callbacksRef.current.selectedEntityIds.size > 0,
          select: (candidate) =>
            callbacksRef.current.onSelectEntity?.(
              candidate.address.entityId as EntityId,
              'replace',
            ),
          toggleSelection: (candidate) =>
            callbacksRef.current.onSelectEntity?.(candidate.address.entityId as EntityId, 'toggle'),
          clearSelection: () => callbacksRef.current.onClearSelection?.(),
          candidateSetChanged: (candidates, index) =>
            callbacksRef.current.onCandidateSet?.(candidates, index),
          candidateSetCleared: () => callbacksRef.current.onCandidateSetClear?.(),
          openContextSurface: (candidate) =>
            callbacksRef.current.onContextSurface?.(candidate, pointerPositionRef.current),
          routeRegistryShortcut: (event) => callbacksRef.current.onRegistryShortcut?.(event),
        }}
        onFrame={() =>
          drawViewingBoxOverlay(
            viewingBoxOverlayRef.current,
            hostRef.current,
            kernelRef.current,
            viewingBoxRef.current,
          )
        }
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
      {dragging ? <div className={styles.dropOverlay}>Drop LAS / LAZ to import</div> : null}
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
  const foreground = computed.getPropertyValue('--hc-fg-strong').trim() || computed.color;
  context.save();
  context.lineWidth = 1.25;
  context.globalAlpha = state.enabled ? 0.92 : 0.58;
  context.strokeStyle = state.enabled ? accent : foreground;
  context.setLineDash(state.enabled ? [5, 3] : [2, 4]);
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
  context.strokeStyle = accent;
  context.fillStyle = foreground;
  if (state.mode === 'rotate') {
    for (const [index, ring] of geometry.rings.entries()) {
      context.lineWidth = index === 0 ? 2.25 : 1.8;
      context.setLineDash(index === 0 ? [] : index === 1 ? [7, 3] : [2, 3]);
      drawPolyline(context, ring.points, true);
    }
    context.setLineDash([]);
  } else {
    for (const handle of geometry.faces) {
      drawInwardFaceArrow(context, handle.point, geometry.center);
    }
  }
  context.restore();
}

interface ViewingBoxOverlayGeometry {
  readonly corners: readonly (ScreenPoint | null)[];
  readonly center: ScreenPoint;
  readonly faces: readonly ViewingBoxFaceHandle[];
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
        });
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
  return { corners, center, faces, rings };
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
  const presentationWidth = globalThis.innerWidth || hostRect.width;
  const presentationHeight = globalThis.innerHeight || hostRect.height;
  return {
    x: ((ndcX + 1) * presentationWidth) / 2 - hostRect.left,
    y: ((1 - ndcY) * presentationHeight) / 2 - hostRect.top,
  };
}

function drawInwardFaceArrow(
  context: CanvasRenderingContext2D,
  point: ScreenPoint,
  center: ScreenPoint,
): void {
  const towardCenter = normalizeScreenPoint({ x: center.x - point.x, y: center.y - point.y });
  const perpendicular = { x: -towardCenter.y, y: towardCenter.x };
  const tail = { x: point.x - towardCenter.x * 13, y: point.y - towardCenter.y * 13 };
  const tip = { x: point.x + towardCenter.x * 6, y: point.y + towardCenter.y * 6 };
  context.lineWidth = 2;
  context.beginPath();
  context.moveTo(tail.x, tail.y);
  context.lineTo(tip.x, tip.y);
  context.moveTo(tip.x, tip.y);
  context.lineTo(
    tip.x - towardCenter.x * 7 + perpendicular.x * 4,
    tip.y - towardCenter.y * 7 + perpendicular.y * 4,
  );
  context.moveTo(tip.x, tip.y);
  context.lineTo(
    tip.x - towardCenter.x * 7 - perpendicular.x * 4,
    tip.y - towardCenter.y * 7 - perpendicular.y * 4,
  );
  context.stroke();
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
  for (const handle of geometry.rings) {
    const distance = distanceToPolyline(point, handle.points);
    if (distance <= 9 && (!closest || distance < closest.distance)) closest = { handle, distance };
  }
  return closest?.handle ?? null;
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

function normalizeScreenPoint(point: ScreenPoint): ScreenPoint {
  const length = Math.hypot(point.x, point.y);
  return length > 1e-6 ? { x: point.x / length, y: point.y / length } : { x: 1, y: 0 };
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

function snapFromCandidate(candidate: KernelPickCandidate): SnapResult {
  return {
    position: candidate.worldPosition,
    kind: snapKind(candidate.snapKind),
    entity: candidate.address.entityId as EntityId,
    confidence: 1 / (1 + Math.max(0, candidate.pixelDistance)),
    source: 'point-cloud',
    distancePx: candidate.pixelDistance,
    stable: true,
    candidateId: `${candidate.address.renderProxyId}:${candidate.address.tileId ?? ''}:${String(candidate.address.primitiveId ?? '')}`,
  };
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

function BuilderHud({ kernelRef }: { readonly kernelRef: { readonly current: KernelViewportHandle | null } }): JSX.Element {
  const [snapshot, setSnapshot] = useState<KernelDiagnosticsSnapshot | null>(null);
  useEffect(() => {
    const update = (): void => { if (kernelRef.current) setSnapshot(kernelRef.current.session.diagnosticsWindow()); };
    update();
    const timer = window.setInterval(update, 250);
    return () => window.clearInterval(timer);
  }, [kernelRef]);
  const frame = snapshot?.lastFrames.at(-1);
  const reasons = frame?.deadlineReasonCodes.filter((reason) => reason !== 'within_target') ?? [];
  const budget = reasons.map((reason) => reason === 'gpu_deadline' ? 'gpu' : reason === 'cpu_deadline' ? 'cpu' : reason).join(', ') || (frame ? 'within target' : '—');
  return <ViewportHud p95={snapshot?.presentedFrameIntervalMs?.p95 ?? null}
    p50={snapshot?.presentedFrameIntervalMs?.p50 ?? null} points={frame?.primitives.points ?? null}
    targetMs={kernelRef.current?.session.hardwarePolicy.frame.targetFrameMs ?? Infinity}
    quality={null} budget={budget}
    backlog={frame ? frame.requestBacklog + frame.decodeBacklog + frame.uploadBacklog : null} />;
}

interface CameraHistoryState { readonly camera: KernelWorldCamera; readonly mode: KernelViewMode }
function parseCameraHistory(input: unknown): CameraHistoryState {
  const state = input as CameraHistoryState;
  if (!state || !['3d', '2d', '2.5d'].includes(state.mode)) throw new TypeError('Invalid camera history mode');
  new KernelCameraController(1, 1).adoptWorldCamera(state.camera);
  return state;
}
