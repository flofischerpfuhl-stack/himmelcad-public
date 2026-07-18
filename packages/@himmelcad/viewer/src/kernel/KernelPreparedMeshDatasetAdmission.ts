import type {
  CanonicalRepresentationAdmission,
  GeometryResource,
  TriangleMeshGeometry,
} from './generated/index.js';
import type { KernelStreamingDriver } from './KernelStreamingDriver.js';
import type { KernelSectionTopologyPartitionLocation } from './KernelSectionTopologyEvaluation.js';
import type {
  KernelCanonicalEntityMutation,
  KernelCanonicalRenderAdmission,
  KernelPreparedTopologyRegistration,
  KernelRenderStyle,
  WgpuKernelViewer,
} from './WgpuKernelViewer.js';

export interface KernelPreparedMeshDatasetAdmission {
  readonly datasetId: string;
  readonly manifestUri: string;
  readonly preparationUri: string;
  readonly preparationResource: GeometryResource;
  readonly sectionTopologyUri: string;
  readonly sectionTopologyResource: GeometryResource;
  readonly admission: CanonicalRepresentationAdmission;
  readonly providerId: string;
  readonly providerVersion: string;
  readonly style?: KernelRenderStyle;
}

export interface KernelPreparedMeshDatasetResult {
  readonly mutation: KernelCanonicalEntityMutation;
  readonly sectionTopologyParts: readonly KernelSectionTopologyPartitionLocation[];
}

interface PreparedMeshAdmissionTarget {
  geometryObjectContentHash(geometry: CanonicalRepresentationAdmission['resolvedGeometry']): string;
  canonicalEntityVersionHash(entity: CanonicalRepresentationAdmission['entity']): string;
  registerPreparedDatasetAndPublishCanonicalRepresentations(
    datasetId: string,
    formatId: string,
    manifestUri: string,
    manifestJson: Uint8Array,
    admissions: readonly KernelCanonicalRenderAdmission[],
    topology?: readonly KernelPreparedTopologyRegistration[],
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

interface PreparedSectionTopologyIndex {
  readonly schemaVersion: 2;
  readonly closedManifold: boolean;
  readonly materialKeys?: Readonly<Record<string, string>>;
  readonly parts: readonly {
    readonly partId: string;
    readonly topologyHash: string;
    readonly bounds: {
      readonly minimum: readonly [number, number, number];
      readonly maximum: readonly [number, number, number];
    };
    readonly manifestUrl: string;
    readonly positionUrl: string;
    readonly indexUrl: string;
    readonly materialSlotUrl: string | null;
  }[];
}

/** Registers and atomically publishes one resource-backed prepared triangle mesh. */
export async function admitCanonicalPreparedMeshDataset(
  viewer: WgpuKernelViewer,
  streaming: KernelStreamingDriver,
  input: KernelPreparedMeshDatasetAdmission,
  signal?: AbortSignal,
): Promise<KernelPreparedMeshDatasetResult> {
  return admitCanonicalPreparedMeshDatasetWith(viewer, streaming, input, signal);
}

export async function admitCanonicalPreparedMeshDatasetWith(
  viewer: PreparedMeshAdmissionTarget,
  streaming: ImmutableResourceFetcher,
  input: KernelPreparedMeshDatasetAdmission,
  signal?: AbortSignal,
): Promise<KernelPreparedMeshDatasetResult> {
  if (
    input.datasetId.length === 0 ||
    input.manifestUri.length === 0 ||
    input.preparationUri.length === 0 ||
    input.sectionTopologyUri.length === 0 ||
    input.providerId.length === 0 ||
    input.providerVersion.length === 0
  ) {
    throw new RangeError('prepared mesh identity and manifest URIs must be non-empty');
  }
  if (input.sectionTopologyResource.mediaType !== 'hcad.section-topology-index@2') {
    throw new TypeError('prepared mesh requires the bounded section-topology index v2');
  }
  if (input.preparationResource.mediaType !== 'hcad.prepared-triangle-mesh-recipe@1') {
    throw new TypeError('prepared mesh requires the preparation recipe v1');
  }
  const geometry = input.admission.resolvedGeometry;
  const mesh = preparedTriangleMesh(geometry);
  if (mesh === null || mesh.storage.kind !== 'resource') {
    throw new TypeError('prepared mesh admission requires a resource-backed triangle mesh');
  }
  const renderResource = mesh.storage.resource;
  if (renderResource.mediaType !== 'himmelcad-prepared-hierarchy@1') {
    throw new TypeError('prepared mesh render resource must use the kernel hierarchy contract');
  }
  if (viewer.geometryObjectContentHash(geometry) !== input.admission.selected.geometryRef) {
    throw new Error('canonical mesh geometry hash does not match the selected representation');
  }
  if (
    viewer.canonicalEntityVersionHash(input.admission.entity) !== input.admission.entity.versionHash
  ) {
    throw new Error('canonical mesh entity version hash does not match its envelope');
  }
  const [manifestBytes, preparationBytes, topologyBytes] = await Promise.all([
    fetchWhole(streaming, input.manifestUri, signal),
    fetchWhole(streaming, input.preparationUri, signal),
    fetchWhole(streaming, input.sectionTopologyUri, signal),
  ]);
  await verifyResource(renderResource, manifestBytes, 'mesh render manifest');
  await verifyResource(input.preparationResource, preparationBytes, 'mesh preparation recipe');
  await verifyResource(input.sectionTopologyResource, topologyBytes, 'mesh section topology');
  const topology = parseSectionTopologyIndex(topologyBytes);
  if (topology.closedManifold !== mesh.closedManifold) {
    throw new TypeError('prepared mesh topology contradicts canonical open/closed semantics');
  }
  const sectionTopologyParts = topology.parts.map((part) => ({
    partId: part.partId,
    manifestUri: resolveAssetUri(input.sectionTopologyUri, part.manifestUrl),
    positionUri: resolveAssetUri(input.sectionTopologyUri, part.positionUrl),
    indexUri: resolveAssetUri(input.sectionTopologyUri, part.indexUrl),
    ...(part.materialSlotUrl === null
      ? {}
      : { materialSlotUri: resolveAssetUri(input.sectionTopologyUri, part.materialSlotUrl) }),
  }));

  const canonicalAdmissions: readonly KernelCanonicalRenderAdmission[] = [
    {
      admission: input.admission,
      datasetId: input.datasetId,
      evaluatedMesh: {
        meshResourceRef: renderResource.objectHash,
        providerId: input.providerId,
        providerVersion: input.providerVersion,
        parametersRef: input.preparationResource.objectHash,
        datasetId: input.datasetId,
        parts: topology.parts.map((part) => ({
          partId: part.partId,
          topologyHash: part.topologyHash,
          bounds: part.bounds,
        })),
        materialKeys: topology.materialKeys ?? {},
        closedManifold: topology.closedManifold,
      },
      ...(input.style === undefined ? {} : { style: input.style }),
    },
  ];
  const mutation = viewer.registerPreparedDatasetAndPublishCanonicalRepresentations(
    input.datasetId,
    renderResource.mediaType,
    input.manifestUri,
    manifestBytes,
    canonicalAdmissions,
    [
      {
        entityId: input.admission.entity.id,
        representationSlot: input.admission.representationSlot,
        sectionTopologyParts,
        closedManifold: topology.closedManifold,
        ...(input.style === undefined ? {} : { style: input.style }),
      },
    ],
  );
  return { mutation, sectionTopologyParts };
}

function preparedTriangleMesh(
  geometry: CanonicalRepresentationAdmission['resolvedGeometry'],
): TriangleMeshGeometry | null {
  if (geometry.kind === 'surface3d') return geometry.mesh;
  if (geometry.kind === 'elevationSurface' && geometry.surface.kind === 'tin') {
    return geometry.surface.mesh;
  }
  if (geometry.kind === 'solid' && geometry.solid.kind === 'closedMesh') {
    return geometry.solid.mesh;
  }
  return null;
}

function fetchWhole(
  streaming: ImmutableResourceFetcher,
  uri: string,
  signal?: AbortSignal,
): Promise<Uint8Array> {
  return streaming.fetchImmutableResource({ uri, byteOffset: null, byteLength: null }, signal);
}

async function verifyResource(
  resource: GeometryResource,
  bytes: Uint8Array,
  label: string,
): Promise<void> {
  if (resource.byteLength !== null && resource.byteLength !== bytes.byteLength) {
    throw new Error(`${label} byte length does not match its canonical resource`);
  }
  if ((await sha256Hex(bytes)) !== resource.objectHash) {
    throw new Error(`${label} hash does not match its canonical resource`);
  }
}

function parseSectionTopologyIndex(bytes: Uint8Array): PreparedSectionTopologyIndex {
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch (error) {
    throw new TypeError(`mesh section topology is invalid JSON: ${String(error)}`);
  }
  if (!record(value) || value.schemaVersion !== 2 || typeof value.closedManifold !== 'boolean') {
    throw new TypeError('mesh section topology header is invalid');
  }
  if (!materialKeys(value.materialKeys)) {
    throw new TypeError('mesh section topology material table is invalid');
  }
  if (value.closedManifold && Object.keys(value.materialKeys ?? {}).length === 0) {
    throw new TypeError('closed prepared mesh requires canonical material keys');
  }
  if (!Array.isArray(value.parts) || value.parts.length === 0 || value.parts.length > 1_000_000) {
    throw new TypeError('mesh section topology has an invalid partition count');
  }
  let previous = '';
  for (const part of value.parts) {
    if (
      !record(part) ||
      typeof part.partId !== 'string' ||
      part.partId.length === 0 ||
      part.partId <= previous ||
      !sha256(part.topologyHash) ||
      !sectionBounds(part.bounds) ||
      !nonEmpty(part.manifestUrl) ||
      !nonEmpty(part.positionUrl) ||
      !nonEmpty(part.indexUrl) ||
      (part.materialSlotUrl !== null && !nonEmpty(part.materialSlotUrl))
    ) {
      throw new TypeError('mesh section topology partition is invalid or unsorted');
    }
    previous = part.partId;
  }
  return value as unknown as PreparedSectionTopologyIndex;
}

function materialKeys(value: unknown): boolean {
  if (value === undefined) return true;
  if (!record(value) || Object.keys(value).length > 65_536) return false;
  return Object.entries(value).every(([slot, key]) => {
    if (!/^(0|[1-9][0-9]*)$/.test(slot) || !nonEmpty(key)) return false;
    const numeric = Number(slot);
    return Number.isSafeInteger(numeric) && numeric <= 0xffff_ffff;
  });
}

function sectionBounds(value: unknown): boolean {
  if (!record(value)) return false;
  const { minimum, maximum } = value;
  if (!worldPoint(minimum) || !worldPoint(maximum)) return false;
  return minimum.every((component, axis) => component <= maximum[axis]!);
}

function worldPoint(value: unknown): value is [number, number, number] {
  return (
    Array.isArray(value) &&
    value.length === 3 &&
    value.every((component) => typeof component === 'number' && Number.isFinite(component))
  );
}

function resolveAssetUri(manifestUri: string, relative: string): string {
  try {
    return new URL(relative, manifestUri).toString();
  } catch {
    const slash = manifestUri.lastIndexOf('/');
    return slash < 0 ? relative : `${manifestUri.slice(0, slash + 1)}${relative}`;
  }
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes.slice().buffer));
  return [...digest].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function sha256(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
}

function nonEmpty(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
