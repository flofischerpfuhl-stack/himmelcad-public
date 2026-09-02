import type {
  AlignedGcpCameraRecord,
  DiscoveredPhoto,
  EntityId,
  GcpCollectionRecord,
  GcpLocalEstimateArtifact,
  GcpObservationEdit,
  GcpOptimizationPublicationRecord,
  ImageMaskEdit,
  ImageProductTag,
  ListedImageMaskRevision,
  ObjectHash,
  PhotoImportBatch,
  ProjectCameraImageRecord,
} from '@himmelcad/data';
import { OverlayChip, Select } from '@himmelcad/ui';
import {
  Brush,
  Crosshair,
  Eraser,
  Image as ImageIcon,
  Layers3,
  LoaderCircle,
  Maximize2,
  Minus,
  Plus,
  Trash2,
} from 'lucide-react';
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type WheelEvent as ReactWheelEvent,
} from 'react';

import {
  GcpImageMarkerOverlay,
  type GcpImageMarker,
  type GcpManualMeasurement,
} from './GcpImageMarkerOverlay.js';
import styles from './ImageWorkspace.module.css';

type ImageLayer = 'original' | 'depth' | 'confidence' | 'normals';

export interface ImageWorkspaceProps {
  batch: PhotoImportBatch | null;
  projectImages: readonly ProjectCameraImageRecord[];
  imageMasks: readonly ListedImageMaskRevision[];
  alignedCameras: readonly AlignedGcpCameraRecord[];
  gcpCollection: GcpCollectionRecord | null;
  gcpOptimization: GcpOptimizationPublicationRecord | null;
  gcpLocalEstimates: readonly GcpLocalEstimateArtifact[];
  focusedGcpId: string | null;
  onCommitGcpMeasurement: (measurement: GcpManualMeasurement) => Promise<boolean>;
  onEditGcpObservation: (marker: GcpImageMarker, edit: GcpObservationEdit) => void;
  onEditImageMask: (
    imageEntityId: EntityId,
    expectedRevisionSha256: ObjectHash | undefined,
    edit: ImageMaskEdit,
  ) => Promise<void>;
  depthDatasets: readonly { relativePath: string }[];
  selectedImageEntityId: EntityId | null;
  onSelectProjectImage: (entityId: EntityId) => void;
  onError: (message: string) => void;
}

interface MvsDepthTileRecord {
  key: { imageId: string; level: number; x: number; y: number };
  relativePath: string;
  width: number;
  height: number;
}

interface MvsDepthImageRecord {
  imageId: string;
  width: number;
  height: number;
  camera: { fx: number; fy: number; cx: number; cy: number; worldToCamera: number[] };
  tiles: MvsDepthTileRecord[];
}

interface MvsOutputIndex {
  depthImages: MvsDepthImageRecord[];
}

export function ImageWorkspace({
  batch,
  projectImages,
  imageMasks,
  alignedCameras,
  gcpCollection,
  gcpOptimization,
  gcpLocalEstimates,
  focusedGcpId,
  onCommitGcpMeasurement,
  onEditGcpObservation,
  onEditImageMask,
  depthDatasets,
  selectedImageEntityId,
  onSelectProjectImage,
  onError,
}: ImageWorkspaceProps): JSX.Element {
  const rootRef = useRef<HTMLElement>(null);
  const [depthProduct, setDepthProduct] = useState<{
    index: MvsOutputIndex;
    basePath: string;
  } | null>(null);
  useEffect(() => {
    const latest = depthDatasets.at(-1);
    if (!latest) {
      setDepthProduct(null);
      return;
    }
    const controller = new AbortController();
    void fetch(projectProductUrl(latest.relativePath), { signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error(`Depth index HTTP ${response.status}`);
        const index = (await response.json()) as MvsOutputIndex;
        setDepthProduct({
          index,
          basePath: latest.relativePath.replace(/[^/]+$/, ''),
        });
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted) {
          setDepthProduct(null);
          onError(`Depth product could not be loaded: ${String(error)}`);
        }
      });
    return () => controller.abort();
  }, [depthDatasets, onError]);
  const allPhotos = useMemo(
    () =>
      projectImages.length > 0
        ? projectImages.map((record) => record.metadata.inspectedPhoto)
        : (batch?.photos.filter((photo) => photo.duplicateOf == null) ?? []),
    [batch, projectImages],
  );
  const relevantCameraIds = useMemo(() => {
    if (!focusedGcpId) return null;
    const ids = new Set<number>();
    for (const observation of gcpCollection?.observations ?? []) {
      if (observation.pointId === focusedGcpId) ids.add(observation.imageId);
    }
    for (const projection of gcpOptimization?.artifact.result.projections ?? []) {
      if (projection.pointId === focusedGcpId) ids.add(projection.imageId);
    }
    for (const artifact of gcpLocalEstimates) {
      if (artifact.estimate.pointId !== focusedGcpId) continue;
      for (const projection of artifact.estimate.projections) ids.add(projection.imageId);
    }
    const point = gcpCollection?.points.find(({ point }) => point.id === focusedGcpId)?.point;
    if (point) {
      const imagesByEntity = new Map(projectImages.map((image) => [image.entityId, image]));
      for (const camera of alignedCameras) {
        const image = imagesByEntity.get(camera.entityId);
        if (image && initialGcpProjection(camera, image, point.coordinate)) ids.add(camera.imageId);
      }
    }
    return ids;
  }, [
    alignedCameras,
    focusedGcpId,
    gcpCollection,
    gcpLocalEstimates,
    gcpOptimization,
    projectImages,
  ]);
  const photos = useMemo(() => {
    if (!relevantCameraIds) return allPhotos;
    const hashes = new Set(
      alignedCameras
        .filter((camera) => relevantCameraIds.has(camera.imageId))
        .map((camera) => camera.sourceObjectHash),
    );
    return allPhotos.filter((photo) => hashes.has(photo.sha256));
  }, [alignedCameras, allPhotos, relevantCameraIds]);
  const tagsByHash = useMemo(
    () =>
      new Map(
        projectImages.map((record) => [
          record.metadata.sourceObjectHash,
          record.metadata.statusTags,
        ]),
      ),
    [projectImages],
  );
  const [layer, setLayer] = useState<ImageLayer>('original');
  const selectedProjectImage = useMemo(
    () => projectImages.find((image) => image.entityId === selectedImageEntityId) ?? null,
    [projectImages, selectedImageEntityId],
  );
  const selected = useMemo(() => {
    if (selectedProjectImage) {
      const selectedHash = selectedProjectImage.metadata.sourceObjectHash;
      const controlledPhoto = allPhotos.find((photo) => photo.sha256 === selectedHash);
      if (controlledPhoto) return controlledPhoto;
    }
    return photos[0] ?? null;
  }, [allPhotos, photos, selectedProjectImage]);
  const navigationPhotos = useMemo(() => {
    if (!selected || photos.includes(selected)) return photos;
    return [selected, ...photos];
  }, [photos, selected]);
  const selectPhoto = useCallback(
    (photo: DiscoveredPhoto): void => {
      const record = projectImages.find(
        (image) => image.metadata.sourceObjectHash === photo.sha256,
      );
      if (record) onSelectProjectImage(record.entityId);
    },
    [onSelectProjectImage, projectImages],
  );

  useEffect(() => {
    const navigate = (event: KeyboardEvent): void => {
      if (
        event.defaultPrevented ||
        event.altKey ||
        event.ctrlKey ||
        event.metaKey ||
        event.isComposing ||
        keyboardTargetOwnsNavigation(event.target) ||
        document.querySelector('[data-task-drag-handle]')
      ) {
        return;
      }
      const root = rootRef.current;
      if (!root || root.getClientRects().length === 0 || navigationPhotos.length === 0) return;
      const currentIndex = selected ? navigationPhotos.indexOf(selected) : -1;
      let nextIndex: number | null = null;
      if (event.key === 'ArrowLeft') nextIndex = Math.max(0, currentIndex - 1);
      if (event.key === 'ArrowRight')
        nextIndex = Math.min(navigationPhotos.length - 1, Math.max(0, currentIndex + 1));
      if (event.key === 'Home') nextIndex = 0;
      if (event.key === 'End') nextIndex = navigationPhotos.length - 1;
      if (nextIndex == null || nextIndex === currentIndex) return;
      const nextPhoto = navigationPhotos[nextIndex];
      if (!nextPhoto) return;
      event.preventDefault();
      selectPhoto(nextPhoto);
    };
    window.addEventListener('keydown', navigate);
    return () => window.removeEventListener('keydown', navigate);
  }, [navigationPhotos, selectPhoto, selected]);

  return (
    <section ref={rootRef} className={styles.root} aria-label="Image and depth-map view">
      <div className={styles.stage}>
        <div className={styles.layerToolbar} aria-label="Image layer">
          {(['original', 'depth', 'confidence', 'normals'] as const).map((candidate) => (
            <OverlayChip
              key={candidate}
              as="button"
              active={layer === candidate}
              onClick={() => setLayer(candidate)}
            >
              {layerLabel(candidate)}
            </OverlayChip>
          ))}
        </div>
        {selected ? (
          <ImageLayerContent
            photo={selected}
            layer={layer}
            tags={tagsByHash.get(selected.sha256)}
            camera={alignedCameras.find((entry) => entry.sourceObjectHash === selected.sha256)}
            projectImage={projectImages.find(
              (entry) => entry.metadata.sourceObjectHash === selected.sha256,
            )}
            imageMask={imageMasks.find(
              (entry) =>
                entry.imageEntityId ===
                projectImages.find((image) => image.metadata.sourceObjectHash === selected.sha256)
                  ?.entityId,
            )}
            gcpCollection={gcpCollection}
            gcpOptimization={gcpOptimization}
            gcpLocalEstimates={gcpLocalEstimates}
            focusedGcpId={focusedGcpId}
            onCommitGcpMeasurement={onCommitGcpMeasurement}
            onEditGcpObservation={onEditGcpObservation}
            onEditImageMask={onEditImageMask}
            depthProduct={depthProduct}
            onError={onError}
          />
        ) : (
          <div className={styles.empty}>
            <ImageIcon size={34} />
            <strong>No images in this workspace yet</strong>
            <span>Imported originals and measurable depth maps appear here.</span>
          </div>
        )}
      </div>
    </section>
  );
}

function ImageLayerContent({
  photo,
  layer,
  tags,
  camera,
  projectImage,
  imageMask,
  gcpCollection,
  gcpOptimization,
  gcpLocalEstimates,
  focusedGcpId,
  onCommitGcpMeasurement,
  onEditGcpObservation,
  onEditImageMask,
  depthProduct,
  onError,
}: {
  photo: DiscoveredPhoto;
  layer: ImageLayer;
  tags: readonly ImageProductTag[] | undefined;
  camera: AlignedGcpCameraRecord | undefined;
  projectImage: ProjectCameraImageRecord | undefined;
  imageMask: ListedImageMaskRevision | undefined;
  gcpCollection: GcpCollectionRecord | null;
  gcpOptimization: GcpOptimizationPublicationRecord | null;
  gcpLocalEstimates: readonly GcpLocalEstimateArtifact[];
  focusedGcpId: string | null;
  onCommitGcpMeasurement: (measurement: GcpManualMeasurement) => Promise<boolean>;
  onEditGcpObservation: (marker: GcpImageMarker, edit: GcpObservationEdit) => void;
  onEditImageMask: ImageWorkspaceProps['onEditImageMask'];
  depthProduct: { index: MvsOutputIndex; basePath: string } | null;
  onError: (message: string) => void;
}) {
  const [loadFailed, setLoadFailed] = useState(false);
  useEffect(() => setLoadFailed(false), [photo.sha256]);

  if (layer !== 'original') {
    const ready = tags?.includes('depthReady') === true && !tags.includes('depthStale');
    const depthImage = camera
      ? depthProduct?.index.depthImages.find(
          (candidate) => Number(candidate.imageId) === camera.imageId,
        )
      : undefined;
    if (ready && depthImage && depthProduct) {
      return (
        <DepthCanvas
          image={depthImage}
          basePath={depthProduct.basePath}
          layer={layer}
          onError={onError}
        />
      );
    }
    return (
      <div className={styles.empty}>
        <Layers3 size={34} />
        <strong>
          {ready ? `Loading ${layerLabel(layer)}` : `${layerLabel(layer)} has not been generated`}
        </strong>
        <span>
          {ready ? 'Preparing measurable depth tiles.' : 'Run Depth Maps to enable this layer.'}
        </span>
      </div>
    );
  }
  // Inspection batches describe source files before their content-addressed objects exist.
  // Requesting the project URL here raced the atomic commit, emitted a false load error, and
  // could cache the pre-commit 404. Only committed project records may use hcad-image://.
  if (!projectImage)
    return <ImageMetadataCard photo={photo} status="Validated · not imported yet" />;
  if (!loadFailed) {
    const dimensions = photo.metadata.exif.dimensions;
    const markers = camera
      ? markersForCamera(camera, projectImage, gcpCollection, gcpOptimization, gcpLocalEstimates)
      : [];
    const focusedGcpNeedsObservation =
      camera != null &&
      focusedGcpId != null &&
      gcpCollection?.points.some(({ point }) => point.id === focusedGcpId) === true &&
      !gcpCollection.observations.some(
        (observation) =>
          observation.imageId === camera.imageId && observation.pointId === focusedGcpId,
      );
    return (
      <div className={styles.imageCanvas}>
        <ImageContentFrame
          source={`hcad-image://project/${photo.sha256}?format=${photo.format}`}
          previewSource={`hcad-image://project/${photo.sha256}?format=${photo.format}&preview=1`}
          alt={fileName(photo)}
          width={camera?.camera.widthPixels ?? dimensions?.widthPixels ?? 1}
          height={camera?.camera.heightPixels ?? dimensions?.heightPixels ?? 1}
          markers={markers}
          gcpPoints={
            gcpCollection?.points.map(({ point }) => ({ id: point.id, name: point.name })) ?? []
          }
          imageId={camera?.imageId}
          imageEntityId={projectImage?.entityId}
          imageMask={imageMask}
          focusedGcpId={focusedGcpId}
          focusedGcpNeedsObservation={focusedGcpNeedsObservation}
          onError={() => {
            setLoadFailed(true);
            onError(`Image could not be loaded: ${fileName(photo)}`);
          }}
          onMaskError={(message) => onError(`Image mask could not be loaded: ${message}`)}
          onCommitGcpMeasurement={onCommitGcpMeasurement}
          onEditGcpObservation={onEditGcpObservation}
          onEditImageMask={onEditImageMask}
        />
        <span title={photo.sourcePath}>{fileName(photo)}</span>
      </div>
    );
  }
  return <ImageMetadataCard photo={photo} status="Image source is unavailable" />;
}

function ImageMetadataCard({ photo, status }: { photo: DiscoveredPhoto; status: string }) {
  return (
    <div className={styles.metadataCard}>
      <ImageIcon size={38} />
      <h2>{fileName(photo)}</h2>
      <p>{photo.sourcePath}</p>
      <dl>
        <div>
          <dt>Size</dt>
          <dd>{photo.byteSize.toLocaleString('en-US')} bytes</dd>
        </div>
        <div>
          <dt>Camera</dt>
          <dd>{cameraName(photo)}</dd>
        </div>
        <div>
          <dt>GPS</dt>
          <dd>{hasPhotoPosition(photo) ? 'available' : '—'}</dd>
        </div>
        <div>
          <dt>RTK / DJI</dt>
          <dd>
            {photo.metadata.djiXmp.rtk
              ? `Flag ${photo.metadata.djiXmp.rtk.flag ?? '—'} · quality values available`
              : '—'}
          </dd>
        </div>
        <div>
          <dt>Status</dt>
          <dd>{status}</dd>
        </div>
      </dl>
      <span className={styles.previewNotice}>
        The original is not in the project object store yet or requires a RAW/TIFF decoder.
      </span>
    </div>
  );
}

function DepthCanvas({
  image,
  basePath,
  layer,
  onError,
}: {
  image: MvsDepthImageRecord;
  basePath: string;
  layer: Exclude<ImageLayer, 'original'>;
  onError: (message: string) => void;
}): JSX.Element {
  const hostRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const depthRef = useRef<{
    values: Float32Array;
    confidence: Float32Array;
    width: number;
    height: number;
  } | null>(null);
  const [status, setStatus] = useState('Streaming depth tiles…');
  const [measurement, setMeasurement] = useState<string | null>(null);
  const [canvasSize, setCanvasSize] = useState({ width: 1, height: 1 });
  const transformRef = useRef<ImageViewTransform>({ scale: 1, x: 0, y: 0 });
  const [transform, setTransformState] = useState<ImageViewTransform>(transformRef.current);
  const drag = useRef<{
    pointerId: number;
    x: number;
    y: number;
    transformX: number;
    transformY: number;
    moved: boolean;
  } | null>(null);
  const suppressMeasurement = useRef(false);
  const commitTransform = useCallback((next: ImageViewTransform): void => {
    transformRef.current = next;
    setTransformState(next);
  }, []);
  const fit = useCallback((): void => {
    const host = hostRef.current;
    if (!host) return;
    const bounds = host.getBoundingClientRect();
    if (bounds.width <= 0 || bounds.height <= 0) return;
    const scale = clampImageScale(
      Math.min(bounds.width / canvasSize.width, bounds.height / canvasSize.height),
    );
    commitTransform({
      scale,
      x: (bounds.width - canvasSize.width * scale) / 2,
      y: (bounds.height - canvasSize.height * scale) / 2,
    });
  }, [canvasSize.height, canvasSize.width, commitTransform]);
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const observer = new ResizeObserver(fit);
    observer.observe(host);
    const animationFrame = requestAnimationFrame(fit);
    return () => {
      cancelAnimationFrame(animationFrame);
      observer.disconnect();
    };
  }, [fit]);
  useEffect(() => {
    const controller = new AbortController();
    const availableLevels = [...new Set(image.tiles.map((tile) => tile.key.level))].sort(
      (a, b) => a - b,
    );
    const targetLevel =
      availableLevels.find((level) => Math.max(image.width, image.height) / 2 ** level <= 2048) ??
      availableLevels.at(-1) ??
      0;
    const tiles = image.tiles.filter((tile) => tile.key.level === targetLevel);
    void Promise.all(
      tiles.map(async (tile) => {
        const response = await fetch(projectProductUrl(`${basePath}${tile.relativePath}`), {
          signal: controller.signal,
        });
        if (!response.ok) throw new Error(`Depth tile HTTP ${response.status}`);
        return { tile, decoded: decodeDepthTile(await response.arrayBuffer()) };
      }),
    )
      .then((loaded) => {
        if (controller.signal.aborted) return;
        const tileSize = Math.max(
          1,
          ...loaded.map(({ tile }) => Math.max(tile.width, tile.height)),
        );
        const width = Math.max(...loaded.map(({ tile }) => tile.key.x * tileSize + tile.width));
        const height = Math.max(...loaded.map(({ tile }) => tile.key.y * tileSize + tile.height));
        const values = new Float32Array(width * height);
        const confidence = new Float32Array(width * height);
        for (const { tile, decoded } of loaded) {
          for (let y = 0; y < tile.height; y += 1) {
            const target = (tile.key.y * tileSize + y) * width + tile.key.x * tileSize;
            const source = y * tile.width;
            values.set(decoded.depth.subarray(source, source + tile.width), target);
            confidence.set(decoded.confidence.subarray(source, source + tile.width), target);
          }
        }
        depthRef.current = { values, confidence, width, height };
        drawDepthLayer(canvasRef.current, values, confidence, width, height, layer);
        setCanvasSize({ width, height });
        setStatus(`Level ${targetLevel} · ${loaded.length} tiles · click to measure`);
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted) {
          const message = `Depth map could not be loaded: ${String(error)}`;
          setStatus(message);
          onError(message);
        }
      });
    return () => controller.abort();
  }, [basePath, image, layer, onError]);

  const measure = (event: ReactMouseEvent<HTMLCanvasElement>) => {
    if (suppressMeasurement.current) {
      suppressMeasurement.current = false;
      return;
    }
    const data = depthRef.current;
    const canvas = canvasRef.current;
    if (!data || !canvas) return;
    const bounds = canvas.getBoundingClientRect();
    const x = Math.min(
      data.width - 1,
      Math.max(0, Math.floor(((event.clientX - bounds.left) / bounds.width) * data.width)),
    );
    const y = Math.min(
      data.height - 1,
      Math.max(0, Math.floor(((event.clientY - bounds.top) / bounds.height) * data.height)),
    );
    const offset = y * data.width + x;
    const depth = data.values[offset] ?? 0;
    if (depth <= 0) {
      setMeasurement('No valid depth value at this location');
      return;
    }
    const pixelX = ((x + 0.5) / data.width) * image.width;
    const pixelY = ((y + 0.5) / data.height) * image.height;
    const world = backprojectWorld(image.camera, pixelX, pixelY, depth);
    setMeasurement(
      `X ${formatCoordinate(world[0])} · Y ${formatCoordinate(world[1])} · Z ${formatCoordinate(world[2])} · C ${Math.round((data.confidence[offset] ?? 0) * 100)} %`,
    );
  };
  const setZoomAt = (nextValue: number, clientX?: number, clientY?: number): void => {
    const host = hostRef.current;
    if (!host) return;
    const current = transformRef.current;
    const nextScale = clampImageScale(nextValue);
    if (nextScale === current.scale) return;
    const bounds = host.getBoundingClientRect();
    const cursorX = clientX == null ? bounds.width / 2 : clientX - bounds.left;
    const cursorY = clientY == null ? bounds.height / 2 : clientY - bounds.top;
    const imageX = (cursorX - current.x) / current.scale;
    const imageY = (cursorY - current.y) / current.scale;
    commitTransform({
      scale: nextScale,
      x: cursorX - imageX * nextScale,
      y: cursorY - imageY * nextScale,
    });
  };
  const startPan = (event: ReactPointerEvent<HTMLDivElement>): void => {
    if (event.button !== 0 || pointerTargetOwnsInteraction(event.target)) return;
    const current = transformRef.current;
    drag.current = {
      pointerId: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      transformX: current.x,
      transformY: current.y,
      moved: false,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
  };
  const movePan = (event: ReactPointerEvent<HTMLDivElement>): void => {
    const current = drag.current;
    if (current?.pointerId !== event.pointerId) return;
    const deltaX = event.clientX - current.x;
    const deltaY = event.clientY - current.y;
    current.moved ||= Math.hypot(deltaX, deltaY) > 2;
    if (!current.moved) return;
    commitTransform({
      ...transformRef.current,
      x: current.transformX + deltaX,
      y: current.transformY + deltaY,
    });
  };
  const stopPan = (event: ReactPointerEvent<HTMLDivElement>): void => {
    const current = drag.current;
    if (current?.pointerId !== event.pointerId) return;
    suppressMeasurement.current = current.moved;
    drag.current = null;
    event.currentTarget.releasePointerCapture(event.pointerId);
  };
  return (
    <div
      ref={hostRef}
      className={styles.depthCanvas}
      onWheel={(event) => {
        event.preventDefault();
        setZoomAt(
          transformRef.current.scale * Math.exp(-event.deltaY * 0.0015),
          event.clientX,
          event.clientY,
        );
      }}
      onPointerDown={startPan}
      onPointerMove={movePan}
      onPointerUp={stopPan}
      onPointerCancel={stopPan}
      onDoubleClick={fit}
    >
      <div className={styles.zoomToolbar}>
        <OverlayChip
          as="button"
          onClick={() => setZoomAt(transformRef.current.scale / 1.5)}
          disabled={transform.scale <= MIN_IMAGE_SCALE}
          aria-label="Zoom out"
        >
          <Minus size={13} />
        </OverlayChip>
        <OverlayChip className={styles.zoomReadout} muted>
          {formatZoomPercentage(transform.scale)}
        </OverlayChip>
        <OverlayChip
          as="button"
          onClick={() => setZoomAt(transformRef.current.scale * 1.5)}
          disabled={transform.scale >= MAX_IMAGE_SCALE}
          aria-label="Zoom in"
        >
          <Plus size={13} />
        </OverlayChip>
        <OverlayChip as="button" onClick={fit} aria-label="Fit depth map">
          <Maximize2 size={13} />
        </OverlayChip>
      </div>
      <canvas
        ref={canvasRef}
        onClick={measure}
        style={{
          width: canvasSize.width,
          height: canvasSize.height,
          transform: `translate3d(${transform.x}px, ${transform.y}px, 0) scale(${transform.scale})`,
        }}
      />
      <span className={styles.depthStatus}>{measurement ?? status}</span>
    </div>
  );
}

function decodeDepthTile(buffer: ArrayBuffer): { depth: Float32Array; confidence: Float32Array } {
  const bytes = new Uint8Array(buffer);
  if (bytes.length < 40 || new TextDecoder().decode(bytes.subarray(0, 8)) !== 'HCDEPTH1') {
    throw new Error('invalid HCDEPTH1 header');
  }
  const view = new DataView(buffer);
  const width = view.getUint32(24, true);
  const height = view.getUint32(28, true);
  const count = width * height;
  if (bytes.length !== 40 + count * 8) throw new Error('incomplete depth tile');
  const depth = new Float32Array(count);
  const confidence = new Float32Array(count);
  for (let index = 0; index < count; index += 1) {
    depth[index] = view.getFloat32(40 + index * 8, true);
    confidence[index] = view.getFloat32(44 + index * 8, true);
  }
  return { depth, confidence };
}

function drawDepthLayer(
  canvas: HTMLCanvasElement | null,
  depth: Float32Array,
  confidence: Float32Array,
  width: number,
  height: number,
  layer: Exclude<ImageLayer, 'original'>,
): void {
  if (!canvas) return;
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d');
  if (!context) return;
  const output = context.createImageData(width, height);
  const valid: number[] = [];
  const sampleStride = Math.max(1, Math.floor(depth.length / 100_000));
  for (let index = 0; index < depth.length; index += sampleStride) {
    const value = depth[index] ?? 0;
    if (value > 0) valid.push(value);
  }
  valid.sort((a, b) => a - b);
  const minimum = valid[Math.floor(valid.length * 0.02)] ?? 0;
  const maximum = valid[Math.floor(valid.length * 0.98)] ?? minimum + 1;
  for (let index = 0; index < depth.length; index += 1) {
    const value = depth[index] ?? 0;
    const target = index * 4;
    if (value <= 0) {
      output.data[target + 3] = 0;
      continue;
    }
    if (layer === 'confidence') {
      const gray = Math.round((confidence[index] ?? 0) * 255);
      output.data[target] = gray;
      output.data[target + 1] = gray;
      output.data[target + 2] = gray;
    } else if (layer === 'normals') {
      const x = index % width;
      const y = Math.floor(index / width);
      const left = depth[y * width + Math.max(0, x - 1)] ?? value;
      const right = depth[y * width + Math.min(width - 1, x + 1)] ?? value;
      const top = depth[Math.max(0, y - 1) * width + x] ?? value;
      const bottom = depth[Math.min(height - 1, y + 1) * width + x] ?? value;
      const nx = left - right;
      const ny = top - bottom;
      const length = Math.hypot(nx, ny, 2) || 1;
      output.data[target] = Math.round(((nx / length) * 0.5 + 0.5) * 255);
      output.data[target + 1] = Math.round(((ny / length) * 0.5 + 0.5) * 255);
      output.data[target + 2] = Math.round(((2 / length) * 0.5 + 0.5) * 255);
    } else {
      const normalized = Math.max(0, Math.min(1, (value - minimum) / (maximum - minimum)));
      output.data[target] = Math.round(255 * normalized);
      output.data[target + 1] = Math.round(255 * (1 - Math.abs(normalized - 0.5) * 2));
      output.data[target + 2] = Math.round(255 * (1 - normalized));
    }
    output.data[target + 3] = 255;
  }
  context.putImageData(output, 0, 0);
}

function backprojectWorld(
  camera: MvsDepthImageRecord['camera'],
  xPixels: number,
  yPixels: number,
  depth: number,
): [number, number, number] {
  const cameraPoint = [
    ((xPixels - camera.cx) / camera.fx) * depth,
    ((yPixels - camera.cy) / camera.fy) * depth,
    depth,
  ];
  const matrix = camera.worldToCamera;
  const translated = [
    cameraPoint[0]! - matrix[3]!,
    cameraPoint[1]! - matrix[7]!,
    cameraPoint[2]! - matrix[11]!,
  ];
  return [
    matrix[0]! * translated[0]! + matrix[4]! * translated[1]! + matrix[8]! * translated[2]!,
    matrix[1]! * translated[0]! + matrix[5]! * translated[1]! + matrix[9]! * translated[2]!,
    matrix[2]! * translated[0]! + matrix[6]! * translated[1]! + matrix[10]! * translated[2]!,
  ];
}

function formatCoordinate(value: number): string {
  return value.toLocaleString('en-US', { minimumFractionDigits: 3, maximumFractionDigits: 3 });
}

function projectProductUrl(relativePath: string): string {
  return `hcad-product://project/${relativePath.split('/').map(encodeURIComponent).join('/')}`;
}

function ImageContentFrame({
  source,
  previewSource,
  alt,
  width,
  height,
  markers,
  gcpPoints,
  imageId,
  imageEntityId,
  imageMask,
  focusedGcpId,
  focusedGcpNeedsObservation,
  onError,
  onMaskError,
  onCommitGcpMeasurement,
  onEditGcpObservation,
  onEditImageMask,
}: {
  source: string;
  previewSource: string;
  alt: string;
  width: number;
  height: number;
  markers: readonly GcpImageMarker[];
  gcpPoints: readonly { id: string; name: string }[];
  imageId: number | undefined;
  imageEntityId: EntityId | undefined;
  imageMask: ListedImageMaskRevision | undefined;
  focusedGcpId: string | null;
  focusedGcpNeedsObservation: boolean;
  onError: () => void;
  onMaskError: (message: string) => void;
  onCommitGcpMeasurement: (measurement: GcpManualMeasurement) => Promise<boolean>;
  onEditGcpObservation: (marker: GcpImageMarker, edit: GcpObservationEdit) => void;
  onEditImageMask: ImageWorkspaceProps['onEditImageMask'];
}): JSX.Element {
  const [container, setContainer] = useState<HTMLDivElement | null>(null);
  const transformRef = useRef<ImageViewTransform>({ scale: 1, x: 0, y: 0 });
  const [transform, setTransformState] = useState<ImageViewTransform>(transformRef.current);
  const [maskTool, setMaskTool] = useState<'pan' | 'add' | 'remove'>('pan');
  const [maskRadius, setMaskRadius] = useState(36);
  const [maskBusy, setMaskBusy] = useState(false);
  const [activeStroke, setActiveStroke] = useState<readonly ImageMaskPoint[]>([]);
  const [fullResolutionReady, setFullResolutionReady] = useState(false);
  const [observationMenu, setObservationMenu] = useState<{
    x: number;
    y: number;
    coordinate: { xPixels: number; yPixels: number };
    pointId: string;
  } | null>(null);
  const [observationBusy, setObservationBusy] = useState(false);
  const [placeMarkerArmed, setPlaceMarkerArmed] = useState(false);
  const previousSourceRef = useRef<string | null>(null);
  const strokeRef = useRef<{ pointerId: number; points: ImageMaskPoint[] } | null>(null);
  const fitMode = useRef(true);
  const lastViewportSize = useRef({ width: 0, height: 0 });
  const drag = useRef<{
    pointerId: number;
    x: number;
    y: number;
    transformX: number;
    transformY: number;
  } | null>(null);
  const commitTransform = useCallback((next: ImageViewTransform): void => {
    transformRef.current = next;
    setTransformState(next);
  }, []);
  const fit = useCallback((): void => {
    if (!container) return;
    const bounds = container.getBoundingClientRect();
    if (bounds.width <= 0 || bounds.height <= 0) return;
    const scale = clampImageScale(Math.min(bounds.width / width, bounds.height / height));
    commitTransform({
      scale,
      x: (bounds.width - width * scale) / 2,
      y: (bounds.height - height * scale) / 2,
    });
    fitMode.current = true;
    lastViewportSize.current = { width: bounds.width, height: bounds.height };
  }, [commitTransform, container, height, width]);
  const focusedMarker = focusedGcpId
    ? markers.find((marker) => marker.pointId === focusedGcpId)
    : undefined;
  useEffect(() => {
    if (previousSourceRef.current === source) return;
    const hadPreviousImage = previousSourceRef.current !== null;
    previousSourceRef.current = source;
    setFullResolutionReady(false);
    const animationFrame = requestAnimationFrame(() => {
      if (!container) return;
      const bounds = container.getBoundingClientRect();
      if (bounds.width <= 0 || bounds.height <= 0) return;
      if (!hadPreviousImage || !focusedMarker) {
        fit();
        return;
      }
      const scale = transformRef.current.scale;
      commitTransform({
        scale,
        x: bounds.width / 2 - focusedMarker.coordinate.xPixels * scale,
        y: bounds.height / 2 - focusedMarker.coordinate.yPixels * scale,
      });
      fitMode.current = false;
      lastViewportSize.current = { width: bounds.width, height: bounds.height };
    });
    return () => cancelAnimationFrame(animationFrame);
  }, [commitTransform, container, fit, focusedMarker, source]);
  useEffect(() => {
    setObservationMenu(null);
    setPlaceMarkerArmed(false);
  }, [focusedGcpId, focusedGcpNeedsObservation, source]);
  useEffect(() => {
    if (!placeMarkerArmed) return;
    const disarmWithEscape = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopImmediatePropagation();
      setPlaceMarkerArmed(false);
    };
    window.addEventListener('keydown', disarmWithEscape, true);
    return () => window.removeEventListener('keydown', disarmWithEscape, true);
  }, [placeMarkerArmed]);
  useEffect(() => {
    if (!container) return;
    const update = () => {
      const bounds = container.getBoundingClientRect();
      const previous = lastViewportSize.current;
      if (fitMode.current || previous.width <= 0 || previous.height <= 0) {
        fit();
        return;
      }
      const current = transformRef.current;
      commitTransform({
        ...current,
        x: current.x + (bounds.width - previous.width) / 2,
        y: current.y + (bounds.height - previous.height) / 2,
      });
      lastViewportSize.current = { width: bounds.width, height: bounds.height };
    };
    const observer = new ResizeObserver(update);
    observer.observe(container);
    update();
    return () => observer.disconnect();
  }, [commitTransform, container, fit]);
  const setZoomAt = (nextValue: number, clientX?: number, clientY?: number): void => {
    if (!container) return;
    const current = transformRef.current;
    const nextScale = clampImageScale(nextValue);
    if (nextScale === current.scale) return;
    const bounds = container.getBoundingClientRect();
    const cursorX = clientX == null ? bounds.width / 2 : clientX - bounds.left;
    const cursorY = clientY == null ? bounds.height / 2 : clientY - bounds.top;
    const imageX = (cursorX - current.x) / current.scale;
    const imageY = (cursorY - current.y) / current.scale;
    commitTransform({
      scale: nextScale,
      x: cursorX - imageX * nextScale,
      y: cursorY - imageY * nextScale,
    });
    fitMode.current = false;
  };
  const wheel = (event: ReactWheelEvent<HTMLDivElement>): void => {
    event.preventDefault();
    setZoomAt(
      transformRef.current.scale * Math.exp(-event.deltaY * 0.0015),
      event.clientX,
      event.clientY,
    );
  };
  const commitObservation = async (
    pointId: string,
    coordinate: GcpManualMeasurement['coordinate'],
  ): Promise<boolean> => {
    if (imageId == null || observationBusy) return false;
    setObservationBusy(true);
    try {
      return await onCommitGcpMeasurement({
        pointId,
        imageId,
        state: 'manual',
        coordinate,
      });
    } finally {
      setObservationBusy(false);
    }
  };
  const startPan = (event: ReactPointerEvent<HTMLDivElement>): void => {
    if (event.button !== 0 || event.defaultPrevented || pointerTargetOwnsInteraction(event.target))
      return;
    if (
      placeMarkerArmed &&
      focusedGcpNeedsObservation &&
      focusedGcpId &&
      maskTool === 'pan' &&
      !observationBusy
    ) {
      const coordinate = imagePointAt(
        event,
        event.currentTarget,
        transformRef.current,
        width,
        height,
      );
      if (!coordinate) return;
      event.preventDefault();
      setPlaceMarkerArmed(false);
      void commitObservation(focusedGcpId, coordinate);
      return;
    }
    if (maskTool !== 'pan' && imageEntityId && !maskBusy) {
      const point = imagePointAt(event, event.currentTarget, transformRef.current, width, height);
      if (!point) return;
      strokeRef.current = { pointerId: event.pointerId, points: [point] };
      setActiveStroke([point]);
      event.currentTarget.setPointerCapture(event.pointerId);
      return;
    }
    const current = transformRef.current;
    drag.current = {
      pointerId: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      transformX: current.x,
      transformY: current.y,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
  };
  const movePan = (event: ReactPointerEvent<HTMLDivElement>): void => {
    const stroke = strokeRef.current;
    if (stroke?.pointerId === event.pointerId) {
      const point = imagePointAt(event, event.currentTarget, transformRef.current, width, height);
      const previous = stroke.points.at(-1);
      if (
        point &&
        (!previous ||
          Math.hypot(point.xPixels - previous.xPixels, point.yPixels - previous.yPixels) >=
            Math.max(1, maskRadius * 0.12))
      ) {
        stroke.points.push(point);
        setActiveStroke([...stroke.points]);
      }
      return;
    }
    const current = drag.current;
    if (current?.pointerId !== event.pointerId) return;
    commitTransform({
      ...transformRef.current,
      x: current.transformX + event.clientX - current.x,
      y: current.transformY + event.clientY - current.y,
    });
    fitMode.current = false;
  };
  const stopPan = (event: ReactPointerEvent<HTMLDivElement>): void => {
    const stroke = strokeRef.current;
    if (stroke?.pointerId === event.pointerId) {
      strokeRef.current = null;
      event.currentTarget.releasePointerCapture(event.pointerId);
      const points = stroke.points;
      setActiveStroke([]);
      if (!imageEntityId || points.length === 0 || maskTool === 'pan') return;
      setMaskBusy(true);
      void onEditImageMask(imageEntityId, imageMask?.revisionSha256, {
        kind: 'brush',
        stroke: { mode: maskTool, radiusPixels: maskRadius, points },
      }).finally(() => setMaskBusy(false));
      return;
    }
    if (drag.current?.pointerId !== event.pointerId) return;
    drag.current = null;
    event.currentTarget.releasePointerCapture(event.pointerId);
  };
  const doubleClick = (event: ReactMouseEvent<HTMLDivElement>): void => {
    if (!pointerTargetOwnsInteraction(event.target)) fit();
  };
  const openObservationMenu = (event: ReactMouseEvent<HTMLDivElement>): void => {
    if (
      !container ||
      imageId == null ||
      gcpPoints.length === 0 ||
      maskTool !== 'pan' ||
      pointerTargetOwnsInteraction(event.target)
    ) {
      return;
    }
    const coordinate = imageCoordinateAt(
      event.clientX,
      event.clientY,
      container,
      transformRef.current,
      width,
      height,
    );
    if (!coordinate) return;
    event.preventDefault();
    const bounds = container.getBoundingClientRect();
    const initialPoint = gcpPoints.find((point) => point.id === focusedGcpId) ?? gcpPoints[0];
    if (!initialPoint) return;
    setObservationMenu({
      x: Math.max(4, Math.min(event.clientX - bounds.left, bounds.width - 320)),
      y: Math.max(4, Math.min(event.clientY - bounds.top, bounds.height - 230)),
      coordinate,
      pointId: initialPoint.id,
    });
  };
  const commitContextObservation = async (): Promise<void> => {
    if (!observationMenu) return;
    const saved = await commitObservation(observationMenu.pointId, observationMenu.coordinate);
    if (saved) setObservationMenu(null);
  };
  return (
    <div
      ref={setContainer}
      className={`${styles.frameHost} ${drag.current ? styles.frameDragging : ''}`}
      data-mask-tool={maskTool}
      data-place-marker={placeMarkerArmed ? 'true' : 'false'}
      onWheel={wheel}
      onPointerDown={startPan}
      onPointerMove={movePan}
      onPointerUp={stopPan}
      onPointerCancel={stopPan}
      onDoubleClick={doubleClick}
      onContextMenu={openObservationMenu}
    >
      <div className={styles.zoomToolbar}>
        <OverlayChip
          as="button"
          onClick={() => setZoomAt(transformRef.current.scale / 1.5)}
          disabled={transform.scale <= MIN_IMAGE_SCALE}
          aria-label="Zoom out"
        >
          <Minus size={13} />
        </OverlayChip>
        <OverlayChip className={styles.zoomReadout} muted>
          {formatZoomPercentage(transform.scale)}
        </OverlayChip>
        <OverlayChip
          as="button"
          onClick={() => setZoomAt(transformRef.current.scale * 1.5)}
          disabled={transform.scale >= MAX_IMAGE_SCALE}
          aria-label="Zoom in"
        >
          <Plus size={13} />
        </OverlayChip>
        <OverlayChip as="button" onClick={fit} aria-label="Fit image">
          <Maximize2 size={13} />
        </OverlayChip>
        {focusedGcpNeedsObservation && (
          <>
            <OverlayChip muted>Right-click to place a marker</OverlayChip>
            <OverlayChip
              as="button"
              active={placeMarkerArmed}
              disabled={observationBusy || maskBusy}
              aria-pressed={placeMarkerArmed}
              onClick={() => {
                if (placeMarkerArmed) {
                  setPlaceMarkerArmed(false);
                  return;
                }
                setMaskTool('pan');
                setObservationMenu(null);
                setPlaceMarkerArmed(true);
              }}
            >
              <Crosshair size={13} />
              Place marker
            </OverlayChip>
          </>
        )}
      </div>
      {imageEntityId && (
        <div className={styles.maskToolbar} aria-label="Image exclusion mask tools">
          <OverlayChip
            as="button"
            active={maskTool === 'add'}
            onClick={() => {
              setPlaceMarkerArmed(false);
              setMaskTool((current) => (current === 'add' ? 'pan' : 'add'));
            }}
            disabled={maskBusy}
            aria-label="Paint excluded area"
            title="Exclude areas from processing (cars, sky, people…)"
          >
            <Brush size={13} />
          </OverlayChip>
          <OverlayChip
            as="button"
            active={maskTool === 'remove'}
            onClick={() => {
              setPlaceMarkerArmed(false);
              setMaskTool((current) => (current === 'remove' ? 'pan' : 'remove'));
            }}
            disabled={maskBusy}
            aria-label="Restore masked area"
            title="Erase mask — include area again"
          >
            <Eraser size={13} />
          </OverlayChip>
          {/* Size slider only when painting — keeps the bottom chrome calm. */}
          {(maskTool === 'add' || maskTool === 'remove') && (
            <label title="Brush radius in image pixels">
              <span>Size</span>
              <input
                type="range"
                min="2"
                max="500"
                step="1"
                value={maskRadius}
                onChange={(event) => setMaskRadius(Number(event.currentTarget.value))}
                disabled={maskBusy}
              />
              <code>{maskRadius}px</code>
            </label>
          )}
          <OverlayChip
            as="button"
            onClick={() => {
              if (!imageMask || imageMask.maskedPixelCount === 0) return;
              setMaskBusy(true);
              void onEditImageMask(imageEntityId, imageMask.revisionSha256, {
                kind: 'clear',
              }).finally(() => setMaskBusy(false));
            }}
            disabled={maskBusy || !imageMask || imageMask.maskedPixelCount === 0}
            aria-label="Clear mask"
            title="Clear entire exclusion mask"
          >
            <Trash2 size={13} />
          </OverlayChip>
          {maskBusy ? (
            <LoaderCircle className={styles.maskSpinner} size={13} />
          ) : (imageMask?.maskedPixelCount ?? 0) > 0 ? (
            <code title="Masked pixels">
              {(imageMask?.maskedPixelCount ?? 0).toLocaleString('en-US')} px
            </code>
          ) : null}
        </div>
      )}
      <div
        className={styles.imageFrame}
        style={{
          width,
          height,
          transform: `translate3d(${transform.x}px, ${transform.y}px, 0) scale(${transform.scale})`,
        }}
      >
        <img
          className={styles.imagePreview}
          src={previewSource}
          alt=""
          draggable={false}
          aria-hidden="true"
        />
        <img
          className={`${styles.imageOriginal} ${fullResolutionReady ? styles.imageOriginalReady : ''}`}
          src={source}
          alt={alt}
          draggable={false}
          decoding="async"
          onLoad={() => setFullResolutionReady(true)}
          onError={onError}
        />
        {imageMask?.rasterObjectHash && imageMask.maskedPixelCount > 0 && (
          <ImageMaskOverlay
            rasterObjectHash={imageMask.rasterObjectHash}
            expectedWidth={width}
            expectedHeight={height}
            onError={onMaskError}
          />
        )}
        {activeStroke.length > 0 && (
          <svg className={styles.activeMaskStroke} viewBox={`0 0 ${width} ${height}`}>
            <polyline
              points={activeStroke.map((point) => `${point.xPixels},${point.yPixels}`).join(' ')}
              fill="none"
              stroke={maskTool === 'remove' ? 'rgba(255,255,255,0.8)' : 'rgba(255,82,82,0.85)'}
              strokeWidth={maskRadius * 2}
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        )}
      </div>
      {markers.length > 0 && (
        <GcpImageMarkerOverlay
          imageWidthPixels={width}
          imageHeightPixels={height}
          viewScale={transform.scale}
          imageOffsetX={transform.x}
          imageOffsetY={transform.y}
          markers={markers}
          {...(focusedGcpId ? { selectedPointId: focusedGcpId } : {})}
          onCommitMeasurement={onCommitGcpMeasurement}
          onEditObservation={(marker, action) =>
            onEditGcpObservation(
              marker,
              action === 'block'
                ? {
                    action,
                    coordinate: marker.coordinate,
                    reason: 'Excluded by user',
                  }
                : { action },
            )
          }
        />
      )}
      {observationMenu && (
        <div
          className={styles.observationMenu}
          style={{ left: observationMenu.x, top: observationMenu.y }}
          role="dialog"
          aria-label="Create GCP observation"
          onPointerDown={(event) => event.stopPropagation()}
        >
          <strong>Create marker here</strong>
          <span>
            Pixel {observationMenu.coordinate.xPixels.toFixed(1)} /{' '}
            {observationMenu.coordinate.yPixels.toFixed(1)}
          </span>
          <label>
            Assign ground control point
            <Select
              wrapClassName={styles.observationSelect}
              value={observationMenu.pointId}
              disabled={observationBusy}
              options={gcpPoints.map((point) => ({ value: point.id, label: point.name }))}
              onChange={(event) =>
                setObservationMenu((current) =>
                  current ? { ...current, pointId: event.currentTarget.value } : current,
                )
              }
            />
          </label>
          <div>
            <button
              type="button"
              disabled={observationBusy}
              onClick={() => setObservationMenu(null)}
            >
              Cancel
            </button>
            <button
              type="button"
              disabled={observationBusy}
              onClick={() => void commitContextObservation()}
            >
              {observationBusy ? 'Saving…' : 'Create observation'}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

interface ImageMaskPoint {
  xPixels: number;
  yPixels: number;
}

interface PackedImageMask {
  width: number;
  height: number;
  bits: Uint8Array;
}

function imagePointAt(
  event: ReactPointerEvent<HTMLDivElement>,
  host: HTMLDivElement,
  transform: ImageViewTransform,
  width: number,
  height: number,
): ImageMaskPoint | null {
  return imageCoordinateAt(event.clientX, event.clientY, host, transform, width, height);
}

function imageCoordinateAt(
  clientX: number,
  clientY: number,
  host: HTMLDivElement,
  transform: ImageViewTransform,
  width: number,
  height: number,
): ImageMaskPoint | null {
  const bounds = host.getBoundingClientRect();
  const xPixels = (clientX - bounds.left - transform.x) / transform.scale;
  const yPixels = (clientY - bounds.top - transform.y) / transform.scale;
  if (xPixels < 0 || yPixels < 0 || xPixels >= width || yPixels >= height) return null;
  return { xPixels, yPixels };
}

function ImageMaskOverlay({
  rasterObjectHash,
  expectedWidth,
  expectedHeight,
  onError,
}: {
  rasterObjectHash: string;
  expectedWidth: number;
  expectedHeight: number;
  onError: (message: string) => void;
}): JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const onErrorRef = useRef(onError);
  useEffect(() => {
    onErrorRef.current = onError;
  }, [onError]);
  useEffect(() => {
    const controller = new AbortController();
    void fetch(`hcad-image://project/${rasterObjectHash}?format=binary`, {
      signal: controller.signal,
    })
      .then(async (response) => {
        if (!response.ok) throw new Error(`mask object HTTP ${response.status}`);
        const raster = decodePackedImageMask(await response.arrayBuffer());
        if (raster.width !== expectedWidth || raster.height !== expectedHeight) {
          throw new Error(
            `mask dimensions ${raster.width} × ${raster.height} do not match ${expectedWidth} × ${expectedHeight}`,
          );
        }
        const canvas = canvasRef.current;
        if (!canvas || controller.signal.aborted) return;
        paintMaskPreview(canvas, raster);
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted) onErrorRef.current(String(error));
      });
    return () => controller.abort();
  }, [expectedHeight, expectedWidth, rasterObjectHash]);
  return <canvas ref={canvasRef} className={styles.maskOverlay} aria-hidden="true" />;
}

function decodePackedImageMask(buffer: ArrayBuffer): PackedImageMask {
  const bytes = new Uint8Array(buffer);
  if (bytes.byteLength < 24 || new TextDecoder().decode(bytes.subarray(0, 8)) !== 'HCMASK01') {
    throw new Error('invalid image-mask framing');
  }
  const header = new DataView(buffer, bytes.byteOffset, bytes.byteLength);
  const width = header.getUint32(8, true);
  const height = header.getUint32(12, true);
  if (width < 1 || height < 1 || bytes.byteLength !== 24 + Math.ceil((width * height) / 8)) {
    throw new Error('invalid image-mask dimensions');
  }
  return { width, height, bits: bytes.subarray(24) };
}

function paintMaskPreview(canvas: HTMLCanvasElement, raster: PackedImageMask): void {
  const scale = Math.min(1, 2048 / Math.max(raster.width, raster.height));
  const width = Math.max(1, Math.round(raster.width * scale));
  const height = Math.max(1, Math.round(raster.height * scale));
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('2D canvas is unavailable');
  const pixels = context.createImageData(width, height);
  for (let y = 0; y < height; y += 1) {
    const sourceY = Math.min(raster.height - 1, Math.floor(((y + 0.5) * raster.height) / height));
    for (let x = 0; x < width; x += 1) {
      const sourceX = Math.min(raster.width - 1, Math.floor(((x + 0.5) * raster.width) / width));
      const sourcePixel = sourceY * raster.width + sourceX;
      if ((raster.bits[sourcePixel >> 3]! & (1 << (sourcePixel & 7))) === 0) continue;
      const target = (y * width + x) * 4;
      pixels.data[target] = 255;
      pixels.data[target + 1] = 54;
      pixels.data[target + 2] = 74;
      pixels.data[target + 3] = 105;
    }
  }
  context.putImageData(pixels, 0, 0);
}

interface ImageViewTransform {
  scale: number;
  x: number;
  y: number;
}

const MIN_IMAGE_SCALE = 0.01;
const MAX_IMAGE_SCALE = 64;

function clampImageScale(scale: number): number {
  return Math.max(MIN_IMAGE_SCALE, Math.min(MAX_IMAGE_SCALE, scale));
}

function formatZoomPercentage(scale: number): string {
  const percentage = scale * 100;
  return `${percentage < 10 ? percentage.toFixed(1) : Math.round(percentage)}%`;
}

function pointerTargetOwnsInteraction(target: EventTarget | null): boolean {
  return (
    target instanceof Element &&
    target.closest('button, input, select, textarea, a, [contenteditable="true"]') !== null
  );
}

function keyboardTargetOwnsNavigation(target: EventTarget | null): boolean {
  return (
    target instanceof Element &&
    target.closest(
      'input, select, textarea, [contenteditable="true"], [role="textbox"], [role="combobox"], [role="listbox"], [role="spinbutton"]',
    ) !== null
  );
}

function markersForCamera(
  camera: AlignedGcpCameraRecord,
  projectImage: ProjectCameraImageRecord | undefined,
  collection: GcpCollectionRecord | null,
  optimization: GcpOptimizationPublicationRecord | null,
  localEstimates: readonly GcpLocalEstimateArtifact[],
): GcpImageMarker[] {
  const names = new Map(collection?.points.map(({ point }) => [point.id, point.name]) ?? []);
  const markers = new Map<string, GcpImageMarker>();
  if (projectImage) {
    for (const { point } of collection?.points ?? []) {
      const coordinate = initialGcpProjection(camera, projectImage, point.coordinate);
      if (!coordinate) continue;
      markers.set(point.id, {
        pointId: point.id,
        pointName: point.name,
        imageId: camera.imageId,
        coordinate,
        state: 'predictedBlue',
        confidencePerMille: 350,
      });
    }
  }
  for (const projection of optimization?.artifact.result.projections ?? []) {
    if (projection.imageId !== camera.imageId) continue;
    markers.set(projection.pointId, {
      pointId: projection.pointId,
      pointName: names.get(projection.pointId) ?? projection.pointId,
      imageId: camera.imageId,
      coordinate: projection.coordinate,
      state: 'predictedBlue',
      uncertainty: projection.uncertainty,
    });
  }
  // Local fixed-camera feedback is newer than a published global run, but it
  // remains visually a prediction and never changes alignment provenance.
  for (const artifact of localEstimates) {
    for (const projection of artifact.estimate.projections) {
      if (projection.imageId !== camera.imageId) continue;
      markers.set(projection.pointId, {
        pointId: projection.pointId,
        pointName: names.get(projection.pointId) ?? projection.pointId,
        imageId: camera.imageId,
        coordinate: projection.coordinate,
        state: 'predictedBlue',
        uncertainty: projection.uncertainty,
      });
    }
  }
  for (const observation of collection?.observations ?? []) {
    if (observation.imageId !== camera.imageId) continue;
    const state = observation.state;
    const coordinate = state.state === 'blocked' ? state.predictedCoordinate : state.coordinate;
    if (!coordinate) continue;
    markers.set(observation.pointId, {
      pointId: observation.pointId,
      pointName: names.get(observation.pointId) ?? observation.pointId,
      imageId: camera.imageId,
      coordinate,
      state:
        state.state === 'manual'
          ? 'manualGreen'
          : state.state === 'automatic'
            ? 'automaticOrange'
            : state.state === 'blocked'
              ? 'blockedMuted'
              : 'predictedBlue',
      ...('confidencePerMille' in state ? { confidencePerMille: state.confidencePerMille } : {}),
      ...(state.state === 'blocked' ? { blockedReason: state.reason } : {}),
    });
  }
  return [...markers.values()];
}

export function initialGcpProjection(
  camera: AlignedGcpCameraRecord,
  image: ProjectCameraImageRecord,
  coordinate: { eastMeters: number; northMeters: number; heightMeters: number },
): { xPixels: number; yPixels: number } | null {
  if (camera.centerInProjectWorld) {
    const center = camera.camera.centerReconstruction;
    const cameraToWorld = camera.camera.cameraToReconstructionRotation;
    const delta: [number, number, number] = [
      coordinate.eastMeters - center[0],
      coordinate.northMeters - center[1],
      coordinate.heightMeters - center[2],
    ];
    // The catalog stores row-major R(camera -> project world). Transposing it
    // yields COLMAP camera coordinates (+X right, +Y down, +Z forward).
    return projectCameraCoordinate(camera, [
      cameraToWorld[0] * delta[0] + cameraToWorld[3] * delta[1] + cameraToWorld[6] * delta[2],
      cameraToWorld[1] * delta[0] + cameraToWorld[4] * delta[1] + cameraToWorld[7] * delta[2],
      cameraToWorld[2] * delta[0] + cameraToWorld[5] * delta[1] + cameraToWorld[8] * delta[2],
    ]);
  }

  // A not-yet-world-aligned model still gets a coarse EXIF seed.
  const reference = image.metadata.projectedReference;
  const attitude =
    image.metadata.inspectedPhoto.metadata.djiXmp.gimbalAttitude ??
    image.metadata.inspectedPhoto.metadata.djiXmp.flightAttitude;
  const cameraHeight = reference?.transformedHeightMeters;
  if (!reference || cameraHeight == null || attitude?.pitch == null) return null;
  const yaw = ((attitude.yaw ?? 0) * Math.PI) / 180;
  const pitch = (attitude.pitch * Math.PI) / 180;
  const forward: [number, number, number] = [
    Math.sin(yaw) * Math.cos(pitch),
    Math.cos(yaw) * Math.cos(pitch),
    Math.sin(pitch),
  ];
  const right: [number, number, number] = [Math.cos(yaw), -Math.sin(yaw), 0];
  const down: [number, number, number] = [
    forward[1] * right[2] - forward[2] * right[1],
    forward[2] * right[0] - forward[0] * right[2],
    forward[0] * right[1] - forward[1] * right[0],
  ];
  const delta: [number, number, number] = [
    coordinate.eastMeters - reference.easting,
    coordinate.northMeters - reference.northing,
    coordinate.heightMeters - cameraHeight,
  ];
  const x = dot3(delta, right);
  const y = dot3(delta, down);
  const z = dot3(delta, forward);
  return projectCameraCoordinate(camera, [x, y, z]);
}

function projectCameraCoordinate(
  camera: AlignedGcpCameraRecord,
  coordinate: readonly [number, number, number],
): { xPixels: number; yPixels: number } | null {
  const [x, y, z] = coordinate;
  if (![x, y, z].every(Number.isFinite) || z <= 0.01) return null;
  const normalizedX = x / z;
  const normalizedY = y / z;
  const [k1, k2, k3] = camera.camera.radialDistortion;
  const [p1, p2] = camera.camera.tangentialDistortion;
  if (!distortionIsInvertibleAt(normalizedX, normalizedY, k1, k2, k3, p1, p2)) return null;
  const r2 = normalizedX * normalizedX + normalizedY * normalizedY;
  const radial = 1 + k1 * r2 + k2 * r2 * r2 + k3 * r2 * r2 * r2;
  const distortedX =
    normalizedX * radial +
    2 * p1 * normalizedX * normalizedY +
    p2 * (r2 + 2 * normalizedX * normalizedX);
  const distortedY =
    normalizedY * radial +
    p1 * (r2 + 2 * normalizedY * normalizedY) +
    2 * p2 * normalizedX * normalizedY;
  const xPixels = camera.camera.focalXPixels * distortedX + camera.camera.principalXPixels;
  const yPixels = camera.camera.focalYPixels * distortedY + camera.camera.principalYPixels;
  return Number.isFinite(xPixels) &&
    Number.isFinite(yPixels) &&
    xPixels >= 0 &&
    yPixels >= 0 &&
    xPixels < camera.camera.widthPixels &&
    yPixels < camera.camera.heightPixels
    ? { xPixels, yPixels }
    : null;
}

function distortionIsInvertibleAt(
  x: number,
  y: number,
  k1: number,
  k2: number,
  k3: number,
  p1: number,
  p2: number,
): boolean {
  const r2 = x * x + y * y;
  const r4 = r2 * r2;
  const r6 = r4 * r2;
  const radial = 1 + k1 * r2 + k2 * r4 + k3 * r6;
  const radialDerivative = 1 + 3 * k1 * r2 + 5 * k2 * r4 + 7 * k3 * r6;
  if (!Number.isFinite(radial) || radial <= 0 || radialDerivative <= 0) return false;

  const gradientScale = 2 * (k1 + 2 * k2 * r2 + 3 * k3 * r4);
  const radialX = x * gradientScale;
  const radialY = y * gradientScale;
  const dxDx = radial + x * radialX + 2 * p1 * y + 6 * p2 * x;
  const dxDy = x * radialY + 2 * p1 * x + 2 * p2 * y;
  const dyDx = y * radialX + 2 * p1 * x + 2 * p2 * y;
  const dyDy = radial + y * radialY + 6 * p1 * y + 2 * p2 * x;
  return dxDx * dyDy - dxDy * dyDx > 1e-8;
}

function dot3(left: readonly number[], right: readonly number[]): number {
  return left[0]! * right[0]! + left[1]! * right[1]! + left[2]! * right[2]!;
}

function layerLabel(layer: ImageLayer): string {
  if (layer === 'original') return 'Original';
  if (layer === 'depth') return 'Depth';
  if (layer === 'confidence') return 'Confidence';
  return 'Normals';
}

function fileName(photo: DiscoveredPhoto): string {
  return photo.sourcePath.split(/[\\/]/).pop() ?? photo.sourcePath;
}

function cameraName(photo: DiscoveredPhoto): string {
  const values = [photo.metadata.exif.make, photo.metadata.exif.model].filter(Boolean);
  return values.length > 0 ? values.join(' · ') : 'unknown';
}

function hasPhotoPosition(photo: DiscoveredPhoto): boolean {
  return (
    photo.metadata.exif.gps != null ||
    (photo.metadata.djiXmp.latitudeDegrees != null &&
      photo.metadata.djiXmp.longitudeDegrees != null)
  );
}
