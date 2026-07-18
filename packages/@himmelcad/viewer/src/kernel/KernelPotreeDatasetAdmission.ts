import type { CanonicalRepresentationAdmission } from './generated/index.js';
import type { KernelStreamingDriver } from './KernelStreamingDriver.js';
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
}

interface PotreeAdmissionTarget {
  geometryObjectContentHash(
    geometry: CanonicalRepresentationAdmission['resolvedGeometry'],
  ): string;
  canonicalEntityVersionHash(entity: CanonicalRepresentationAdmission['entity']): string;
  registerPotreeDataset(
    datasetId: string,
    formatId: string,
    metadataUri: string,
    metadataJson: Uint8Array,
    firstHierarchyChunk: Uint8Array,
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
): Promise<KernelCanonicalEntityMutation> {
  return admitCanonicalPotreeDatasetWith(viewer, streaming, input, signal);
}

export async function admitCanonicalPotreeDatasetWith(
  viewer: PotreeAdmissionTarget,
  streaming: ImmutableResourceFetcher,
  input: KernelPotreeDatasetAdmission,
  signal?: AbortSignal,
): Promise<KernelCanonicalEntityMutation> {
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
  if (viewer.canonicalEntityVersionHash(input.admission.entity) !== input.admission.entity.versionHash) {
    throw new Error('canonical Potree entity version hash does not match its envelope');
  }

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
  const firstChunkSize = parseFirstHierarchyChunkSize(metadataBytes);
  const hierarchyUri = resolveSiblingUri(input.metadataUri, 'hierarchy.bin');
  const firstHierarchyChunk = await streaming.fetchImmutableResource(
    { uri: hierarchyUri, byteOffset: 0, byteLength: firstChunkSize },
    signal,
  );

  viewer.registerPotreeDataset(
    input.datasetId,
    geometry.dataset.formatId,
    input.metadataUri,
    metadataBytes,
    firstHierarchyChunk,
  );
  return viewer.publishCanonicalRepresentations([
    {
      admission: input.admission,
      datasetId: input.datasetId,
      ...(input.style === undefined ? {} : { style: input.style }),
    },
  ]);
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
  if (!Number.isSafeInteger(size) || Number(size) <= 0 || Number(size) > MAX_INITIAL_HIERARCHY_BYTES) {
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
