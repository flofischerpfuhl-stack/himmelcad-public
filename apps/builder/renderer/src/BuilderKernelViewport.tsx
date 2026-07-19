import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
  type DragEvent,
} from 'react';

import type { EntityId, SnapKind, SnapResult, Vec3 } from '@himmelcad/data';
import {
  type CanonicalEntity,
  type CanonicalRepresentationAdmission,
  type GeometryObject,
  type HimmelcadViewerWasmLoader,
  type KernelPickCandidate,
  type KernelCanonicalRenderAdmission,
  type KernelClipVolume,
  type KernelRenderStyle,
  type Representation,
} from '@himmelcad/viewer/kernel';
import { KernelViewport, type KernelViewportHandle } from '@himmelcad/viewer/kernel/react';

import styles from './BuilderKernelViewport.module.css';

const EMPTY_HASH_A = '01'.repeat(32);
const EMPTY_HASH_B = '02'.repeat(32);
const EMPTY_HASH_C = '03'.repeat(32);
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
  baseColor: [0.74, 0.78, 0.84, 1],
};
const RASTER_STYLE: KernelRenderStyle = {
  ...POINT_CLOUD_STYLE,
  baseColor: [1, 1, 1, 1],
};

export interface BuilderPointCloudOptions {
  readonly entityId: EntityId;
  readonly datasetId: string;
  readonly sourceName: string;
  readonly bounds: {
    readonly min: readonly [number, number, number];
    readonly max: readonly [number, number, number];
  };
  readonly pointCount: number;
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
  loadCanonicalPackage(
    package_: BuilderCanonicalImportPackage,
    translation: readonly [number, number, number],
  ): Promise<readonly EntityId[]>;
  loadRasterImage(imageUrl: string, options: BuilderRasterImageOptions): Promise<void>;
  loadDrapedRaster(
    imageUrl: string,
    depthUrl: string,
    options: BuilderRasterImageOptions,
  ): Promise<void>;
  frameAll(): void;
  setPointSize(pointSize: number): void;
  setNavigationMode(mode: 'orbit3d' | 'lockedTopDown2d'): void;
  setEntityAppearance(
    entityIds: readonly EntityId[],
    options: { readonly opacity?: number; readonly verticalExaggeration?: number },
  ): void;
  setEntityVisibility(entityIds: readonly EntityId[], visible: boolean): void;
  setClipVolumes(volumes: readonly KernelClipVolume[]): void;
}

interface BuilderKernelViewportProps {
  readonly pointSize: number;
  readonly onCursorSnap: (snap: SnapResult | null) => void;
  readonly onDropFiles: (paths: string[]) => void | Promise<void>;
  readonly onLog: (level: 'debug' | 'info' | 'warn' | 'error', message: string) => void;
}

export const BuilderKernelViewport = forwardRef<
  BuilderKernelViewportHandle,
  BuilderKernelViewportProps
>(function BuilderKernelViewport(
  { pointSize, onCursorSnap, onDropFiles, onLog },
  ref,
): JSX.Element {
  const kernelRef = useRef<KernelViewportHandle | null>(null);
  const readyRef = useRef(createDeferred<KernelViewportHandle>());
  const loadedBoundsRef = useRef<Bounds | null>(null);
  const entityStylesRef = useRef(new Map<EntityId, KernelRenderStyle>());
  const entityExaggerationDatumsRef = useRef(new Map<EntityId, number>());
  const callbacksRef = useRef({ onCursorSnap, onDropFiles, onLog });
  const pointSizeRef = useRef(pointSize);
  callbacksRef.current = { onCursorSnap, onDropFiles, onLog };
  const [cursor, setCursor] = useState<Vec3 | null>(null);
  const [dragging, setDragging] = useState(false);

  useEffect(() => {
    pointSizeRef.current = pointSize;
    kernelRef.current?.session.setPointSize(pointSize);
  }, [pointSize]);

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

  useImperativeHandle(
    ref,
    () => ({
      async loadPotreePointCloud(metadataUrl, options) {
        const kernel = await readyRef.current.promise;
        const metadataResponse = await fetch(metadataUrl);
        if (!metadataResponse.ok) {
          throw new Error(
            `Potree metadata request failed (${metadataResponse.status} ${metadataResponse.statusText})`,
          );
        }
        const metadata = new Uint8Array(await metadataResponse.arrayBuffer());
        const geometry: GeometryObject = {
          kind: 'pointCloud',
          dataset: {
            formatId: 'potree@2',
            metadata: {
              objectHash: await sha256Hex(metadata),
              mediaType: 'application/json',
              byteLength: metadata.byteLength,
            },
            elementCount: options.pointCount,
          },
        };
        const selected: Representation = {
          role: 'canonical',
          geometryRef: kernel.session.geometryObjectContentHash(geometry),
          authority: 'authoritative',
          dependencyHash: null,
        };
        const entityWithoutHash = {
          id: options.entityId,
          revision: 1,
          typeId: 'hcad.point-cloud@1',
          name: options.sourceName,
          owner: null,
          layerIds: [],
          placement: null,
          representations: [selected],
          componentsRef: EMPTY_HASH_A,
          attributesRef: EMPTY_HASH_B,
          relationsRef: EMPTY_HASH_C,
          styleRef: null,
          schemaVersion: 1,
        } satisfies Omit<CanonicalEntity, 'versionHash'>;
        const hashInput: CanonicalEntity = {
          ...entityWithoutHash,
          versionHash: '00'.repeat(32),
        };
        const entity: CanonicalEntity = {
          ...entityWithoutHash,
          versionHash: kernel.session.canonicalEntityVersionHash(hashInput),
        };
        await kernel.session.loadPotree(
          {
            datasetId: options.datasetId,
            metadataUri: metadataUrl,
            admission: {
              entity,
              selected,
              representationSlot: 'primary',
              expectedGeneration: null,
              resolvedGeometry: geometry,
            },
            style: POINT_CLOUD_STYLE,
          },
          { operationId: `builder/load/${options.entityId}` },
        );
        entityStylesRef.current.set(options.entityId, POINT_CLOUD_STYLE);
        entityExaggerationDatumsRef.current.set(options.entityId, options.bounds.min[2]);
        loadedBoundsRef.current = unionBounds(loadedBoundsRef.current, options.bounds);
        frameAll();
      },
      async loadCanonicalPackage(package_, translation) {
        const kernel = await readyRef.current.promise;
        await kernel.session.readbacksSettled();
        const normalized = package_.admissions
          .filter(
            (admission) =>
              admission.selected.role === 'body' &&
              (admission.resolvedGeometry.kind === 'surface3d' ||
                (admission.resolvedGeometry.kind === 'solid' &&
                  admission.resolvedGeometry.solid.kind === 'extrusion')),
          )
          .map((admission) => {
            const geometryRef = kernel.session.geometryObjectContentHash(admission.resolvedGeometry);
            const selected: Representation = {
              role: 'canonical',
              geometryRef,
              authority: 'authoritative',
              dependencyHash: null,
            };
            return {
              ...admission,
              selected,
            };
          });
        const entities = new Map<EntityId, CanonicalEntity>();
        const admissions: KernelCanonicalRenderAdmission[] = normalized.map((admission) => {
          const id = admission.entity.id as EntityId;
          let entity = entities.get(id);
          if (!entity) {
            const placement = translatedPlacement(admission.entity.placement, translation);
            const entityAdmissions = normalized.filter((candidate) => candidate.entity.id === id);
            const representations = entityAdmissions.map((candidate) => candidate.selected);
            const hashInput: CanonicalEntity = {
              ...admission.entity,
              typeId:
                admission.resolvedGeometry.kind === 'surface3d'
                  ? 'hcad.surface-3d@1'
                  : admission.entity.typeId,
              placement,
              representations,
              versionHash: '00'.repeat(32),
            };
            entity = {
              ...hashInput,
              versionHash: kernel.session.canonicalEntityVersionHash(hashInput),
            };
            entities.set(id, entity);
            entityStylesRef.current.set(id, IFC_STYLE);
            entityExaggerationDatumsRef.current.set(id, translation[2]);
          }
          return {
            admission: { ...admission, entity, representationSlot: 'primary' },
            style: IFC_STYLE,
          };
        });
        const loaded = new Set<EntityId>();
        let rejected = 0;
        for (const admission of admissions) {
          try {
            kernel.session.loadCanonical([admission]);
            loaded.add(admission.admission.entity.id as EntityId);
          } catch {
            rejected += 1;
          }
        }
        if (rejected > 0) {
          callbacksRef.current.onLog(
            'warn',
            `IFC viewer projection skipped ${rejected.toLocaleString()} unsupported body geometries`,
          );
        }
        kernel.requestFrame();
        return [...loaded];
      },
      async loadRasterImage(imageUrl, options) {
        const kernel = await readyRef.current.promise;
        const dimensions = options.rasterSize
          ? { width: options.rasterSize[0], height: options.rasterSize[1] }
          : await decodeImageDimensions(imageUrl);
        await loadPreparedRaster(kernel, imageUrl, null, dimensions.width, dimensions.height, options, {
          min: options.origin[2],
          max: options.origin[2],
        });
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
          min: [Math.min(options.origin[0], last[0]), Math.min(options.origin[1], last[1]), options.origin[2]],
          max: [Math.max(options.origin[0], last[0]), Math.max(options.origin[1], last[1]), options.origin[2]],
        });
        kernel.requestFrame();
      },
      async loadDrapedRaster(imageUrl, depthUrl, options) {
        const kernel = await readyRef.current.promise;
        const dimensions = options.rasterSize
          ? { width: options.rasterSize[0], height: options.rasterSize[1] }
          : await decodeImageDimensions(imageUrl);
        await loadPreparedRaster(kernel, imageUrl, depthUrl, dimensions.width, dimensions.height, options, {
          min: 482.035,
          max: 560.356,
        });
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
      setNavigationMode(mode) {
        kernelRef.current?.navigation.setLockedTopDown(mode === 'lockedTopDown2d');
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
    }),
    [frameAll],
  );

  const handleReady = useCallback((handle: KernelViewportHandle) => {
    kernelRef.current = handle;
    if (import.meta.env.DEV) Object.assign(window, { __hcadBuilderKernel: handle });
    handle.session.setClearColor([0.008, 0.011, 0.016, 1]);
    handle.session.setPointSize(pointSizeRef.current);
    readyRef.current.resolve(handle);
    callbacksRef.current.onLog(
      'info',
      `Shared viewer ready (${handle.hardwarePolicy.deploymentProfile}, ${handle.session.diagnostics().capabilities.backend})`,
    );
  }, []);

  const handlePick = useCallback((candidate: KernelPickCandidate | null) => {
    callbacksRef.current.onCursorSnap(candidate ? snapFromCandidate(candidate) : null);
  }, []);

  const handleCursor = useCallback((coordinate: KernelPickCandidate['worldPosition']) => {
    setCursor({ x: coordinate.x, y: coordinate.y, z: coordinate.z ?? 0 });
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
      className={styles.root}
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
        onError={handleError}
      />
      <output className={styles.coordinates} aria-label="Cursor coordinates">
        {cursor ? (
          <>
            <span>X</span> {formatCoordinate(cursor.x)} <span>Y</span> {formatCoordinate(cursor.y)}{' '}
            <span>Z</span> {formatCoordinate(cursor.z)}
          </>
        ) : (
          'X —   Y —   Z —'
        )}
      </output>
      {dragging ? <div className={styles.dropOverlay}>Drop LAS / LAZ to import</div> : null}
    </div>
  );
});

interface Bounds {
  readonly min: readonly [number, number, number];
  readonly max: readonly [number, number, number];
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

function translatedPlacement(
  placement: CanonicalEntity['placement'],
  translation: readonly [number, number, number],
): CanonicalEntity['placement'] {
  const matrix = [...(placement ?? IDENTITY)] as CanonicalEntity['placement'] & number[];
  matrix[12] = (matrix[12] ?? 0) + translation[0];
  matrix[13] = (matrix[13] ?? 0) + translation[1];
  matrix[14] = (matrix[14] ?? 0) + translation[2];
  return matrix;
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

function canonicalRenderAdmission(
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
    componentsRef: EMPTY_HASH_A,
    attributesRef: EMPTY_HASH_B,
    relationsRef: EMPTY_HASH_C,
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
    position: candidate.presentationPosition,
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
  const sourceTiles = options.tiles ?? [
    { x: 0, y: 0, width, height, imageUrl, depthUrl },
  ];
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
        if (!elevations.some((value) => Number.isFinite(value) && Math.abs(value - 482.75) > 1e-5)) {
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
  const renderAdmission = canonicalRenderAdmission(
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
