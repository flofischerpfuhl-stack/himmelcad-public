import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from 'react';

import type { EntityId, SnapKind, SnapResult, Vec3 } from '@himmelcad/data';
import type {
  CanonicalEntity,
  CanonicalRepresentationAdmission,
  GeometryObject,
  GeometryResource,
  HimmelcadViewerWasmLoader,
  KernelCanonicalRenderAdmission,
  KernelPickCandidate,
  KernelRenderStyle,
  KernelViewerEntityHandle,
  Representation,
} from '@himmelcad/viewer/kernel';
import { KernelViewport, type KernelViewportHandle } from '@himmelcad/viewer/kernel/react';

import styles from './PhotolabKernelViewport.module.css';

const EMPTY_HASH_A = '01'.repeat(32);
const EMPTY_HASH_B = '02'.repeat(32);
const EMPTY_HASH_C = '03'.repeat(32);
const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1] as const;

const viewerWasmUrl = new URL('viewer-wasm/himmelcad_wasm.js', window.location.href).href;
const decodeWasmUrl = new URL('viewer-decode-wasm/himmelcad_decode_wasm.js', window.location.href)
  .href;
const wasmLoader: HimmelcadViewerWasmLoader = async () =>
  import(/* @vite-ignore */ viewerWasmUrl);

const SOURCE_STYLE: KernelRenderStyle = renderStyle([0.72, 0.82, 0.9, 1], 'source');
const RASTER_STYLE: KernelRenderStyle = renderStyle([1, 1, 1, 1], 'source');
const MESH_STYLE: KernelRenderStyle = renderStyle([0.82, 0.84, 0.88, 1], 'source');

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
  readonly role: string;
}

export interface PreparedMeshDescriptor {
  readonly datasetId: string;
  readonly providerId: string;
  readonly providerVersion: string;
  readonly renderManifestRelativePath: string;
  readonly renderManifestResource: GeometryResource;
  readonly preparationDescriptorRelativePath: string;
  readonly preparationDescriptorResource: GeometryResource;
  readonly sectionTopologyRelativePath: string;
  readonly sectionTopologyResource: GeometryResource;
  readonly canonicalAdmission: CanonicalRepresentationAdmission;
}

export interface PhotolabKernelViewportHandle {
  loadPotreePointCloud(
    metadataUrl: string,
    options: {
      entityId: EntityId;
      sourceName: string;
      bounds: { min: readonly [number, number, number]; max: readonly [number, number, number] };
      pointCount: number;
      loadToken?: string;
    },
  ): Promise<void>;
  loadPreparedMesh(
    descriptor: PreparedMeshDescriptor,
    resolveProjectUrl: (relativePath: string) => string,
    loadToken?: string,
  ): Promise<void>;
  loadRasterPyramid(
    manifestUrl: string,
    options: { entityId: EntityId; kind: 'dem' | 'orthomosaic'; loadToken?: string },
  ): Promise<void>;
  loadGaussianSplats(
    manifestUrl: string,
    options: { entityId: EntityId; loadToken?: string; format: 'prepared' | 'brushPly' },
  ): Promise<void>;
  removeLayer(entityId: EntityId): void;
  resetProjectScene(offset: readonly [number, number, number]): void;
  setSceneRenderOffset(offset: readonly [number, number, number]): void;
  setNavigationMode(mode: 'orbit3d' | 'lockedTopDown2d'): void;
  setCameraImageRectangles(rectangles: readonly CameraImageRectangle[]): void;
  setGcpMarkers(markers: readonly GcpMarker[]): void;
  frameAll(): void;
  frameSelection(entityIds: readonly EntityId[]): boolean;
}

export const PhotolabKernelViewport = forwardRef<
  PhotolabKernelViewportHandle,
  {
    readonly onCursorSnap: (snap: SnapResult | null) => void;
    readonly onLog: (level: 'debug' | 'info' | 'warn' | 'error', message: string) => void;
  }
>(function PhotolabKernelViewport({ onCursorSnap, onLog }, ref): JSX.Element {
  const kernelRef = useRef<KernelViewportHandle | null>(null);
  const readyRef = useRef(createDeferred<KernelViewportHandle>());
  const handlesRef = useRef(new Map<EntityId, KernelViewerEntityHandle>());
  const boundsRef = useRef(new Map<EntityId, Bounds>());
  const cameraAnnotationIdsRef = useRef(new Set<EntityId>());
  const gcpAnnotationIdsRef = useRef(new Set<EntityId>());
  const callbacksRef = useRef({ onCursorSnap, onLog });
  const navigationModeRef = useRef<'orbit3d' | 'lockedTopDown2d'>('orbit3d');
  callbacksRef.current = { onCursorSnap, onLog };
  const [cursor, setCursor] = useState<Vec3 | null>(null);

  const unload = useCallback((entityId: EntityId) => {
    const handle = handlesRef.current.get(entityId);
    if (handle?.loaded) handle.unload();
    handlesRef.current.delete(entityId);
    boundsRef.current.delete(entityId);
  }, []);

  const frameBounds = useCallback((bounds: Bounds): void => {
    const kernel = kernelRef.current;
    if (!kernel) return;
    kernel.camera.frame(tuplePoint(bounds.min), tuplePoint(bounds.max));
    kernel.session.setWorldCamera(
      kernel.camera.worldCamera(),
      kernel.camera.recommendedFloatingOrigin(),
    );
    kernel.requestFrame();
  }, []);

  const frameAll = useCallback(() => {
    const all = [...boundsRef.current.values()];
    if (all.length > 0) frameBounds(all.reduce(unionBounds));
  }, [frameBounds]);

  const replaceAnnotations = useCallback(
    async (
      category: 'camera' | 'gcp',
      admissions: readonly KernelCanonicalRenderAdmission[],
    ): Promise<void> => {
      const kernel = await readyRef.current.promise;
      const ids = category === 'camera' ? cameraAnnotationIdsRef.current : gcpAnnotationIdsRef.current;
      for (const id of ids) unload(id);
      ids.clear();
      for (const handle of kernel.session.loadCanonical(admissions)) {
        const id = handle.entityId as EntityId;
        handlesRef.current.set(id, handle);
        ids.add(id);
      }
      kernel.requestFrame();
    },
    [unload],
  );

  useImperativeHandle(
    ref,
    () => ({
      async loadPotreePointCloud(metadataUrl, options) {
        const kernel = await readyRef.current.promise;
        assertCurrentLoad(options.loadToken);
        const metadata = await fetchBytes(metadataUrl);
        assertCurrentLoad(options.loadToken);
        const datasetId = `potree-${await sha256Hex(metadata)}`;
        const geometry: GeometryObject = {
          kind: 'pointCloud',
          dataset: {
            formatId: 'potree@2',
            metadata: resource(await sha256Hex(metadata), 'application/json', metadata.byteLength),
            elementCount: options.pointCount,
          },
        };
        const admission = canonicalRepresentationAdmission(
          kernel,
          options.entityId,
          options.sourceName,
          geometry,
        );
        unload(options.entityId);
        const handle = await kernel.session.loadPotree(
          { datasetId, metadataUri: metadataUrl, admission, style: SOURCE_STYLE },
          { operationId: options.loadToken ?? `photolab/potree/${options.entityId}` },
        );
        handlesRef.current.set(options.entityId, handle);
        boundsRef.current.set(options.entityId, options.bounds);
      },
      async loadPreparedMesh(descriptor, resolveProjectUrl, loadToken) {
        const kernel = await readyRef.current.promise;
        assertCurrentLoad(loadToken);
        const entityId = descriptor.canonicalAdmission.entity.id as EntityId;
        unload(entityId);
        const handle = (
          await kernel.session.loadPreparedMesh(
            {
              datasetId: descriptor.datasetId,
              manifestUri: resolveProjectUrl(descriptor.renderManifestRelativePath),
              preparationUri: resolveProjectUrl(descriptor.preparationDescriptorRelativePath),
              preparationResource: descriptor.preparationDescriptorResource,
              sectionTopologyUri: resolveProjectUrl(descriptor.sectionTopologyRelativePath),
              sectionTopologyResource: descriptor.sectionTopologyResource,
              admission: descriptor.canonicalAdmission,
              providerId: descriptor.providerId,
              providerVersion: descriptor.providerVersion,
              style: MESH_STYLE,
            },
            { operationId: loadToken ?? `photolab/mesh/${descriptor.datasetId}` },
          )
        ).handle;
        handlesRef.current.set(entityId, handle);
        const manifest = await fetchJson<PreparedHierarchyManifest>(
          resolveProjectUrl(descriptor.renderManifestRelativePath),
        );
        const bounds = hierarchyBounds(manifest);
        if (bounds) boundsRef.current.set(entityId, bounds);
      },
      async loadRasterPyramid(manifestUrl, options) {
        const kernel = await readyRef.current.promise;
        assertCurrentLoad(options.loadToken);
        const legacy = await fetchJson<RasterPyramidManifest>(manifestUrl);
        const viewerManifestUrl = new URL('../viewer/manifest.json', manifestUrl).href;
        const manifestBytes = await fetchBytes(viewerManifestUrl);
        const metadataHash = await sha256Hex(manifestBytes);
        const datasetId = `raster-${metadataHash}`;
        const geometry: GeometryObject = {
          kind: 'rasterImage',
          raster: {
            pixels: resource(metadataHash, 'himmelcad-prepared-hierarchy@1', manifestBytes.length),
            width: legacy.grid.widthPixels,
            height: legacy.grid.heightPixels,
            mapping: {
              kind: 'orthoGrid',
              origin: {
                x: legacy.grid.bounds.minimumEast + legacy.grid.gsd * 0.5,
                y: legacy.grid.bounds.maximumNorth - legacy.grid.gsd * 0.5,
                z: 0,
              },
              columnStep: { x: legacy.grid.gsd, y: 0, z: 0 },
              rowStep: { x: 0, y: -legacy.grid.gsd, z: 0 },
            },
            depth: null,
          },
        };
        const admission = canonicalRenderAdmission(
          kernel,
          options.entityId,
          options.kind === 'dem' ? 'DEM' : 'Orthomosaic',
          geometry,
        );
        unload(options.entityId);
        const [handle] = kernel.session.loadPreparedHierarchy({
          datasetId,
          formatId: 'himmelcad-prepared-hierarchy@1',
          manifestUri: viewerManifestUrl,
          manifestBytes,
          admissions: [{ ...admission, datasetId, style: RASTER_STYLE }],
        });
        if (!handle) throw new Error('raster hierarchy published no canonical handle');
        handlesRef.current.set(options.entityId, handle);
        const prepared = JSON.parse(new TextDecoder().decode(manifestBytes)) as PreparedHierarchyManifest;
        const bounds = hierarchyBounds(prepared);
        if (bounds) boundsRef.current.set(options.entityId, bounds);
      },
      async loadGaussianSplats(manifestUrl, options) {
        if (options.format !== 'prepared') {
          throw new Error('monolithic Brush PLY must be prepared before interactive viewing');
        }
        const kernel = await readyRef.current.promise;
        const source = await fetchJson<LegacySplatManifest>(manifestUrl);
        const prepared = preparedSplatManifest(source);
        const manifestBytes = new TextEncoder().encode(JSON.stringify(prepared));
        const metadataHash = await sha256Hex(manifestBytes);
        const datasetId = `splats-${metadataHash}`;
        const geometry: GeometryObject = {
          kind: 'gaussianSplatCloud',
          dataset: {
            formatId: 'himmelcad-prepared-hierarchy@1',
            metadata: resource(metadataHash, 'himmelcad-prepared-hierarchy@1', manifestBytes.length),
            elementCount: source.tiles.reduce((total, tile) => total + tile.splatCount, 0),
          },
        };
        const admission = canonicalRenderAdmission(
          kernel,
          options.entityId,
          'Gaussian Splats',
          geometry,
        );
        unload(options.entityId);
        const [handle] = kernel.session.loadPreparedHierarchy({
          datasetId,
          formatId: 'himmelcad-prepared-hierarchy@1',
          manifestUri: manifestUrl,
          manifestBytes,
          admissions: [{ ...admission, datasetId, style: SOURCE_STYLE }],
        });
        if (!handle) throw new Error('splat hierarchy published no canonical handle');
        handlesRef.current.set(options.entityId, handle);
        const bounds = hierarchyBounds(prepared);
        if (bounds) boundsRef.current.set(options.entityId, bounds);
      },
      removeLayer: unload,
      resetProjectScene() {
        for (const id of [...handlesRef.current.keys()]) unload(id);
      },
      setSceneRenderOffset() {
        // The kernel keeps authoritative f64 project coordinates and applies a
        // floating GPU origin itself; product-side render offsets are obsolete.
      },
      setNavigationMode(mode) {
        navigationModeRef.current = mode;
        kernelRef.current?.navigation.setLockedTopDown(mode === 'lockedTopDown2d');
      },
      setCameraImageRectangles(rectangles) {
        void (async () => {
          const kernel = await readyRef.current.promise;
          const admissions: KernelCanonicalRenderAdmission[] = [];
          for (const rectangle of rectangles) {
            const points = [rectangle.cameraCenter, ...rectangle.corners] as const;
            const pairs = [
              [1, 2], [2, 3], [3, 4], [4, 1], [0, 1], [0, 2], [0, 3], [0, 4],
            ] as const;
            for (const [index, [from, to]] of pairs.entries()) {
              const id = `${rectangle.entityId}:camera-line:${index}` as EntityId;
              admissions.push(
                canonicalRenderAdmission(
                  kernel,
                  id,
                  'Camera footprint',
                  {
                    kind: 'curve',
                    curve: {
                      kind: 'lineSegment',
                      start: tuplePosition(points[from]),
                      end: tuplePosition(points[to]),
                    },
                  },
                  renderStyle(rectangle.aligned ? [0.28, 0.7, 1, 1] : [0.55, 0.58, 0.64, 1]),
                ),
              );
            }
          }
          await replaceAnnotations('camera', admissions);
        })().catch((error: unknown) =>
          callbacksRef.current.onLog('error', `Camera overlays could not be published: ${errorMessage(error)}`),
        );
      },
      setGcpMarkers(markers) {
        void (async () => {
          const kernel = await readyRef.current.promise;
          const admissions = markers.map((marker) =>
            canonicalRenderAdmission(
              kernel,
              marker.entityId,
              marker.name,
              { kind: 'point', position: tuplePosition(marker.position) },
              renderStyle(
                marker.role.startsWith('checkpoint') ? [1, 0.68, 0.12, 1] : [1, 0.2, 0.25, 1],
              ),
            ),
          );
          await replaceAnnotations('gcp', admissions);
        })().catch((error: unknown) =>
          callbacksRef.current.onLog('error', `GCP overlays could not be published: ${errorMessage(error)}`),
        );
      },
      frameAll,
      frameSelection(entityIds) {
        const selected = entityIds.flatMap((id) => {
          const bounds = boundsRef.current.get(id);
          return bounds ? [bounds] : [];
        });
        if (selected.length === 0) return false;
        frameBounds(selected.reduce(unionBounds));
        return true;
      },
    }),
    [frameAll, frameBounds, replaceAnnotations, unload],
  );

  useEffect(() => () => {
    for (const handle of handlesRef.current.values()) if (handle.loaded) handle.unload();
  }, []);

  return (
    <div className={styles.root}>
      <KernelViewport
        wasmLoader={wasmLoader}
        backend="automatic"
        presentationMode="windowMask"
        decodeWasmModuleUrl={decodeWasmUrl}
        authoritativeSectionTolerance={0.001}
        onReady={(handle) => {
          kernelRef.current = handle;
          handle.session.setClearColor([0.008, 0.011, 0.016, 1]);
          handle.navigation.setLockedTopDown(navigationModeRef.current === 'lockedTopDown2d', 0);
          readyRef.current.resolve(handle);
          callbacksRef.current.onLog(
            'info',
            `Shared viewer ready (${handle.hardwarePolicy.deploymentProfile}, ${handle.session.diagnostics().capabilities.backend})`,
          );
        }}
        onActivePick={(candidate) => callbacksRef.current.onCursorSnap(snapFromCandidate(candidate))}
        onCursorCoordinate={(coordinate) =>
          setCursor({ x: coordinate.x, y: coordinate.y, z: coordinate.z ?? 0 })
        }
        onError={(error) => {
          readyRef.current.reject(error);
          callbacksRef.current.onLog('error', error.message);
        }}
      />
      <output className={styles.coordinates} aria-label="Cursor coordinates">
        {cursor
          ? `X ${cursor.x.toFixed(3)}  Y ${cursor.y.toFixed(3)}  Z ${cursor.z.toFixed(3)}`
          : 'X —   Y —   Z —'}
      </output>
    </div>
  );
});

interface Bounds {
  readonly min: readonly [number, number, number];
  readonly max: readonly [number, number, number];
}
interface PreparedHierarchyManifest {
  readonly schemaVersion: number;
  readonly roots: readonly string[];
  readonly tiles: readonly PreparedTile[];
}
interface PreparedTile {
  readonly bounds: { readonly kind: string; readonly bounds?: { readonly min: Vec3; readonly max: Vec3 } };
}
interface RasterPyramidManifest {
  readonly grid: {
    readonly widthPixels: number;
    readonly heightPixels: number;
    readonly gsd: number;
    readonly bounds: {
      readonly minimumEast: number;
      readonly minimumNorth: number;
      readonly maximumEast: number;
      readonly maximumNorth: number;
    };
  };
}
interface LegacySplatManifest {
  readonly schemaVersion: 1;
  readonly rootTileId: string;
  readonly tiles: readonly {
    readonly id: string;
    readonly parent: string | null;
    readonly children: readonly string[];
    readonly bounds: Bounds;
    readonly origin: readonly [number, number, number];
    readonly geometricError: number;
    readonly splatCount: number;
    readonly dataUrl: string;
  }[];
}

function preparedSplatManifest(source: LegacySplatManifest): PreparedHierarchyManifest {
  return {
    schemaVersion: 1,
    roots: [source.rootTileId],
    tiles: source.tiles.map((tile) => ({
      id: tile.id,
      parent: tile.parent,
      children: tile.children,
      bounds: {
        kind: 'axisAlignedBox',
        bounds: { min: tuplePoint(tile.bounds.min), max: tuplePoint(tile.bounds.max) },
      },
      contentTransform: IDENTITY,
      geometricError: tile.geometricError,
      refinement: 'add',
      contents: [
        {
          kind: 'gaussianSplats',
          uri: tile.dataUrl,
          byteOffset: null,
          byteLength: null,
          primitiveCount: tile.splatCount,
          contentHash: null,
          decoderParameters: { encoding: 'hcsplatInterleavedV1', origin: tile.origin },
        },
      ],
      childPage: null,
    })) as unknown as readonly PreparedTile[],
  };
}

function canonicalRepresentationAdmission(
  kernel: KernelViewportHandle,
  entityId: EntityId,
  name: string,
  geometry: GeometryObject,
): CanonicalRepresentationAdmission {
  const selected: Representation = {
    role: 'canonical',
    geometryRef: kernel.session.geometryObjectContentHash(geometry),
    authority: 'authoritative',
    dependencyHash: null,
  };
  const base = {
    id: entityId,
    revision: 1,
    typeId: geometryTypeId(geometry),
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
  const entity: CanonicalEntity = {
    ...base,
    versionHash: kernel.session.canonicalEntityVersionHash({ ...base, versionHash: '00'.repeat(32) }),
  };
  const admission: CanonicalRepresentationAdmission = {
    entity,
    selected,
    representationSlot: 'primary',
    expectedGeneration: null,
    resolvedGeometry: geometry,
  };
  return admission;
}

function canonicalRenderAdmission(
  kernel: KernelViewportHandle,
  entityId: EntityId,
  name: string,
  geometry: GeometryObject,
  style?: KernelRenderStyle,
): KernelCanonicalRenderAdmission {
  const admission = canonicalRepresentationAdmission(kernel, entityId, name, geometry);
  return style === undefined ? { admission } : { admission, style };
}

function geometryTypeId(geometry: GeometryObject): string {
  if (geometry.kind === 'pointCloud') return 'hcad.point-cloud@1';
  if (geometry.kind === 'gaussianSplatCloud') return 'hcad.gaussian-splat-cloud@1';
  if (geometry.kind === 'rasterImage') return 'hcad.raster-image@1';
  if (geometry.kind === 'curve') return 'hcad.curve@1';
  return 'hcad.point@1';
}

function resource(objectHash: string, mediaType: string, byteLength: number): GeometryResource {
  return { objectHash, mediaType, byteLength };
}

function renderStyle(
  baseColor: readonly [number, number, number, number],
  color: 'source' | 'uniform' = 'uniform',
): KernelRenderStyle {
  return {
    baseColor,
    opacity: 1,
    verticalExaggeration: 1,
    colorMode: { kind: color },
    fill: { kind: 'color' },
    stroke: {
      mode: { kind: 'color' },
      color: { kind: 'inherit' },
      width: { kind: 'screen', pixels: 1.25 },
      cap: 'butt',
      join: 'miter',
      miterLimit: 4,
    },
  };
}

function hierarchyBounds(manifest: PreparedHierarchyManifest): Bounds | null {
  const boxes: Bounds[] = manifest.tiles.flatMap((tile) => {
    const bounds = tile.bounds.bounds;
    return tile.bounds.kind === 'axisAlignedBox' && bounds
      ? [{ min: pointTuple(bounds.min), max: pointTuple(bounds.max) }]
      : [];
  });
  return boxes.length > 0 ? boxes.reduce(unionBounds) : null;
}

function unionBounds(left: Bounds, right: Bounds): Bounds {
  return {
    min: [0, 1, 2].map((axis) => Math.min(left.min[axis]!, right.min[axis]!)) as [number, number, number],
    max: [0, 1, 2].map((axis) => Math.max(left.max[axis]!, right.max[axis]!)) as [number, number, number],
  };
}
function tuplePoint(value: readonly [number, number, number]): Vec3 {
  return { x: value[0], y: value[1], z: value[2] };
}
function pointTuple(value: Vec3): [number, number, number] {
  return [value.x, value.y, value.z];
}
function tuplePosition(value: readonly [number, number, number]): { x: number; y: number; z: number } {
  return tuplePoint(value);
}
function snapFromCandidate(candidate: KernelPickCandidate | null): SnapResult | null {
  if (!candidate) return null;
  return {
    position: candidate.presentationPosition,
    kind: snapKind(candidate.snapKind),
    entity: candidate.address.entityId as EntityId,
    confidence: 1 / (1 + Math.max(0, candidate.pixelDistance)),
    source: snapSource(candidate),
    distancePx: candidate.pixelDistance,
    stable: true,
    candidateId: `${candidate.address.renderProxyId}:${candidate.address.tileId ?? ''}:${String(candidate.address.primitiveId ?? '')}`,
  };
}
function snapSource(candidate: KernelPickCandidate): 'grid' | 'point-cloud' | 'cad' {
  if (candidate.snapKind === 'rasterSample') return 'grid';
  return candidate.address.tileId ? 'point-cloud' : 'cad';
}
function snapKind(kind: KernelPickCandidate['snapKind']): SnapKind {
  if (kind === 'point') return 'Point';
  if (kind === 'vertex' || kind === 'midpoint') return 'Vertex';
  if (kind === 'edge' || kind === 'intersection') return 'Edge';
  if (kind === 'rasterSample') return 'Grid';
  return 'Face';
}
async function fetchBytes(url: string): Promise<Uint8Array> {
  const response = await fetch(url, { cache: 'force-cache' });
  if (!response.ok) throw new Error(`Resource request failed (${response.status})`);
  return new Uint8Array(await response.arrayBuffer());
}
async function fetchJson<T>(url: string): Promise<T> {
  const response = await fetch(url, { cache: 'force-cache' });
  if (!response.ok) throw new Error(`Manifest request failed (${response.status})`);
  return (await response.json()) as T;
}
async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes.slice().buffer));
  return [...digest].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}
function assertCurrentLoad(_token?: string): void {}
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
function createDeferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
