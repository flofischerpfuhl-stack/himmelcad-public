import type {
  GeometryRepresentationBindingRef,
  SectionTopologyPartitionManifest,
} from './generated/index.js';
import type { KernelStreamingDriver } from './KernelStreamingDriver.js';
import type { KernelAuthoritativeSectionProduct, WgpuKernelViewer } from './WgpuKernelViewer.js';

/** Transport locations for one immutable authoritative topology partition. */
export interface KernelSectionTopologyPartitionLocation {
  readonly partId: string;
  readonly manifestUri: string;
  readonly positionUri: string;
  readonly indexUri: string;
  readonly materialSlotUri?: string;
}

export interface KernelSectionTopologyEvaluationRequest {
  readonly operationId: string;
  readonly binding: GeometryRepresentationBindingRef;
  readonly plane: KernelAuthoritativeSectionProduct['plane'];
  readonly tolerance: number;
  readonly parts: readonly KernelSectionTopologyPartitionLocation[];
}

interface SectionEvaluationTarget {
  sectionTopologyPartitionContentHash(manifest: SectionTopologyPartitionManifest): string;
  beginAuthoritativeSectionEvaluation(
    operationId: string,
    binding: GeometryRepresentationBindingRef,
    plane: KernelAuthoritativeSectionProduct['plane'],
    tolerance: number,
  ): {
    readonly topologyHash: string;
    readonly closedManifold: boolean;
    readonly parts: readonly {
      readonly partId: string;
      readonly topologyHash: string;
      readonly bounds?: {
        readonly minimum: readonly [number, number, number];
        readonly maximum: readonly [number, number, number];
      };
    }[];
  };
  skipAuthoritativeSectionPartition(operationId: string, partId: string): boolean;
  pushAuthoritativeSectionPartition(
    operationId: string,
    partId: string,
    manifest: SectionTopologyPartitionManifest,
    positionBytes: Uint8Array,
    indexBytes: Uint8Array,
    materialSlotBytes?: Uint8Array,
  ): void;
  finishAuthoritativeSectionEvaluation(operationId: string): KernelAuthoritativeSectionProduct;
  cancelAuthoritativeSectionEvaluation(operationId: string): boolean;
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
 * Evaluates one exact streamed-mesh/TIN section sequentially by source partition.
 * Render LOD residency is never consulted and only one topology partition is retained.
 */
export async function evaluateCanonicalSectionTopology(
  viewer: WgpuKernelViewer,
  streaming: KernelStreamingDriver,
  request: KernelSectionTopologyEvaluationRequest,
  signal?: AbortSignal,
): Promise<KernelAuthoritativeSectionProduct> {
  return evaluateCanonicalSectionTopologyWith(viewer, streaming, request, signal);
}

export async function evaluateCanonicalSectionTopologyWith(
  viewer: SectionEvaluationTarget,
  streaming: ImmutableResourceFetcher,
  request: KernelSectionTopologyEvaluationRequest,
  signal?: AbortSignal,
): Promise<KernelAuthoritativeSectionProduct> {
  if (request.operationId.length === 0 || request.parts.length === 0) {
    throw new RangeError('section operation and topology locations must be non-empty');
  }
  const locations = new Map<string, KernelSectionTopologyPartitionLocation>();
  for (const location of request.parts) {
    if (
      location.partId.length === 0 ||
      location.manifestUri.length === 0 ||
      location.positionUri.length === 0 ||
      location.indexUri.length === 0 ||
      locations.has(location.partId)
    ) {
      throw new TypeError('section topology locations are invalid or duplicated');
    }
    locations.set(location.partId, location);
  }

  const expected = viewer.beginAuthoritativeSectionEvaluation(
    request.operationId,
    request.binding,
    request.plane,
    request.tolerance,
  );
  try {
    if (expected.parts.length !== locations.size) {
      throw new Error('section topology locations do not cover the canonical manifest');
    }
    for (const part of expected.parts) {
      signal?.throwIfAborted();
      const location = locations.get(part.partId);
      if (!location) throw new Error(`missing section topology location: ${part.partId}`);
      if (viewer.skipAuthoritativeSectionPartition(request.operationId, part.partId)) continue;
      const manifestBytes = await fetchWhole(streaming, location.manifestUri, signal);
      const manifest = parsePartitionManifest(manifestBytes, part.partId);
      if (viewer.sectionTopologyPartitionContentHash(manifest) !== part.topologyHash) {
        throw new Error(`section topology manifest hash mismatch: ${part.partId}`);
      }
      const [positionBytes, indexBytes, materialSlotBytes] = await Promise.all([
        fetchWhole(streaming, location.positionUri, signal),
        fetchWhole(streaming, location.indexUri, signal),
        location.materialSlotUri === undefined
          ? Promise.resolve(new Uint8Array())
          : fetchWhole(streaming, location.materialSlotUri, signal),
      ]);
      signal?.throwIfAborted();
      viewer.pushAuthoritativeSectionPartition(
        request.operationId,
        part.partId,
        manifest,
        positionBytes,
        indexBytes,
        materialSlotBytes,
      );
    }
    return viewer.finishAuthoritativeSectionEvaluation(request.operationId);
  } catch (error) {
    viewer.cancelAuthoritativeSectionEvaluation(request.operationId);
    throw error;
  }
}

function fetchWhole(
  streaming: ImmutableResourceFetcher,
  uri: string,
  signal?: AbortSignal,
): Promise<Uint8Array> {
  return streaming.fetchImmutableResource({ uri, byteOffset: null, byteLength: null }, signal);
}

function parsePartitionManifest(
  bytes: Uint8Array,
  partId: string,
): SectionTopologyPartitionManifest {
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch (error) {
    throw new TypeError(`section topology manifest is invalid (${partId}): ${String(error)}`);
  }
  if (!record(value)) throw new TypeError(`section topology manifest is not an object: ${partId}`);
  return value as SectionTopologyPartitionManifest;
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
