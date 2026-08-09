import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
  type DragEvent,
} from 'react';

import type { EntityId, SnapKind, SnapResult, SourcePosition3, Vec3 } from '@himmelcad/data';
import { OverlayChip } from '@himmelcad/ui';
import {
  type CanonicalEntity,
  type CanonicalRepresentationAdmission,
  type GeometryObject,
  type HimmelcadViewerWasmLoader,
  type KernelPickCandidate,
  type KernelCanonicalRenderAdmission,
  type KernelClipVolume,
  type KernelRgbaCaptureRequest,
  type KernelRgbaCaptureResult,
  type KernelRenderStyle,
  type KernelViewingBoxState,
  type KernelViewMode,
  type KernelWorldCamera,
  type KernelWorldPoint,
  type Representation,
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
  frameAll(): void;
  setPointSize(pointSize: number): void;
  setViewMode(mode: KernelViewMode): Promise<void>;
  worldCamera(): KernelWorldCamera | null;
  adoptWorldCamera(camera: KernelWorldCamera): KernelWorldCamera;
  waitForNextPresentedFrame(): Promise<void>;
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
  readonly pointSize: number;
  readonly onCursorSnap: (snap: SnapResult | null) => void;
  readonly onDropFiles: (paths: string[]) => void | Promise<void>;
  readonly onLog: (level: 'debug' | 'info' | 'warn' | 'error', message: string) => void;
  readonly viewingBox?: KernelViewingBoxState | null;
  readonly placingViewingBoxCenter?: boolean;
  readonly onViewportPoint?: (position: SourcePosition3) => void;
}

export const BuilderKernelViewport = forwardRef<
  BuilderKernelViewportHandle,
  BuilderKernelViewportProps
>(function BuilderKernelViewport(
  {
    pointSize,
    onCursorSnap,
    onDropFiles,
    onLog,
    viewingBox = null,
    placingViewingBoxCenter = false,
    onViewportPoint,
  },
  ref,
): JSX.Element {
  const kernelRef = useRef<KernelViewportHandle | null>(null);
  const hostRef = useRef<HTMLDivElement | null>(null);
  const viewingBoxOverlayRef = useRef<HTMLCanvasElement | null>(null);
  const readyRef = useRef(createDeferred<KernelViewportHandle>());
  const loadedBoundsRef = useRef<Bounds | null>(null);
  const entityStylesRef = useRef(new Map<EntityId, KernelRenderStyle>());
  const entityExaggerationDatumsRef = useRef(new Map<EntityId, number>());
  const callbacksRef = useRef({ onCursorSnap, onDropFiles, onLog, onViewportPoint });
  const activeSourcePositionRef = useRef<SourcePosition3 | null>(null);
  const pointSizeRef = useRef(pointSize);
  const viewModeRef = useRef<KernelViewMode>('3d');
  const automationClipIdsRef = useRef(new Set<string>());
  callbacksRef.current = { onCursorSnap, onDropFiles, onLog, onViewportPoint };
  const [cursor, setCursor] = useState<SourcePosition3 | null>(null);
  const [viewMode, setViewModeState] = useState<KernelViewMode>('3d');
  const [dragging, setDragging] = useState(false);

  useEffect(() => {
    pointSizeRef.current = pointSize;
    kernelRef.current?.session.setPointSize(pointSize);
  }, [pointSize]);

  useEffect(() => {
    drawViewingBoxOverlay(
      viewingBoxOverlayRef.current,
      hostRef.current,
      kernelRef.current,
      viewingBox,
    );
  }, [viewingBox]);

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
  }, []);

  const changeViewMode = useCallback(async (mode: KernelViewMode): Promise<void> => {
    viewModeRef.current = mode;
    setViewModeState(mode);
    await kernelRef.current?.session.setViewMode(mode).catch((error: unknown) => {
      callbacksRef.current.onLog('error', `View mode change failed: ${String(error)}`);
      throw error;
    });
  }, []);

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
        const supported = package_.admissions.filter(
          (admission) =>
            admission.resolvedGeometry.kind === 'surface3d' ||
            (admission.resolvedGeometry.kind === 'solid' &&
              admission.resolvedGeometry.solid.kind === 'extrusion'),
        );
        const unsupportedCount = package_.admissions.length - supported.length;
        if (unsupportedCount > 0) {
          callbacksRef.current.onLog(
            'warn',
            `IFC viewer projection skipped ${unsupportedCount.toLocaleString()} unsupported geometries`,
          );
        }
        if (supported.length === 0) return [];
        const admissions: KernelCanonicalRenderAdmission[] = supported.map((admission) => ({
          admission,
          style: IFC_STYLE,
        }));
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
      frameAll,
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
        return kernel.session.adoptWorldCamera(camera);
      },
      async waitForNextPresentedFrame() {
        const kernel = kernelRef.current;
        if (!kernel) throw new Error('viewer is not ready');
        await kernel.session.waitForNextPresentedFrame();
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
        for (const entityId of entityIds) kernel.scene.setEntityVisibility(entityId, visible);
        kernel.requestFrame();
      },
      setClipVolumes(volumes) {
        kernelRef.current?.session.setClipVolumes(volumes);
      },
      setAutomationClipVolumes(volumes) {
        const kernel = kernelRef.current;
        if (!kernel) throw new Error('viewer is not ready');
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
        const distance = Math.hypot(
          camera.eye.x - camera.target.x,
          camera.eye.y - camera.target.y,
          camera.eye.z - camera.target.z,
        );
        const visibleHeight =
          camera.projection.kind === 'orthographic'
            ? camera.projection.verticalSpan
            : 2 * distance * Math.tan(camera.projection.verticalFovRadians * 0.5);
        return viewingBoxFromViewport({
          center: target,
          visibleWidth: visibleHeight * camera.projection.aspect,
          visibleHeight,
          visibleDepth: Math.max(visibleHeight, distance * 0.5),
        });
      },
      setViewingBox(state) {
        kernelRef.current?.session.setScopedClipVolume(
          'builder:viewing-box',
          state ? viewingBoxClipVolume(state) : null,
        );
      },
    }),
    [changeViewMode, frameAll],
  );

  const handleReady = useCallback((handle: KernelViewportHandle) => {
    kernelRef.current = handle;
    if (import.meta.env.DEV) Object.assign(window, { __hcadBuilderKernel: handle });
    handle.session.setClearColor([0.008, 0.011, 0.016, 1]);
    handle.session.setPointSize(pointSizeRef.current);
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

  return (
    <div
      ref={hostRef}
      className={placingViewingBoxCenter ? `${styles.root} ${styles.placingCenter}` : styles.root}
      onPointerUp={(event) => {
        if (event.button !== 0 || !placingViewingBoxCenter) return;
        const position = activeSourcePositionRef.current;
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
        onActivePick={handlePick}
        onCursorCoordinate={handleCursor}
        onFrame={() =>
          drawViewingBoxOverlay(
            viewingBoxOverlayRef.current,
            hostRef.current,
            kernelRef.current,
            viewingBox,
          )
        }
        onError={handleError}
      />
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

  const camera = kernel.camera.worldCamera();
  const [axisX, axisY, axisZ] = viewingBoxAxes(state);
  const corners = [-1, 1].flatMap((x) =>
    [-1, 1].flatMap((y) =>
      [-1, 1].map((z) => ({
        x:
          state.center.x +
          x * axisX.x * state.halfExtents.x +
          y * axisY.x * state.halfExtents.y +
          z * axisZ.x * state.halfExtents.z,
        y:
          state.center.y +
          x * axisX.y * state.halfExtents.x +
          y * axisY.y * state.halfExtents.y +
          z * axisZ.y * state.halfExtents.z,
        z:
          state.center.z +
          x * axisX.z * state.halfExtents.x +
          y * axisY.z * state.halfExtents.y +
          z * axisZ.z * state.halfExtents.z,
      })),
    ),
  );
  const projected = corners.map((corner) => projectViewingBoxPoint(corner, camera, rect));
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
  context.save();
  context.lineWidth = 1.25;
  context.strokeStyle = state.enabled ? 'rgba(88, 203, 255, 0.92)' : 'rgba(150, 160, 170, 0.72)';
  context.setLineDash(state.enabled ? [5, 3] : [2, 4]);
  context.beginPath();
  for (const [fromIndex, toIndex] of edges) {
    const from = projected[fromIndex];
    const to = projected[toIndex];
    if (!from || !to) continue;
    context.moveTo(from.x, from.y);
    context.lineTo(to.x, to.y);
  }
  context.stroke();
  context.setLineDash([]);
  if (state.mode === 'resize') {
    context.fillStyle = 'rgba(230, 248, 255, 0.96)';
    for (const point of projected) {
      if (point) context.fillRect(point.x - 2.5, point.y - 2.5, 5, 5);
    }
  }
  const center = projectViewingBoxPoint(state.center, camera, rect);
  if (center) drawViewingBoxModeGlyph(context, center.x, center.y, state.mode);
  context.restore();
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

function drawViewingBoxModeGlyph(
  context: CanvasRenderingContext2D,
  x: number,
  y: number,
  mode: KernelViewingBoxState['mode'],
): void {
  context.strokeStyle = 'rgba(244, 250, 255, 0.96)';
  context.fillStyle = 'rgba(10, 25, 35, 0.78)';
  context.lineWidth = 1.4;
  context.beginPath();
  context.arc(x, y, mode === 'rotate' ? 11 : 7, 0, Math.PI * 2);
  context.fill();
  context.stroke();
  if (mode === 'rotate') {
    context.beginPath();
    context.arc(x, y, 15, -Math.PI * 0.75, Math.PI * 0.55);
    context.stroke();
  } else {
    context.beginPath();
    context.moveTo(x - 13, y);
    context.lineTo(x + 13, y);
    context.moveTo(x, y - 13);
    context.lineTo(x, y + 13);
    context.stroke();
  }
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
