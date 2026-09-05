import type { CanonicalRepresentationAdmission } from './generated/index.js';
import type { KernelStreamingDriver } from './KernelStreamingDriver.js';
import { reportLoadProgress, type KernelLoadOperationOptions } from './KernelLoadOperation.js';
import type {
  KernelCanonicalEntityMutation,
  KernelCanonicalRenderAdmission,
  KernelRenderStyle,
  WgpuKernelViewer,
} from './WgpuKernelViewer.js';

const MAX_INITIAL_HIERARCHY_BYTES = 64 * 1024 * 1024;

/** Importer/project payload needed to admit one prepared Potree dataset. */
export interface KernelPotreeDatasetAdmission {
  readonly datasetId: string;
  readonly metadataUri: string;
  readonly admission: CanonicalRepresentationAdmission;
  readonly style?: KernelRenderStyle;
  /** Optional independently hashed bake contract; Potree metadata stays byte-for-byte unchanged. */
  readonly preparedMetadata?: KernelPreparedPointDatasetMetadata;
}

export interface KernelPreparedPointDatasetMetadata {
  readonly schemaVersion: 1;
  readonly rawSourceContentHash: string | null;
  readonly nodes: Readonly<Record<string, KernelPreparedPointNodeMetadata>>;
}

export interface KernelPreparedPointNodeMetadata {
  readonly screenSpaceError: {
    readonly geometricError: number;
    readonly pointSpacing: number;
  };
  readonly sampleStatistics: {
    readonly sampledPoints: number;
    readonly sourcePoints: number | null;
    readonly method: string | null;
  };
  /** `null` means the source did not declare station partitioning. */
  readonly stationIds: readonly string[] | null;
  /** Null is resolved from fetched bytes and cached by the streaming driver. */
  readonly contentHash: string | null;
  readonly origin: 'baked';
}

interface PotreeAdmissionTarget {
  geometryObjectContentHash(geometry: CanonicalRepresentationAdmission['resolvedGeometry']): string;
  canonicalEntityVersionHash(entity: CanonicalRepresentationAdmission['entity']): string;
  registerPotreeDataset(
    datasetId: string,
    formatId: string,
    metadataUri: string,
    metadataJson: Uint8Array,
    firstHierarchyChunk: Uint8Array,
    preparedMetadataJson: Uint8Array,
  ): void;
  publishCanonicalRepresentations(
    admissions: readonly KernelCanonicalRenderAdmission[],
  ): KernelCanonicalEntityMutation;
}

interface ImmutableResourceFetcher {
  fetchImmutableResource(
    reference: {
      readonly uri: string;
      readonly byteOffset: number | null;
      readonly byteLength: number | null;
    },
    signal?: AbortSignal,
  ): Promise<Uint8Array>;
}

/**
 * Fetches, verifies, registers and atomically publishes one canonical Potree entity.
 * Bootstrap requests share the driver's kernel-resolved HTTP concurrency ceiling.
 */
export async function admitCanonicalPotreeDataset(
  viewer: WgpuKernelViewer,
  streaming: KernelStreamingDriver,
  input: KernelPotreeDatasetAdmission,
  signal?: AbortSignal,
  progress?: KernelLoadOperationOptions['onProgress'],
): Promise<KernelCanonicalEntityMutation> {
  return admitCanonicalPotreeDatasetWith(viewer, streaming, input, signal, progress);
}

export async function admitCanonicalPotreeDatasetWith(
  viewer: PotreeAdmissionTarget,
  streaming: ImmutableResourceFetcher,
  input: KernelPotreeDatasetAdmission,
  signal?: AbortSignal,
  progress?: KernelLoadOperationOptions['onProgress'],
): Promise<KernelCanonicalEntityMutation> {
  const total = 4;
  reportLoadProgress(progress, 'validating', 0, total);
  signal?.throwIfAborted();
  if (input.datasetId.length === 0 || input.metadataUri.length === 0) {
    throw new RangeError('Potree dataset and metadata URI must be non-empty');
  }
  const geometry = input.admission.resolvedGeometry;
  if (geometry.kind !== 'pointCloud') {
    throw new TypeError('Potree admission requires canonical point-cloud geometry');
  }
  if (geometry.dataset.formatId !== 'potree@2') {
    throw new TypeError('Potree admission requires formatId potree@2');
  }
  if (viewer.geometryObjectContentHash(geometry) !== input.admission.selected.geometryRef) {
    throw new Error('canonical Potree geometry hash does not match the selected representation');
  }
  if (
    viewer.canonicalEntityVersionHash(input.admission.entity) !== input.admission.entity.versionHash
  ) {
    throw new Error('canonical Potree entity version hash does not match its envelope');
  }

  reportLoadProgress(progress, 'fetching', 0, total);
  const metadataBytes = await streaming.fetchImmutableResource(
    { uri: input.metadataUri, byteOffset: null, byteLength: null },
    signal,
  );
  if (
    geometry.dataset.metadata.byteLength !== null &&
    metadataBytes.byteLength !== geometry.dataset.metadata.byteLength
  ) {
    throw new Error('Potree metadata byte length does not match canonical geometry');
  }
  if ((await sha256Hex(metadataBytes)) !== geometry.dataset.metadata.objectHash) {
    throw new Error('Potree metadata content does not match canonical geometry');
  }
  signal?.throwIfAborted();
  reportLoadProgress(progress, 'verifying', 1, total);
  const firstChunkSize = parseFirstHierarchyChunkSize(metadataBytes);
  const preparedMetadataBytes = encodePreparedMetadata(input.preparedMetadata);
  const hierarchyUri = resolveSiblingUri(input.metadataUri, 'hierarchy.bin');
  const firstHierarchyChunk = await streaming.fetchImmutableResource(
    { uri: hierarchyUri, byteOffset: 0, byteLength: firstChunkSize },
    signal,
  );
  signal?.throwIfAborted();
  reportLoadProgress(progress, 'publishing', 3, total);

  viewer.registerPotreeDataset(
    input.datasetId,
    geometry.dataset.formatId,
    input.metadataUri,
    metadataBytes,
    firstHierarchyChunk,
    preparedMetadataBytes,
  );
  const mutation = viewer.publishCanonicalRepresentations([
    {
      admission: input.admission,
      datasetId: input.datasetId,
      ...(input.style === undefined ? {} : { style: input.style }),
    },
  ]);
  reportLoadProgress(progress, 'complete', total, total);
  return mutation;
}

function encodePreparedMetadata(
  metadata: KernelPreparedPointDatasetMetadata | undefined,
): Uint8Array {
  if (metadata === undefined) return new Uint8Array(0);
  if (
    metadata.schemaVersion !== 1 ||
    (metadata.rawSourceContentHash !== null && !canonicalSha256(metadata.rawSourceContentHash))
  ) {
    throw new TypeError('prepared point dataset metadata header is invalid');
  }
  for (const [nodeId, node] of Object.entries(metadata.nodes)) {
    const stations = node.stationIds;
    if (
      nodeId.length === 0 ||
      node.origin !== 'baked' ||
      !Number.isFinite(node.screenSpaceError.geometricError) ||
      node.screenSpaceError.geometricError <= 0 ||
      !Number.isFinite(node.screenSpaceError.pointSpacing) ||
      node.screenSpaceError.pointSpacing <= 0 ||
      !Number.isSafeInteger(node.sampleStatistics.sampledPoints) ||
      node.sampleStatistics.sampledPoints < 0 ||
      (node.sampleStatistics.sourcePoints !== null &&
        (!Number.isSafeInteger(node.sampleStatistics.sourcePoints) ||
          node.sampleStatistics.sourcePoints < node.sampleStatistics.sampledPoints)) ||
      (node.contentHash !== null && !canonicalSha256(node.contentHash)) ||
      (stations !== null &&
        (stations.some((station) => station.length === 0) || new Set(stations).size !== stations.length))
    ) {
      throw new TypeError(`prepared point node metadata is invalid: ${nodeId}`);
    }
  }
  return new TextEncoder().encode(JSON.stringify(metadata));
}

function canonicalSha256(value: string): boolean {
  return /^[0-9a-f]{64}$/.test(value);
}

function parseFirstHierarchyChunkSize(bytes: Uint8Array): number {
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch (error) {
    throw new TypeError(`Potree metadata is not valid UTF-8 JSON: ${errorMessage(error)}`);
  }
  if (!record(value) || !record(value.hierarchy)) {
    throw new TypeError('Potree metadata has no hierarchy object');
  }
  const size = value.hierarchy.firstChunkSize;
  if (
    !Number.isSafeInteger(size) ||
    Number(size) <= 0 ||
    Number(size) > MAX_INITIAL_HIERARCHY_BYTES
  ) {
    throw new RangeError('Potree hierarchy.firstChunkSize is outside the bounded bootstrap range');
  }
  return Number(size);
}

function resolveSiblingUri(mainUri: string, relative: string): string {
  try {
    return new URL(relative, mainUri).toString();
  } catch {
    const slash = mainUri.lastIndexOf('/');
    return slash < 0 ? relative : `${mainUri.slice(0, slash + 1)}${relative}`;
  }
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes.slice().buffer));
  return [...digest].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
