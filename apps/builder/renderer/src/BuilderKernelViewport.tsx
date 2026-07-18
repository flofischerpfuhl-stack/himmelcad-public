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
  type GeometryObject,
  type HimmelcadViewerWasmLoader,
  type KernelPickCandidate,
  type KernelRenderStyle,
  type Representation,
} from '@himmelcad/viewer/kernel';
import { KernelViewport, type KernelViewportHandle } from '@himmelcad/viewer/kernel/react';

import styles from './BuilderKernelViewport.module.css';

const EMPTY_HASH_A = '01'.repeat(32);
const EMPTY_HASH_B = '02'.repeat(32);
const EMPTY_HASH_C = '03'.repeat(32);

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

export interface BuilderKernelViewportHandle {
  loadPotreePointCloud(metadataUrl: string, options: BuilderPointCloudOptions): Promise<void>;
  frameAll(): void;
  setPointSize(pointSize: number): void;
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
        loadedBoundsRef.current = unionBounds(loadedBoundsRef.current, options.bounds);
        frameAll();
      },
      frameAll,
      setPointSize(pointSize) {
        kernelRef.current?.session.setPointSize(pointSize);
      },
    }),
    [frameAll],
  );

  const handleReady = useCallback((handle: KernelViewportHandle) => {
    kernelRef.current = handle;
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
