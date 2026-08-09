import type { CanonicalRepresentationAdmission, GeometryResource } from './generated/index.js';
import type { KernelStreamingDriver } from './KernelStreamingDriver.js';
import type { KernelLoadOperationOptions } from './KernelLoadOperation.js';
import {
  admitCanonicalPreparedMeshDatasetWith,
  type KernelPreparedMeshDatasetResult,
} from './KernelPreparedMeshDatasetAdmission.js';
import type {
  KernelCanonicalEntityMutation,
  KernelCanonicalRenderAdmission,
  KernelPreparedTopologyRegistration,
  KernelRenderStyle,
  WgpuKernelViewer,
} from './WgpuKernelViewer.js';

export interface KernelPreparedTinDatasetAdmission {
  readonly datasetId: string;
  readonly manifestUri: string;
  readonly preparationUri: string;
  readonly preparationResource: GeometryResource;
  readonly sectionTopologyUri: string;
  readonly sectionTopologyResource: GeometryResource;
  readonly admission: CanonicalRepresentationAdmission;
  readonly style?: KernelRenderStyle;
}

export type KernelPreparedTinDatasetResult = KernelPreparedMeshDatasetResult;

interface PreparedTinAdmissionTarget {
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

/** Civil-specific facade over the permanent prepared triangle-mesh admission. */
export async function admitCanonicalPreparedTinDataset(
  viewer: WgpuKernelViewer,
  streaming: KernelStreamingDriver,
  input: KernelPreparedTinDatasetAdmission,
  signal?: AbortSignal,
  progress?: KernelLoadOperationOptions['onProgress'],
): Promise<KernelPreparedTinDatasetResult> {
  return admitCanonicalPreparedTinDatasetWith(viewer, streaming, input, signal, progress);
}

export async function admitCanonicalPreparedTinDatasetWith(
  viewer: PreparedTinAdmissionTarget,
  streaming: ImmutableResourceFetcher,
  input: KernelPreparedTinDatasetAdmission,
  signal?: AbortSignal,
  progress?: KernelLoadOperationOptions['onProgress'],
): Promise<KernelPreparedTinDatasetResult> {
  const geometry = input.admission.resolvedGeometry;
  if (
    geometry.kind !== 'elevationSurface' ||
    geometry.surface.kind !== 'tin' ||
    geometry.surface.mesh.closedManifold
  ) {
    throw new TypeError('prepared Civil TIN admission requires an open elevation TIN');
  }
  return admitCanonicalPreparedMeshDatasetWith(
    viewer,
    streaming,
    {
      ...input,
      providerId: 'hcad.prepared-civil-tin',
      providerVersion: '1.0.0',
    },
    signal,
    progress,
  );
}
