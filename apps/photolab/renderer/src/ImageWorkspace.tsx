import type {
  AlignedGcpCameraRecord,
  DiscoveredPhoto,
  GcpCollectionRecord,
  GcpObservationEdit,
  GcpOptimizationPublicationRecord,
  ImageProductTag,
  PhotoImportBatch,
  ProjectCameraImageRecord,
} from '@himmelcad/data';
import { Image as ImageIcon, Layers3, Maximize2 } from 'lucide-react';
import { useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent } from 'react';

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
  alignedCameras: readonly AlignedGcpCameraRecord[];
  gcpCollection: GcpCollectionRecord | null;
  gcpOptimization: GcpOptimizationPublicationRecord | null;
  focusedGcpId: string | null;
  onCommitGcpMeasurement: (measurement: GcpManualMeasurement) => void;
  onEditGcpObservation: (marker: GcpImageMarker, edit: GcpObservationEdit) => void;
  depthDatasets: readonly { relativePath: string }[];
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
  alignedCameras,
  gcpCollection,
  gcpOptimization,
  focusedGcpId,
  onCommitGcpMeasurement,
  onEditGcpObservation,
  depthDatasets,
}: ImageWorkspaceProps): JSX.Element {
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
        if (!response.ok) throw new Error(`Depth-Index HTTP ${response.status}`);
        const index = (await response.json()) as MvsOutputIndex;
        setDepthProduct({
          index,
          basePath: latest.relativePath.replace(/[^/]+$/, ''),
        });
      })
      .catch(() => {
        if (!controller.signal.aborted) setDepthProduct(null);
      });
    return () => controller.abort();
  }, [depthDatasets]);
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
    const point = gcpCollection?.points.find(({ point }) => point.id === focusedGcpId)?.point;
    if (point) {
      const imagesByEntity = new Map(projectImages.map((image) => [image.entityId, image]));
      for (const camera of alignedCameras) {
        const image = imagesByEntity.get(camera.entityId);
        if (image && initialGcpProjection(camera, image, point.coordinate)) ids.add(camera.imageId);
      }
    }
    return ids;
  }, [alignedCameras, focusedGcpId, gcpCollection, gcpOptimization, projectImages]);
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
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [layer, setLayer] = useState<ImageLayer>('original');
  const selected = photos.find((photo) => photo.sourcePath === selectedPath) ?? photos[0] ?? null;

  useEffect(() => {
    if (selectedPath && !photos.some((photo) => photo.sourcePath === selectedPath)) {
      setSelectedPath(null);
    }
  }, [photos, selectedPath]);

  return (
    <section className={styles.root} aria-label="Image and depth-map view">
      <header className={styles.toolbar}>
        <div className={styles.layerTabs}>
          {(['original', 'depth', 'confidence', 'normals'] as const).map((candidate) => (
            <button
              key={candidate}
              type="button"
              className={layer === candidate ? styles.activeTab : undefined}
              onClick={() => setLayer(candidate)}
            >
              {layerLabel(candidate)}
            </button>
          ))}
        </div>
        <span className={styles.selectionLabel}>{selected ? fileName(selected) : 'No image'}</span>
        <button type="button" className={styles.iconButton} aria-label="Fit image">
          <Maximize2 size={15} />
        </button>
      </header>

      <div className={styles.stage}>
        {selected ? (
          <ImageLayerContent
            photo={selected}
            layer={layer}
            tags={tagsByHash.get(selected.sha256)}
            camera={alignedCameras.find((entry) => entry.sourceObjectHash === selected.sha256)}
            projectImage={projectImages.find(
              (entry) => entry.metadata.sourceObjectHash === selected.sha256,
            )}
            gcpCollection={gcpCollection}
            gcpOptimization={gcpOptimization}
            focusedGcpId={focusedGcpId}
            onCommitGcpMeasurement={onCommitGcpMeasurement}
            onEditGcpObservation={onEditGcpObservation}
            depthProduct={depthProduct}
          />
        ) : (
          <div className={styles.empty}>
            <ImageIcon size={34} />
            <strong>No images in this workspace yet</strong>
            <span>Imported originals and measurable depth maps appear here.</span>
          </div>
        )}
      </div>

      <div className={styles.filmstrip} aria-label="Image filmstrip">
        {photos.map((photo) => (
          <button
            key={photo.sourcePath}
            type="button"
            className={photo === selected ? styles.activePhoto : undefined}
            onClick={() => setSelectedPath(photo.sourcePath)}
          >
            <span className={styles.thumb}>
              <ImageIcon size={18} />
            </span>
            <span className={styles.photoText}>
              <strong>{fileName(photo)}</strong>
              <small>{photoStatus(photo, tagsByHash.get(photo.sha256))}</small>
            </span>
          </button>
        ))}
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
  gcpCollection,
  gcpOptimization,
  focusedGcpId,
  onCommitGcpMeasurement,
  onEditGcpObservation,
  depthProduct,
}: {
  photo: DiscoveredPhoto;
  layer: ImageLayer;
  tags: readonly ImageProductTag[] | undefined;
  camera: AlignedGcpCameraRecord | undefined;
  projectImage: ProjectCameraImageRecord | undefined;
  gcpCollection: GcpCollectionRecord | null;
  gcpOptimization: GcpOptimizationPublicationRecord | null;
  focusedGcpId: string | null;
  onCommitGcpMeasurement: (measurement: GcpManualMeasurement) => void;
  onEditGcpObservation: (marker: GcpImageMarker, edit: GcpObservationEdit) => void;
  depthProduct: { index: MvsOutputIndex; basePath: string } | null;
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
      return <DepthCanvas image={depthImage} basePath={depthProduct.basePath} layer={layer} />;
    }
    return (
      <div className={styles.empty}>
        <Layers3 size={34} />
        <strong>
          {ready ? `Loading ${layerLabel(layer)}` : `${layerLabel(layer)} has not been generated`}
        </strong>
        <span>
          {ready
            ? 'Initializing the measurable depth-tile decoder for this image.'
            : 'The “Depth ready” image tag is set only after the depth run commits atomically.'}
        </span>
      </div>
    );
  }
  if (!loadFailed) {
    const dimensions = photo.metadata.exif.dimensions;
    const markers = camera
      ? markersForCamera(camera, projectImage, gcpCollection, gcpOptimization, focusedGcpId)
      : [];
    return (
      <div className={styles.imageCanvas}>
        <ImageContentFrame
          source={`hcad-image://project/${photo.sha256}?format=${photo.format}`}
          alt={fileName(photo)}
          width={camera?.camera.widthPixels ?? dimensions?.widthPixels ?? 1}
          height={camera?.camera.heightPixels ?? dimensions?.heightPixels ?? 1}
          markers={markers}
          focusedGcpId={focusedGcpId}
          onError={() => setLoadFailed(true)}
          onCommitGcpMeasurement={onCommitGcpMeasurement}
          onEditGcpObservation={onEditGcpObservation}
        />
        <span>{fileName(photo)} · Original</span>
      </div>
    );
  }
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
          <dd>validated · not imported yet</dd>
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
}: {
  image: MvsDepthImageRecord;
  basePath: string;
  layer: Exclude<ImageLayer, 'original'>;
}): JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const depthRef = useRef<{
    values: Float32Array;
    confidence: Float32Array;
    width: number;
    height: number;
  } | null>(null);
  const [status, setStatus] = useState('Streaming depth tiles…');
  const [measurement, setMeasurement] = useState<string | null>(null);
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
        if (!response.ok) throw new Error(`Depth-Tile HTTP ${response.status}`);
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
        setStatus(`Level ${targetLevel} · ${loaded.length} tiles · click to measure`);
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted)
          setStatus(`Depth map could not be loaded: ${String(error)}`);
      });
    return () => controller.abort();
  }, [basePath, image, layer]);

  const measure = (event: ReactMouseEvent<HTMLCanvasElement>) => {
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
  return (
    <div className={styles.depthCanvas}>
      <canvas ref={canvasRef} onClick={measure} />
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
  alt,
  width,
  height,
  markers,
  focusedGcpId,
  onError,
  onCommitGcpMeasurement,
  onEditGcpObservation,
}: {
  source: string;
  alt: string;
  width: number;
  height: number;
  markers: readonly GcpImageMarker[];
  focusedGcpId: string | null;
  onError: () => void;
  onCommitGcpMeasurement: (measurement: GcpManualMeasurement) => void;
  onEditGcpObservation: (marker: GcpImageMarker, edit: GcpObservationEdit) => void;
}): JSX.Element {
  const [container, setContainer] = useState<HTMLDivElement | null>(null);
  const [size, setSize] = useState({ width: 1, height: 1 });
  useEffect(() => {
    if (!container) return;
    const update = () => {
      const bounds = container.getBoundingClientRect();
      const scale = Math.min(bounds.width / width, bounds.height / height);
      setSize({ width: Math.max(1, width * scale), height: Math.max(1, height * scale) });
    };
    const observer = new ResizeObserver(update);
    observer.observe(container);
    update();
    return () => observer.disconnect();
  }, [container, height, width]);
  return (
    <div ref={setContainer} className={styles.frameHost}>
      <div className={styles.imageFrame} style={{ width: size.width, height: size.height }}>
        <img src={source} alt={alt} onError={onError} />
        {markers.length > 0 && (
          <GcpImageMarkerOverlay
            imageWidthPixels={width}
            imageHeightPixels={height}
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
      </div>
    </div>
  );
}

function markersForCamera(
  camera: AlignedGcpCameraRecord,
  projectImage: ProjectCameraImageRecord | undefined,
  collection: GcpCollectionRecord | null,
  optimization: GcpOptimizationPublicationRecord | null,
  focusedGcpId: string | null,
): GcpImageMarker[] {
  const names = new Map(collection?.points.map(({ point }) => [point.id, point.name]) ?? []);
  const markers = new Map<string, GcpImageMarker>();
  if (projectImage) {
    for (const { point } of collection?.points ?? []) {
      if (focusedGcpId && point.id !== focusedGcpId) continue;
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
    if (
      projection.imageId !== camera.imageId ||
      (focusedGcpId && projection.pointId !== focusedGcpId)
    )
      continue;
    markers.set(projection.pointId, {
      pointId: projection.pointId,
      pointName: names.get(projection.pointId) ?? projection.pointId,
      imageId: camera.imageId,
      coordinate: projection.coordinate,
      state: 'predictedBlue',
      uncertainty: projection.uncertainty,
    });
  }
  for (const observation of collection?.observations ?? []) {
    if (
      observation.imageId !== camera.imageId ||
      (focusedGcpId && observation.pointId !== focusedGcpId)
    )
      continue;
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

function initialGcpProjection(
  camera: AlignedGcpCameraRecord,
  image: ProjectCameraImageRecord,
  coordinate: { eastMeters: number; northMeters: number; heightMeters: number },
): { xPixels: number; yPixels: number } | null {
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
  if (!Number.isFinite(z) || z <= 0.01) return null;
  const normalizedX = x / z;
  const normalizedY = y / z;
  const [k1, k2, k3] = camera.camera.radialDistortion;
  const [p1, p2] = camera.camera.tangentialDistortion;
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
  return xPixels >= 0 &&
    yPixels >= 0 &&
    xPixels < camera.camera.widthPixels &&
    yPixels < camera.camera.heightPixels
    ? { xPixels, yPixels }
    : null;
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

function photoStatus(photo: DiscoveredPhoto, tags: readonly ImageProductTag[] | undefined): string {
  const productStatus = [
    tags?.includes('rtkFixed') ? 'RTK fixed' : null,
    tags?.includes('aligned') ? 'aligned' : null,
    tags?.includes('depthReady')
      ? tags.includes('depthStale')
        ? 'depth stale'
        : 'depth ready'
      : null,
  ]
    .filter(Boolean)
    .join(' · ');
  if (productStatus) return productStatus;
  if (photo.metadata.djiXmp.rtk != null) return 'RTK/DJI · validated';
  if (hasPhotoPosition(photo)) return 'GPS · validated';
  return 'no position · validated';
}

function hasPhotoPosition(photo: DiscoveredPhoto): boolean {
  return (
    photo.metadata.exif.gps != null ||
    (photo.metadata.djiXmp.latitudeDegrees != null &&
      photo.metadata.djiXmp.longitudeDegrees != null)
  );
}
