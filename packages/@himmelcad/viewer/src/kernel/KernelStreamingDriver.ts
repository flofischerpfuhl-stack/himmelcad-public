import type {
  KernelContentReference,
  KernelCanonicalStreamMetadata,
  KernelAssetDependency,
  KernelGaussianSplatContentMetadata,
  KernelPotreeContentMetadata,
  KernelPreparedRasterColorEncoding,
  KernelPreparedRasterDepthEncoding,
  KernelPreparedRasterNoData,
  KernelRasterContentMetadata,
  KernelResidencyTicket,
  KernelResourceCost,
  KernelResolvedAssetBundle,
  KernelResolvedAssetEntry,
  KernelStreamingFramePlan,
  KernelStreamingPublish,
  KernelThreeDTilesContentMetadata,
  KernelTileDescriptor,
  KernelTileKey,
} from './WgpuKernelViewer.js';
import {
  type KernelDecodeJob,
  type KernelDecodedArtifact,
  type KernelDecodePoolDiagnostics,
} from './KernelDecodeWorkerPool.js';

export interface KernelDecodeExecutor {
  setWorkerCount(workers: number): void;
  decode(job: KernelDecodeJob, signal: AbortSignal): Promise<KernelDecodedArtifact>;
  diagnostics(): KernelDecodePoolDiagnostics;
  dispose(): void;
}

/** Kernel surface required by the provider-neutral asynchronous driver. */
export interface KernelStreamingTarget {
  streamingFetched(ticket: KernelResidencyTicket, cost: KernelResourceCost): void;
  streamingDecoded(ticket: KernelResidencyTicket, cost: KernelResourceCost): void;
  streamingUploaded(ticket: KernelResidencyTicket, cost: KernelResourceCost): void;
  streamingFailed(ticket: KernelResidencyTicket, message: string, cost: KernelResourceCost): void;
  inspect3dTilesDependencies(
    metadata: Pick<KernelThreeDTilesContentMetadata, 'contentUri' | 'contentKind'>,
    bytes: Uint8Array,
  ): readonly KernelAssetDependency[];
  canonicalStreamBinding(datasetId: string): KernelCanonicalStreamMetadata['binding'];
  remove3dTilesContent(streamId: string): boolean;
  removePotreeContent(streamId: string): boolean;
  removeGaussianSplatContent(streamId: string): boolean;
  publishStagedContents(streamIds: readonly string[]): KernelStreamingPublish;
  removeRasterContent(streamId: string): boolean;
  discardStagedContent(streamId: string): boolean;
  potreeDecodeParameters(datasetId: string): string;
  stageDecodedStreamingPayload(
    kind: KernelContentReference['kind'],
    metadataJson: string,
    artifact: Uint8Array,
    primary: Uint8Array,
    bundleManifestJson: string,
    bundle: Uint8Array,
    secondary: Uint8Array,
    decodeParametersJson: string,
    expectedInputHash: string,
  ): KernelResourceCost;
  applyHierarchyPage(owner: KernelTileKey, pageUri: string, bytes: Uint8Array): void;
  hierarchyPageFailed(owner: KernelTileKey): void;
}

export type KernelFetch = (input: string, init: RequestInit) => Promise<Response>;

/** Dynamically replaceable host concurrency ceilings resolved by the kernel. */
export interface KernelStreamingRuntimeLimits {
  readonly decoderWorkers: number;
  readonly contentRequests: number;
}

/** Host transport and decode-execution diagnostics. */
export interface KernelStreamingDriverDiagnostics {
  readonly limits: KernelStreamingRuntimeLimits;
  readonly activeRequests: number;
  readonly queuedRequests: number;
  readonly peakRequests: number;
  /** Requests that reached the host transport after acquiring a permit. */
  readonly startedRequests: number;
  /** Queued or acquired requests cancelled before invoking host transport. */
  readonly cancelledBeforeStartRequests: number;
  /** Started host transports that later completed through cancellation. */
  readonly abortedAfterStartRequests: number;
  readonly lastPlanDecodeClaims: number;
  readonly decodeExecution: 'transferableWebWorkers';
  readonly actualDecodeWorkers: number;
  readonly activeDecodes: number;
  readonly queuedDecodes: number;
  readonly transferredInputBytes: number;
  readonly transferredOutputBytes: number;
  readonly peakTransferBytes: number;
  readonly workerDecodeMs: number;
  readonly mainThreadDecodeIngestMs: number;
  readonly maximumMainThreadDecodeIngestMs: number;
  readonly retainedFetchedCompressedBytes: number;
  readonly decodedReadyTiles: number;
  readonly perWorkerReservationBytes: number;
  readonly maximumWorkerBaselineLinearMemoryBytes: number;
  readonly maximumWorkerLinearMemoryBytes: number;
  /** Non-cancellation tile failures observed since driver creation. */
  readonly failedOperations: number;
  /** Bounded newest-first evidence for diagnosing provider and upload failures. */
  readonly recentFailures: readonly KernelStreamingFailure[];
}

export interface KernelStreamingFailure {
  readonly phase: 'fetch' | 'decode' | 'upload';
  readonly tileKey: string;
  readonly message: string;
}

interface FetchedPayload {
  readonly reference: KernelContentReference;
  readonly bytes: Uint8Array;
  readonly streamId: string;
  readonly elevationBytes: Uint8Array;
  readonly validityBytes: Uint8Array;
  readonly confidenceBytes: Uint8Array;
  readonly triangleMaskBytes: Uint8Array;
  readonly assetBundle: KernelResolvedAssetBundle;
}

export type KernelAssetUriResolver = (ownerUri: string, sourceUri: string) => string;

interface InflightAssetFetch {
  readonly controller: AbortController;
  readonly promise: Promise<Uint8Array>;
  consumers: number;
  settled: boolean;
}

interface RequestWaiter {
  readonly signal: AbortSignal;
  readonly resolve: (release: () => void) => void;
  readonly reject: (reason: unknown) => void;
  readonly abort: () => void;
}

const EMPTY_ASSET_BUNDLE: KernelResolvedAssetBundle = {
  manifest: { schemaVersion: 1, entries: [] },
  bytes: new Uint8Array(0),
};
const MAX_ASSET_DEPENDENCIES = 4_096;
const MAX_EXTERNAL_ASSET_BYTES = 512 * 1024 * 1024;
const MAX_SINGLE_EXTERNAL_ASSET_BYTES = 256 * 1024 * 1024;

export interface KernelRasterDecoderParameters {
  readonly schemaVersion: 1;
  readonly width: number;
  readonly height: number;
  readonly mapping: {
    readonly origin: readonly [number, number];
    readonly columnStep: readonly [number, number];
    readonly rowStep: readonly [number, number];
  };
  readonly topology:
    | {
        readonly kind: 'continuous';
        readonly maximumHeightJump: number | null;
        readonly diagonal: 'topLeftToBottomRight' | 'topRightToBottomLeft';
      }
    | { readonly kind: 'pixelSteps' };
  readonly colorEncoding: KernelPreparedRasterColorEncoding;
  readonly elevationEncoding: KernelPreparedRasterDepthEncoding;
  readonly noData: KernelPreparedRasterNoData;
  readonly elevationReference: {
    readonly uri: string;
    readonly byteOffset: number | null;
    readonly byteLength: number | null;
    readonly contentHash: string | null;
  } | null;
  readonly validityReference: {
    readonly uri: string;
    readonly byteOffset: number | null;
    readonly byteLength: number | null;
    readonly contentHash: string | null;
  } | null;
  readonly confidenceReference: {
    readonly uri: string;
    readonly byteOffset: number | null;
    readonly byteLength: number | null;
    readonly contentHash: string | null;
    readonly encoding: 'unorm8' | 'float32LittleEndian';
  } | null;
  readonly triangleMaskReference: {
    readonly uri: string;
    readonly byteOffset: number | null;
    readonly byteLength: number | null;
    readonly contentHash: string | null;
  } | null;
}

export interface KernelImmutableAssetDecoderParameters {
  readonly schemaVersion: 1;
  readonly requireComplete: true;
  readonly immutableAssets: readonly {
    readonly uri: string;
    readonly contentHash: string;
    readonly byteLength: number;
  }[];
}

interface FetchedTile {
  readonly ticket: KernelResidencyTicket;
  readonly descriptor: KernelTileDescriptor;
  readonly payloads: readonly FetchedPayload[] | null;
  readonly compressedCost: KernelResourceCost;
}

interface ResidentPayload {
  readonly streamId: string;
  readonly proxyIds: readonly string[];
  readonly kind: KernelContentReference['kind'];
  readonly metadata: KernelResidentMetadata;
}

/** Hierarchy metadata retained with one resident render proxy for inspection. */
export interface KernelResidentMetadata {
  readonly tile: Readonly<Record<string, unknown>> | null;
  readonly content: Readonly<Record<string, unknown>> | null;
}

/**
 * Executes Rust-owned streaming plans without duplicating selection or budget
 * policy in JavaScript. Fetches are cancelable and every completion retains its
 * generation-bearing residency ticket.
 */
export class KernelStreamingDriver {
  private readonly fetched = new Map<string, FetchedTile>();
  private readonly staged = new Map<string, readonly ResidentPayload[]>();
  private readonly resident = new Map<string, readonly ResidentPayload[]>();
  private readonly residentMetadata = new Map<string, KernelResidentMetadata>();
  private readonly controllers = new Map<string, AbortController>();
  private readonly bootstrapControllers = new Set<AbortController>();
  private readonly decodeControllers = new Map<string, AbortController>();
  private readonly tasks = new Set<Promise<void>>();
  private readonly inflightAssetFetches = new Map<string, InflightAssetFetch>();
  private readonly requestSemaphore: DynamicRequestSemaphore;
  private runtimeLimits: KernelStreamingRuntimeLimits = {
    decoderWorkers: 0xffff,
    contentRequests: 0xffff,
  };
  private lastPlanDecodeClaims = 0;
  private mainThreadDecodeIngestMs = 0;
  private maximumMainThreadDecodeIngestMs = 0;
  private failedOperations = 0;
  private readonly recentFailures: KernelStreamingFailure[] = [];
  private disposed = false;

  constructor(
    private readonly kernel: KernelStreamingTarget,
    private readonly fetchBytes: KernelFetch = globalFetch,
    private readonly onStateChange: () => void = () => {},
    private readonly resolveAssetUri: KernelAssetUriResolver = resolveSiblingUri,
    private readonly decodePool?: KernelDecodeExecutor,
  ) {
    this.requestSemaphore = new DynamicRequestSemaphore(this.runtimeLimits.contentRequests);
  }

  /** Applies one kernel-resolved limit pair without canceling work in flight. */
  setRuntimeLimits(limits: KernelStreamingRuntimeLimits): void {
    this.assertAlive();
    validateRuntimeLimit(limits.decoderWorkers, 'decoderWorkers');
    validateRuntimeLimit(limits.contentRequests, 'contentRequests');
    if (
      limits.decoderWorkers === this.runtimeLimits.decoderWorkers &&
      limits.contentRequests === this.runtimeLimits.contentRequests
    )
      return;
    const next = {
      decoderWorkers: limits.decoderWorkers,
      contentRequests: limits.contentRequests,
    };
    this.requestSemaphore.setLimit(next.contentRequests);
    this.decodePool?.setWorkerCount(next.decoderWorkers);
    this.runtimeLimits = next;
  }

  /** Current real transport occupancy and honest synchronous decode mode. */
  diagnostics(): KernelStreamingDriverDiagnostics {
    this.assertAlive();
    const requests = this.requestSemaphore.diagnostics();
    const decode = this.requiredDecodePool().diagnostics();
    return {
      limits: { ...this.runtimeLimits },
      activeRequests: requests.active,
      queuedRequests: requests.queued,
      peakRequests: requests.peak,
      startedRequests: requests.started,
      cancelledBeforeStartRequests: requests.cancelledBeforeStart,
      abortedAfterStartRequests: requests.abortedAfterStart,
      lastPlanDecodeClaims: this.lastPlanDecodeClaims,
      decodeExecution: 'transferableWebWorkers',
      actualDecodeWorkers: decode.actualDecodeWorkers,
      activeDecodes: decode.activeDecodes,
      queuedDecodes: decode.queuedDecodes,
      transferredInputBytes: decode.transferredInputBytes,
      transferredOutputBytes: decode.transferredOutputBytes,
      peakTransferBytes: decode.peakTransferBytes,
      workerDecodeMs: decode.workerDecodeMs,
      mainThreadDecodeIngestMs: this.mainThreadDecodeIngestMs,
      maximumMainThreadDecodeIngestMs: this.maximumMainThreadDecodeIngestMs,
      retainedFetchedCompressedBytes: [...this.fetched.values()].reduce(
        (bytes, tile) =>
          bytes + (tile.payloads === null ? 0 : tile.compressedCost.cpuCompressedBytes),
        0,
      ),
      decodedReadyTiles: [...this.fetched.values()].filter((tile) => tile.payloads === null).length,
      perWorkerReservationBytes: decode.perWorkerReservationBytes,
      maximumWorkerBaselineLinearMemoryBytes: decode.maximumWorkerBaselineLinearMemoryBytes,
      maximumWorkerLinearMemoryBytes: decode.maximumWorkerLinearMemoryBytes,
      failedOperations: this.failedOperations,
      recentFailures: this.recentFailures.map((failure) => ({ ...failure })),
    };
  }

  /** Fetches immutable dataset bootstrap metadata through the same live request ceiling as tiles. */
  async fetchImmutableResource(
    reference: {
      readonly uri: string;
      readonly byteOffset: number | null;
      readonly byteLength: number | null;
      readonly contentHash?: string | null;
    },
    signal?: AbortSignal,
  ): Promise<Uint8Array> {
    this.assertAlive();
    if (
      !validByteReference(reference) ||
      (reference.contentHash !== undefined &&
        reference.contentHash !== null &&
        !/^[0-9a-f]{64}$/.test(reference.contentHash))
    ) {
      throw new RangeError('immutable resource reference is invalid');
    }
    if (
      reference.byteOffset !== null &&
      reference.byteLength !== null &&
      !Number.isSafeInteger(reference.byteOffset + reference.byteLength)
    ) {
      throw new RangeError('immutable resource range exceeds portable integer bounds');
    }
    const controller = new AbortController();
    const abort = (): void => controller.abort();
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) controller.abort();
    this.bootstrapControllers.add(controller);
    try {
      return await this.fetchVerifiedBytes(
        { ...reference, contentHash: reference.contentHash ?? null },
        controller.signal,
        'immutable resource',
      );
    } finally {
      signal?.removeEventListener('abort', abort);
      this.bootstrapControllers.delete(controller);
    }
  }

  /** Starts asynchronous fetch work and performs ready decode/upload actions. */
  execute(plan: KernelStreamingFramePlan): number {
    this.assertAlive();
    this.lastPlanDecodeClaims = plan.actions.reduce(
      (count, action) => count + Number(action.kind === 'decodeTile'),
      0,
    );
    if (this.lastPlanDecodeClaims > this.runtimeLimits.decoderWorkers) {
      throw new Error('kernel streaming plan exceeds the configured decoder claim ceiling');
    }
    let uploadedBytes = 0;
    for (const action of plan.actions) {
      switch (action.kind) {
        case 'fetchTile':
          this.launch(this.fetchTile(action.ticket, action.descriptor));
          break;
        case 'decodeTile':
          this.launch(this.decodeTile(action.ticket));
          break;
        case 'uploadTile':
          uploadedBytes += this.uploadTile(action.ticket);
          break;
        case 'fetchHierarchyPage':
          this.launch(this.fetchHierarchyPage(action.request.owner, action.request.reference));
          break;
        case 'evictTile':
          this.evictTile(action.key);
          break;
      }
    }
    return uploadedBytes;
  }

  /** Waits until currently dispatched transport work settles; useful in hosts and tests. */
  async settled(): Promise<void> {
    while (this.tasks.size > 0) await Promise.allSettled([...this.tasks]);
  }

  /**
   * Drops host-owned work and metadata after the kernel atomically detached a
   * dataset. This never asks the kernel to evict again: canonical retirement
   * already removed its residency, hierarchy and render state.
   */
  detachDataset(datasetId: string): void {
    this.assertAlive();
    if (datasetId.length === 0) throw new RangeError('datasetId must be non-empty');
    for (const [key, controller] of this.controllers) {
      if (!driverKeyBelongsToDataset(key, datasetId)) continue;
      controller.abort();
      this.controllers.delete(key);
    }
    for (const [key, controller] of this.decodeControllers) {
      if (!tileKeyBelongsToDataset(key, datasetId)) continue;
      controller.abort();
      this.decodeControllers.delete(key);
    }
    for (const key of [...this.fetched.keys()]) {
      if (tileKeyBelongsToDataset(key, datasetId)) this.fetched.delete(key);
    }
    for (const [key, payloads] of this.staged) {
      if (!tileKeyBelongsToDataset(key, datasetId)) continue;
      for (const payload of payloads) {
        for (const proxyId of payload.proxyIds) this.residentMetadata.delete(proxyId);
      }
      this.staged.delete(key);
    }
    for (const [key, payloads] of this.resident) {
      if (!tileKeyBelongsToDataset(key, datasetId)) continue;
      for (const payload of payloads) {
        for (const proxyId of payload.proxyIds) this.residentMetadata.delete(proxyId);
      }
      this.resident.delete(key);
    }
  }

  /** Returns immutable provider metadata associated with a picked render proxy. */
  metadataForRenderProxy(renderProxyId: string): KernelResidentMetadata | null {
    this.assertAlive();
    return this.residentMetadata.get(renderProxyId) ?? null;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const controller of this.controllers.values()) controller.abort();
    for (const controller of this.bootstrapControllers) controller.abort();
    this.bootstrapControllers.clear();
    for (const controller of this.decodeControllers.values()) controller.abort();
    for (const fetch of this.inflightAssetFetches.values()) fetch.controller.abort();
    this.requestSemaphore.dispose();
    this.decodePool?.dispose();
    this.controllers.clear();
    this.decodeControllers.clear();
    this.inflightAssetFetches.clear();
    for (const payloads of this.staged.values()) {
      for (const payload of payloads) this.kernel.discardStagedContent(payload.streamId);
    }
    this.fetched.clear();
    this.staged.clear();
    this.residentMetadata.clear();
  }

  private async fetchTile(
    ticket: KernelResidencyTicket,
    descriptor: KernelTileDescriptor,
  ): Promise<void> {
    const key = tileKey(ticket.key);
    const controller = this.replaceController(key);
    try {
      const payloads = await Promise.all(
        descriptor.contents.map(async (reference, index) => {
          const bytes = await this.fetchVerifiedReference(reference, controller.signal);
          const assetBundle =
            reference.kind === 'gltf' || reference.kind === 'threeDTilesContainer'
              ? await this.fetchAssetBundle(reference, bytes, controller.signal)
              : EMPTY_ASSET_BUNDLE;
          let elevationBytes: Uint8Array = new Uint8Array(0);
          let validityBytes: Uint8Array = new Uint8Array(0);
          let confidenceBytes: Uint8Array = new Uint8Array(0);
          let triangleMaskBytes: Uint8Array = new Uint8Array(0);
          if (reference.kind === 'raster') {
            const parameters = parseRasterParameters(reference.decoderParameters);
            if (parameters.elevationReference) {
              elevationBytes = await this.fetchVerifiedBytes(
                {
                  ...parameters.elevationReference,
                  uri: resolveSiblingUri(reference.uri, parameters.elevationReference.uri),
                },
                controller.signal,
                'raster elevation',
              );
            }
            if (parameters.validityReference) {
              validityBytes = await this.fetchVerifiedBytes(
                {
                  ...parameters.validityReference,
                  uri: resolveSiblingUri(reference.uri, parameters.validityReference.uri),
                },
                controller.signal,
                'raster validity',
              );
            }
            if (parameters.confidenceReference) {
              confidenceBytes = await this.fetchVerifiedBytes(
                {
                  ...parameters.confidenceReference,
                  uri: resolveSiblingUri(reference.uri, parameters.confidenceReference.uri),
                },
                controller.signal,
                'raster confidence',
              );
            }
            if (parameters.triangleMaskReference) {
              triangleMaskBytes = await this.fetchVerifiedBytes(
                {
                  ...parameters.triangleMaskReference,
                  uri: resolveSiblingUri(reference.uri, parameters.triangleMaskReference.uri),
                },
                controller.signal,
                'raster triangle mask',
              );
            }
          }
          return {
            reference,
            bytes,
            assetBundle,
            elevationBytes,
            validityBytes,
            confidenceBytes,
            triangleMaskBytes,
            streamId: streamId(ticket.key, index),
          };
        }),
      );
      if (!this.isCurrent(key, controller)) return;
      const compressedCost = zeroCost();
      compressedCost.cpuCompressedBytes =
        payloads.reduce(
          (total, payload) =>
            total +
            payload.bytes.byteLength +
            payload.elevationBytes.byteLength +
            payload.validityBytes.byteLength +
            payload.confidenceBytes.byteLength +
            payload.triangleMaskBytes.byteLength,
          0,
        ) + payloads.reduce((total, payload) => total + payload.assetBundle.bytes.byteLength, 0);
      this.fetched.set(key, { ticket, descriptor, payloads, compressedCost });
      this.kernel.streamingFetched(ticket, compressedCost);
      this.onStateChange();
    } catch (error) {
      if (!isAbort(error) && this.isCurrent(key, controller)) {
        controller.abort();
        const message = errorMessage(error);
        this.recordFailure('fetch', key, message);
        this.kernel.streamingFailed(ticket, message, zeroCost());
      }
    } finally {
      if (this.controllers.get(key) === controller) this.controllers.delete(key);
    }
  }

  private async fetchVerifiedReference(
    reference: KernelContentReference,
    signal: AbortSignal,
  ): Promise<Uint8Array> {
    return this.fetchVerifiedBytes(reference, signal, 'stream content');
  }

  private async fetchVerifiedBytes(
    reference: {
      readonly uri: string;
      readonly byteOffset: number | null;
      readonly byteLength: number | null;
      readonly contentHash: string | null;
    },
    signal: AbortSignal,
    label: string,
  ): Promise<Uint8Array> {
    const bytes = await this.fetchReference(reference, signal);
    if (reference.contentHash !== null) {
      if (!/^[0-9a-f]{64}$/.test(reference.contentHash)) {
        throw new TypeError(`${label} hash is not canonical lowercase SHA-256`);
      }
      if ((await sha256Hex(bytes)) !== reference.contentHash) {
        throw new Error(`${label} hash mismatch: ${reference.uri}`);
      }
    }
    return bytes;
  }

  private async decodeTile(ticket: KernelResidencyTicket): Promise<void> {
    const key = tileKey(ticket.key);
    const fetched = this.fetched.get(key);
    if (!fetched || fetched.ticket.generation !== ticket.generation || fetched.payloads === null)
      return;
    const decodeController = new AbortController();
    this.decodeControllers.get(key)?.abort();
    this.decodeControllers.set(key, decodeController);
    const decodedCost = { ...fetched.compressedCost };
    const staged: ResidentPayload[] = [];
    try {
      for (const payload of fetched.payloads) {
        if (payload.reference.kind === 'cadProxy') {
          throw new Error('cadProxy content is not a CPU streaming payload');
        }
        const binding = this.kernel.canonicalStreamBinding(ticket.key.datasetId);
        const common = {
          streamId: payload.streamId,
          slot: binding.key.slot,
          binding,
          datasetId: ticket.key.datasetId,
          tileId: ticket.key.tileId,
          bounds: fetched.descriptor.bounds,
        } as const;
        let decodeParametersJson = '';
        let validatedPrimitiveCount: number | undefined;
        let rasterParameters: KernelRasterDecoderParameters | undefined;
        if (payload.reference.kind === 'potreePoints') {
          const pointCount = payload.reference.primitiveCount;
          if (!Number.isSafeInteger(pointCount) || pointCount === null || pointCount <= 0) {
            throw new Error('Potree hierarchy did not provide a positive point count');
          }
          validatedPrimitiveCount = pointCount;
          decodeParametersJson = this.kernel.potreeDecodeParameters(ticket.key.datasetId);
        } else if (
          payload.reference.kind === 'gltf' ||
          payload.reference.kind === 'threeDTilesContainer'
        ) {
        } else if (payload.reference.kind === 'gaussianSplats') {
          const maximumSplats = payload.reference.primitiveCount;
          if (
            !Number.isSafeInteger(maximumSplats) ||
            maximumSplats === null ||
            maximumSplats <= 0
          ) {
            throw new Error('Gaussian hierarchy did not provide a positive splat count');
          }
          validatedPrimitiveCount = maximumSplats;
        } else if (payload.reference.kind === 'raster') {
          rasterParameters = parseRasterParameters(payload.reference.decoderParameters);
        }
        const metadata =
          payload.reference.kind === 'potreePoints'
            ? ({
                ...common,
                pointCount: validatedPrimitiveCount!,
              } satisfies KernelPotreeContentMetadata)
            : payload.reference.kind === 'gltf' || payload.reference.kind === 'threeDTilesContainer'
              ? ({
                  ...common,
                  contentUri: payload.reference.uri,
                  contentKind: payload.reference.kind,
                  contentTransform: fetched.descriptor.contentTransform,
                } satisfies KernelThreeDTilesContentMetadata)
              : payload.reference.kind === 'gaussianSplats'
                ? ({
                    ...common,
                    maximumSplats: validatedPrimitiveCount!,
                  } satisfies KernelGaussianSplatContentMetadata)
                : ({
                    ...common,
                    contract: await buildPreparedRasterContract(
                      rasterParameters!,
                      payload.bytes,
                      payload.elevationBytes,
                      payload.validityBytes,
                      payload.confidenceBytes,
                      payload.triangleMaskBytes,
                    ),
                    elevationPayloadByteLength: payload.elevationBytes.byteLength,
                    validityPayloadByteLength: payload.validityBytes.byteLength,
                    confidencePayloadByteLength: payload.confidenceBytes.byteLength,
                    triangleMaskPayloadByteLength: payload.triangleMaskBytes.byteLength,
                  } satisfies KernelRasterContentMetadata);
        const metadataJson = JSON.stringify(metadata);
        const bundleManifestJson = JSON.stringify(payload.assetBundle.manifest);
        const decodeJob: KernelDecodeJob = {
          kind: payload.reference.kind,
          metadataJson,
          bundleManifestJson,
          decodeParametersJson,
          primary: transferableBuffer(payload.bytes),
          bundle: transferableBuffer(payload.assetBundle.bytes),
          secondary: transferableBuffer(
            packRasterBands(
              payload.elevationBytes,
              payload.validityBytes,
              payload.confidenceBytes,
              payload.triangleMaskBytes,
            ),
          ),
        };
        const expectedInputHash = await decodeInputManifestHash(decodeJob);
        const result = await this.requiredDecodePool().decode(decodeJob, decodeController.signal);
        validateDecodeArtifactV3(result.artifact, expectedInputHash);
        const restored: FetchedPayload = {
          ...payload,
          bytes: new Uint8Array(result.primary),
          elevationBytes: new Uint8Array(result.secondary),
          assetBundle: {
            manifest: payload.assetBundle.manifest,
            bytes: new Uint8Array(result.bundle),
          },
        };
        const ingestStarted = performance.now();
        const cost = this.kernel.stageDecodedStreamingPayload(
          payload.reference.kind,
          metadataJson,
          new Uint8Array(result.artifact),
          restored.bytes,
          bundleManifestJson,
          restored.assetBundle.bytes,
          restored.elevationBytes,
          decodeParametersJson,
          expectedInputHash,
        );
        const ingestMs = performance.now() - ingestStarted;
        this.mainThreadDecodeIngestMs += ingestMs;
        this.maximumMainThreadDecodeIngestMs = Math.max(
          this.maximumMainThreadDecodeIngestMs,
          ingestMs,
        );
        addCost(decodedCost, cost, false);
        staged.push({
          streamId: payload.streamId,
          proxyIds: [],
          kind: payload.reference.kind,
          metadata: {
            tile: fetched.descriptor.providerMetadata ?? null,
            content: payload.reference.decoderParameters ?? null,
          },
        });
      }
      if (!this.isGenerationCurrent(key, ticket.generation)) {
        for (const payload of staged) this.kernel.discardStagedContent(payload.streamId);
        return;
      }
      this.fetched.set(key, { ...fetched, payloads: null });
      this.staged.set(key, staged);
      this.kernel.streamingDecoded(ticket, decodedCost);
      this.onStateChange();
    } catch (error) {
      for (const payload of staged) this.kernel.discardStagedContent(payload.streamId);
      if (this.fetched.get(key) === fetched) this.fetched.delete(key);
      if (!isAbort(error) && !this.disposed) {
        const message = errorMessage(error);
        this.recordFailure('decode', key, message);
        this.kernel.streamingFailed(ticket, message, fetched.compressedCost);
      }
    } finally {
      if (this.decodeControllers.get(key) === decodeController) {
        this.decodeControllers.delete(key);
      }
    }
  }

  private isGenerationCurrent(key: string, generation: number): boolean {
    return !this.disposed && this.fetched.get(key)?.ticket.generation === generation;
  }

  private requiredDecodePool(): KernelDecodeExecutor {
    if (this.decodePool === undefined) {
      throw new Error('KernelStreamingDriver requires a transferable decode worker pool');
    }
    return this.decodePool;
  }

  private async fetchAssetBundle(
    reference: KernelContentReference,
    primaryBytes: Uint8Array,
    signal: AbortSignal,
  ): Promise<KernelResolvedAssetBundle> {
    if (reference.kind !== 'gltf' && reference.kind !== 'threeDTilesContainer') {
      return EMPTY_ASSET_BUNDLE;
    }
    const documents: Array<{
      contentUri: string;
      contentKind: 'gltf' | 'threeDTilesContainer';
      bytes: Uint8Array;
    }> = [{ contentUri: reference.uri, contentKind: reference.kind, bytes: primaryBytes }];
    const inspectedDocuments = new Set<string>();
    const declarations = new Map<
      string,
      { resolvedUri: string; kind: KernelAssetDependency['kind'] }
    >();
    const resolvedBytes = new Map<string, Uint8Array>();
    const pendingEntries: Array<KernelAssetDependency & { resolvedUri: string }> = [];
    const integrity = parseImmutableAssetParameters(reference.decoderParameters);
    const expectedAssets = new Map<
      string,
      KernelImmutableAssetDecoderParameters['immutableAssets'][number]
    >();
    if (integrity) {
      for (const asset of integrity.immutableAssets) {
        const resolvedUri = this.resolveAssetUri(reference.uri, asset.uri);
        if (resolvedUri.length === 0) throw new Error('asset URI resolver returned an empty URI');
        if (expectedAssets.has(resolvedUri)) {
          throw new Error(`duplicate immutable external asset: ${asset.uri}`);
        }
        expectedAssets.set(resolvedUri, asset);
      }
    }
    const verifiedAssets = new Set<string>();
    let aggregateAssetBytes = 0;

    for (let documentIndex = 0; documentIndex < documents.length; documentIndex += 1) {
      const document = documents[documentIndex]!;
      if (inspectedDocuments.has(document.contentUri)) continue;
      inspectedDocuments.add(document.contentUri);
      const dependencies = this.kernel.inspect3dTilesDependencies(
        { contentUri: document.contentUri, contentKind: document.contentKind },
        document.bytes,
      );
      const addedDependencies: Array<KernelAssetDependency & { resolvedUri: string }> = [];
      for (const dependency of dependencies) {
        if (dependency.ownerUri !== document.contentUri) {
          throw new Error('asset dependency owner does not match the inspected document');
        }
        if (pendingEntries.length >= MAX_ASSET_DEPENDENCIES) {
          throw new Error('external asset dependency limit exceeded');
        }
        const resolvedUri = this.resolveAssetUri(dependency.ownerUri, dependency.sourceUri);
        if (resolvedUri.length === 0) throw new Error('asset URI resolver returned an empty URI');
        const declarationKey = `${dependency.ownerUri}\0${dependency.sourceUri}`;
        const existing = declarations.get(declarationKey);
        if (existing) {
          if (existing.resolvedUri !== resolvedUri || existing.kind !== dependency.kind) {
            throw new Error('conflicting duplicate asset dependency');
          }
          continue;
        }
        declarations.set(declarationKey, { resolvedUri, kind: dependency.kind });
        const added = { ...dependency, resolvedUri };
        pendingEntries.push(added);
        addedDependencies.push(added);
      }
      const unresolvedUris = [
        ...new Set(
          addedDependencies
            .map((dependency) => dependency.resolvedUri)
            .filter((resolvedUri) => !resolvedBytes.has(resolvedUri)),
        ),
      ];
      const fetchedWave = await Promise.all(
        unresolvedUris.map(async (resolvedUri) => {
          const expected = expectedAssets.get(resolvedUri);
          if (integrity && !expected) {
            throw new Error(`undeclared immutable external asset: ${resolvedUri}`);
          }
          const bytes = await this.fetchExternalAsset(resolvedUri, signal);
          if (bytes.byteLength > MAX_SINGLE_EXTERNAL_ASSET_BYTES) {
            throw new Error('external asset exceeds the per-resource byte limit');
          }
          if (expected) {
            if (bytes.byteLength !== expected.byteLength) {
              throw new Error(`external asset byte length mismatch: ${resolvedUri}`);
            }
            if ((await sha256Hex(bytes)) !== expected.contentHash) {
              throw new Error(`external asset content hash mismatch: ${resolvedUri}`);
            }
          }
          aggregateAssetBytes += bytes.byteLength;
          if (
            !Number.isSafeInteger(aggregateAssetBytes) ||
            aggregateAssetBytes > MAX_EXTERNAL_ASSET_BYTES
          ) {
            throw new Error('external asset bundle exceeds the aggregate byte limit');
          }
          return { resolvedUri, bytes, verified: expected !== undefined };
        }),
      );
      for (const { resolvedUri, bytes, verified } of fetchedWave) {
        resolvedBytes.set(resolvedUri, bytes);
        if (verified) verifiedAssets.add(resolvedUri);
      }
      for (const dependency of addedDependencies) {
        if (dependency.kind === 'gltfDocument') {
          documents.push({
            contentUri: dependency.resolvedUri,
            contentKind: 'gltf',
            bytes: resolvedBytes.get(dependency.resolvedUri)!,
          });
        }
      }
    }

    if (integrity && verifiedAssets.size !== expectedAssets.size) {
      const missing = [...expectedAssets.keys()].find((uri) => !verifiedAssets.has(uri));
      throw new Error(
        `declared immutable external asset was not referenced: ${missing ?? 'unknown'}`,
      );
    }

    if (pendingEntries.length === 0) return EMPTY_ASSET_BUNDLE;
    const offsets = new Map<string, number>();
    let totalBytes = 0;
    for (const [resolvedUri, bytes] of resolvedBytes) {
      offsets.set(resolvedUri, totalBytes);
      totalBytes += bytes.byteLength;
    }
    const packed = new Uint8Array(totalBytes);
    for (const [resolvedUri, bytes] of resolvedBytes) packed.set(bytes, offsets.get(resolvedUri)!);
    const entries: KernelResolvedAssetEntry[] = pendingEntries.map((dependency) => ({
      ...dependency,
      byteOffset: offsets.get(dependency.resolvedUri)!,
      byteLength: resolvedBytes.get(dependency.resolvedUri)!.byteLength,
    }));
    return { manifest: { schemaVersion: 1, entries }, bytes: packed };
  }

  private async fetchExternalAsset(uri: string, signal: AbortSignal): Promise<Uint8Array> {
    let inflight = this.inflightAssetFetches.get(uri);
    if (!inflight) {
      const controller = new AbortController();
      inflight = {
        controller,
        consumers: 0,
        settled: false,
        promise: this.fetchReference(
          { uri, byteOffset: null, byteLength: null },
          controller.signal,
        ),
      };
      const tracked = inflight;
      void tracked.promise
        .finally(() => {
          tracked.settled = true;
          if (tracked.consumers === 0 && this.inflightAssetFetches.get(uri) === tracked) {
            this.inflightAssetFetches.delete(uri);
          }
        })
        .catch(() => {});
      this.inflightAssetFetches.set(uri, inflight);
    }
    inflight.consumers += 1;
    try {
      return await withAbort(inflight.promise, signal);
    } finally {
      inflight.consumers -= 1;
      if (inflight.consumers === 0) {
        if (!inflight.settled) inflight.controller.abort();
        if (this.inflightAssetFetches.get(uri) === inflight) {
          this.inflightAssetFetches.delete(uri);
        }
      }
    }
  }

  private uploadTile(ticket: KernelResidencyTicket): number {
    const key = tileKey(ticket.key);
    const fetched = this.fetched.get(key);
    const staged = this.staged.get(key);
    if (!fetched || fetched.ticket.generation !== ticket.generation || !staged) return 0;
    const residentCost = zeroCost();
    residentCost.cpuCompressedBytes = fetched.compressedCost.cpuCompressedBytes;
    try {
      const result = this.kernel.publishStagedContents(staged.map((payload) => payload.streamId));
      addCost(residentCost, result.cost, false);
      const proxyIdsByStream = new Map(
        result.streams.map((stream) => [stream.streamId, stream.proxyIds]),
      );
      const resident = staged.map((payload) => ({
        ...payload,
        proxyIds: proxyIdsByStream.get(payload.streamId) ?? [],
      }));
      this.resident.set(key, resident);
      for (const payload of resident) {
        for (const proxyId of payload.proxyIds) {
          this.residentMetadata.set(proxyId, payload.metadata);
        }
      }
      this.staged.delete(key);
      this.fetched.delete(key);
      this.kernel.streamingUploaded(ticket, residentCost);
      this.onStateChange();
      return result.uploadedBytes;
    } catch (error) {
      for (const payload of staged) this.kernel.discardStagedContent(payload.streamId);
      this.staged.delete(key);
      const message = errorMessage(error);
      this.recordFailure('upload', key, message);
      this.kernel.streamingFailed(ticket, message, fetched.compressedCost);
      return 0;
    }
  }

  private async fetchHierarchyPage(
    owner: KernelTileKey,
    reference: {
      readonly uri: string;
      readonly byteOffset: number | null;
      readonly byteLength: number | null;
      readonly contentHash: string | null;
    },
  ): Promise<void> {
    const key = `hierarchy\0${tileKey(owner)}`;
    const controller = this.replaceController(key);
    try {
      const bytes = await this.fetchVerifiedBytes(reference, controller.signal, 'hierarchy page');
      if (this.isCurrent(key, controller)) {
        this.kernel.applyHierarchyPage(owner, reference.uri, bytes);
        this.onStateChange();
      }
    } catch (error) {
      if (!isAbort(error) && this.isCurrent(key, controller))
        this.kernel.hierarchyPageFailed(owner);
    } finally {
      if (this.controllers.get(key) === controller) this.controllers.delete(key);
    }
  }

  private evictTile(keyValue: KernelTileKey): void {
    const key = tileKey(keyValue);
    this.controllers.get(key)?.abort();
    this.decodeControllers.get(key)?.abort();
    this.controllers.delete(key);
    this.decodeControllers.delete(key);
    for (const payload of this.staged.get(key) ?? []) {
      this.kernel.discardStagedContent(payload.streamId);
    }
    for (const payload of this.resident.get(key) ?? []) this.removeResident(payload);
    this.fetched.delete(key);
    this.staged.delete(key);
    this.resident.delete(key);
  }

  private fetchReference(
    reference: {
      readonly uri: string;
      readonly byteOffset: number | null;
      readonly byteLength: number | null;
    },
    signal: AbortSignal,
  ): Promise<Uint8Array> {
    return this.requestSemaphore.run(signal, () =>
      fetchReferenceUnbounded(this.fetchBytes, reference, signal),
    );
  }

  private removeResident(payload: ResidentPayload): void {
    for (const proxyId of payload.proxyIds) this.residentMetadata.delete(proxyId);
    if (payload.kind === 'potreePoints') this.kernel.removePotreeContent(payload.streamId);
    else if (payload.kind === 'gaussianSplats')
      this.kernel.removeGaussianSplatContent(payload.streamId);
    else if (payload.kind === 'raster') this.kernel.removeRasterContent(payload.streamId);
    else this.kernel.remove3dTilesContent(payload.streamId);
  }

  private recordFailure(
    phase: KernelStreamingFailure['phase'],
    key: string,
    message: string,
  ): void {
    this.failedOperations += 1;
    this.recentFailures.unshift({ phase, tileKey: key, message });
    if (this.recentFailures.length > 16) this.recentFailures.length = 16;
  }

  private replaceController(key: string): AbortController {
    this.controllers.get(key)?.abort();
    this.decodeControllers.get(key)?.abort();
    const controller = new AbortController();
    this.controllers.set(key, controller);
    return controller;
  }

  private isCurrent(key: string, controller: AbortController): boolean {
    return !this.disposed && this.controllers.get(key) === controller && !controller.signal.aborted;
  }

  private launch(task: Promise<void>): void {
    this.tasks.add(task);
    void task.finally(() => this.tasks.delete(task));
  }

  private assertAlive(): void {
    if (this.disposed) throw new Error('KernelStreamingDriver has been disposed');
  }
}

async function fetchReferenceUnbounded(
  fetchBytes: KernelFetch,
  reference: {
    readonly uri: string;
    readonly byteOffset: number | null;
    readonly byteLength: number | null;
  },
  signal: AbortSignal,
): Promise<Uint8Array> {
  const headers = new Headers();
  const hasRange = reference.byteOffset !== null && reference.byteLength !== null;
  if (hasRange) {
    const end = reference.byteOffset! + reference.byteLength! - 1;
    headers.set('Range', `bytes=${reference.byteOffset}-${end}`);
  }
  const response = await fetchBytes(reference.uri, { headers, signal });
  if (!response.ok) throw new Error(`fetch ${reference.uri} failed with HTTP ${response.status}`);
  let bytes = new Uint8Array(await response.arrayBuffer());
  if (hasRange && response.status !== 206) {
    const offset = reference.byteOffset!;
    const length = reference.byteLength!;
    if (bytes.byteLength === length) return bytes;
    if (offset + length > bytes.byteLength)
      throw new Error('range response is shorter than requested');
    bytes = bytes.slice(offset, offset + length);
  }
  if (hasRange && bytes.byteLength !== reference.byteLength) {
    throw new Error('range response length does not match hierarchy metadata');
  }
  return bytes;
}

function withAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(new DOMException('aborted', 'AbortError'));
  return new Promise<T>((resolve, reject) => {
    const abort = (): void => reject(new DOMException('aborted', 'AbortError'));
    signal.addEventListener('abort', abort, { once: true });
    void promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}

function tileKey(key: KernelTileKey): string {
  return `${key.datasetId}\0${key.tileId}`;
}

function tileKeyBelongsToDataset(key: string, datasetId: string): boolean {
  return key.startsWith(`${datasetId}\0`);
}

function driverKeyBelongsToDataset(key: string, datasetId: string): boolean {
  return (
    tileKeyBelongsToDataset(key, datasetId) ||
    (key.startsWith('hierarchy\0') &&
      tileKeyBelongsToDataset(key.slice('hierarchy\0'.length), datasetId))
  );
}

function streamId(key: KernelTileKey, index: number): string {
  return `${encodeURIComponent(key.datasetId)}/${encodeURIComponent(key.tileId)}/${index}`;
}

function zeroCost(): MutableCost {
  return {
    cpuCompressedBytes: 0,
    cpuDecodedBytes: 0,
    gpuBufferBytes: 0,
    gpuTextureBytes: 0,
    stagingBytes: 0,
    points: 0,
    triangles: 0,
    splats: 0,
    drawCalls: 0,
  };
}

type MutableCost = { -readonly [Key in keyof KernelResourceCost]: number };

function addCost(
  target: MutableCost,
  source: KernelResourceCost,
  includeCompressed: boolean,
): void {
  for (const key of Object.keys(target) as (keyof KernelResourceCost)[]) {
    if (!includeCompressed && key === 'cpuCompressedBytes') continue;
    target[key] += source[key];
  }
}

async function buildPreparedRasterContract(
  parameters: KernelRasterDecoderParameters,
  color: Uint8Array,
  depth: Uint8Array,
  validity: Uint8Array,
  confidence: Uint8Array,
  triangleMask: Uint8Array,
): Promise<KernelRasterContentMetadata['contract']> {
  const resource = async (bytes: Uint8Array, mediaType: string) => ({
    objectHash: await sha256Hex(bytes),
    mediaType,
    byteLength: bytes.byteLength,
  });
  const connectivity =
    triangleMask.byteLength > 0
      ? {
          kind: 'mask' as const,
          resource: await resource(
            triangleMask,
            'application/vnd.himmelcad.raster-connectivity+2bit-lsb0',
          ),
          encoding: 'twoBitsPerCellLsb0' as const,
          diagonal:
            parameters.topology.kind === 'continuous'
              ? parameters.topology.diagonal
              : 'topLeftToBottomRight',
        }
      : parameters.topology;
  return {
    schemaVersion: 1,
    raster: {
      pixels: await resource(
        color,
        parameters.colorEncoding === 'rgba8' ? 'image/rgba8' : 'image/encoded',
      ),
      width: parameters.width,
      height: parameters.height,
      mapping: {
        kind: 'orthoGrid',
        origin: { x: parameters.mapping.origin[0], y: parameters.mapping.origin[1], z: 0 },
        columnStep: {
          x: parameters.mapping.columnStep[0],
          y: parameters.mapping.columnStep[1],
          z: 0,
        },
        rowStep: {
          x: parameters.mapping.rowStep[0],
          y: parameters.mapping.rowStep[1],
          z: 0,
        },
      },
      depth: {
        values: await resource(depth, 'application/vnd.himmelcad.depth'),
        validity:
          validity.byteLength === 0
            ? null
            : {
                resource: await resource(
                  validity,
                  'application/vnd.himmelcad.raster-validity+bitset-lsb0',
                ),
                encoding: 'bitsetLsb0',
              },
        confidence:
          parameters.confidenceReference === null
            ? null
            : {
                resource: await resource(
                  confidence,
                  parameters.confidenceReference.encoding === 'unorm8'
                    ? 'application/vnd.himmelcad.raster-confidence+unorm8'
                    : 'application/vnd.himmelcad.raster-confidence+f32le',
                ),
                encoding: parameters.confidenceReference.encoding,
              },
        sampling: {
          semantics: 'elevationZ',
          interpolation: 'discontinuityAware',
          connectivity,
        },
      },
    },
    colorEncoding: parameters.colorEncoding,
    depthEncoding: parameters.elevationEncoding,
    noData: parameters.noData,
  };
}

function parseRasterParameters(value: unknown): KernelRasterDecoderParameters {
  if (
    !record(value) ||
    value.schemaVersion !== 1 ||
    !Number.isSafeInteger(value.width) ||
    Number(value.width) <= 0 ||
    !Number.isSafeInteger(value.height) ||
    Number(value.height) <= 0 ||
    !validRasterMapping(value.mapping) ||
    !validRasterTopology(value.topology) ||
    (value.colorEncoding !== 'encodedImage' && value.colorEncoding !== 'rgba8') ||
    !validElevationEncoding(value.elevationEncoding) ||
    !validNoData(value.noData) ||
    !(value.elevationReference === null || validHashedByteReference(value.elevationReference)) ||
    !(value.validityReference === null || validHashedByteReference(value.validityReference)) ||
    !(
      value.confidenceReference === null ||
      (record(value.confidenceReference) &&
        validHashedByteReference(value.confidenceReference) &&
        (value.confidenceReference.encoding === 'unorm8' ||
          value.confidenceReference.encoding === 'float32LittleEndian'))
    ) ||
    !(
      value.triangleMaskReference === null ||
      validHashedByteReference(value.triangleMaskReference)
    )
  ) {
    throw new TypeError('raster decoderParameters are malformed');
  }
  const constant = record(value.elevationEncoding) && value.elevationEncoding.kind === 'constant';
  if (constant !== (value.elevationReference === null)) {
    throw new TypeError(
      'constant rasters must omit elevationReference and scalar rasters require it',
    );
  }
  if (
    value.triangleMaskReference !== null &&
    record(value.topology) &&
    value.topology.kind !== 'continuous'
  ) {
    throw new TypeError('raster triangle masks require continuous topology');
  }
  return value as unknown as KernelRasterDecoderParameters;
}

function packRasterBands(
  elevations: Uint8Array,
  validity: Uint8Array,
  confidence: Uint8Array,
  triangleMask: Uint8Array,
): Uint8Array {
  const packed = new Uint8Array(
    elevations.byteLength +
      validity.byteLength +
      confidence.byteLength +
      triangleMask.byteLength,
  );
  packed.set(elevations, 0);
  packed.set(validity, elevations.byteLength);
  packed.set(confidence, elevations.byteLength + validity.byteLength);
  packed.set(
    triangleMask,
    elevations.byteLength + validity.byteLength + confidence.byteLength,
  );
  return packed;
}

function parseImmutableAssetParameters(
  value: unknown,
): KernelImmutableAssetDecoderParameters | null {
  if (value === null || value === undefined || (record(value) && !('immutableAssets' in value))) {
    return null;
  }
  if (
    !record(value) ||
    value.schemaVersion !== 1 ||
    value.requireComplete !== true ||
    !Array.isArray(value.immutableAssets) ||
    value.immutableAssets.length > MAX_ASSET_DEPENDENCIES
  ) {
    throw new TypeError('immutable asset decoderParameters are malformed');
  }
  const uris = new Set<string>();
  for (const asset of value.immutableAssets) {
    if (
      !record(asset) ||
      typeof asset.uri !== 'string' ||
      asset.uri.length === 0 ||
      asset.uri.length > 16_384 ||
      typeof asset.contentHash !== 'string' ||
      !/^[0-9a-f]{64}$/.test(asset.contentHash) ||
      !Number.isSafeInteger(asset.byteLength) ||
      Number(asset.byteLength) <= 0 ||
      Number(asset.byteLength) > MAX_SINGLE_EXTERNAL_ASSET_BYTES ||
      uris.has(asset.uri)
    ) {
      throw new TypeError('immutable asset decoderParameters are malformed');
    }
    uris.add(asset.uri);
  }
  return value as unknown as KernelImmutableAssetDecoderParameters;
}

function validRasterMapping(value: unknown): boolean {
  return (
    record(value) && vector2(value.origin) && vector2(value.columnStep) && vector2(value.rowStep)
  );
}

function validRasterTopology(value: unknown): boolean {
  return (
    record(value) &&
    (value.kind === 'pixelSteps' ||
      (value.kind === 'continuous' &&
        (value.diagonal === 'topLeftToBottomRight' ||
          value.diagonal === 'topRightToBottomLeft') &&
        (value.maximumHeightJump === null ||
          (typeof value.maximumHeightJump === 'number' &&
            Number.isFinite(value.maximumHeightJump) &&
            value.maximumHeightJump >= 0))))
  );
}

function validElevationEncoding(value: unknown): boolean {
  if (!record(value) || typeof value.kind !== 'string') return false;
  if (
    ['float32LittleEndian', 'float32BigEndian', 'float64LittleEndian', 'float64BigEndian'].includes(
      value.kind,
    )
  ) {
    return true;
  }
  return (
    value.kind === 'constant' && typeof value.value === 'number' && Number.isFinite(value.value)
  );
}

function validNoData(value: unknown): boolean {
  return (
    record(value) &&
    (value.kind === 'none' ||
      value.kind === 'nan' ||
      value.kind === 'alphaMask' ||
      (value.kind === 'numeric' && typeof value.value === 'number' && Number.isFinite(value.value)))
  );
}

function validByteReference(value: unknown): boolean {
  if (!record(value) || typeof value.uri !== 'string' || value.uri.length === 0) return false;
  const offset = value.byteOffset;
  const length = value.byteLength;
  return (
    (offset === null && length === null) ||
    (Number.isSafeInteger(offset) &&
      Number(offset) >= 0 &&
      Number.isSafeInteger(length) &&
      Number(length) > 0)
  );
}

function validHashedByteReference(value: unknown): boolean {
  return (
    validByteReference(value) &&
    record(value) &&
    (value.contentHash === null ||
      (typeof value.contentHash === 'string' && /^[0-9a-f]{64}$/.test(value.contentHash)))
  );
}

function vector2(value: unknown): boolean {
  return (
    Array.isArray(value) &&
    value.length === 2 &&
    value.every((component) => typeof component === 'number' && Number.isFinite(component))
  );
}

function resolveSiblingUri(mainUri: string, relative: string): string {
  if (relative.includes('://') || relative.startsWith('/')) return relative;
  try {
    return new URL(relative, mainUri).toString();
  } catch {
    const slash = mainUri.lastIndexOf('/');
    return slash < 0 ? relative : `${mainUri.slice(0, slash + 1)}${relative}`;
  }
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isAbort(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError';
}

const DECODE_ARTIFACT_MAGIC = new TextEncoder().encode('HCDECODE');
const DECODE_ARTIFACT_VERSION = 3;
const DECODE_ARTIFACT_HEADER_BYTES = 50;
const DECODE_INPUT_DOMAIN = new TextEncoder().encode('HCDECODE-INPUT-MANIFEST\0');

/** Async host half of the HCDECODE v3 hierarchical input-manifest contract. */
export async function decodeInputManifestHash(job: KernelDecodeJob): Promise<string> {
  const encoder = new TextEncoder();
  const components = [
    { name: 'kind', bytes: encoder.encode(job.kind) },
    { name: 'metadataJson', bytes: encoder.encode(job.metadataJson) },
    { name: 'primary', bytes: new Uint8Array(job.primary) },
    { name: 'bundleManifestJson', bytes: encoder.encode(job.bundleManifestJson) },
    { name: 'bundle', bytes: new Uint8Array(job.bundle) },
    { name: 'secondary', bytes: new Uint8Array(job.secondary) },
    { name: 'decodeParametersJson', bytes: encoder.encode(job.decodeParametersJson) },
  ] as const;
  const componentDigests = await Promise.all(
    components.map(
      async ({ bytes }) => new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', bytes)),
    ),
  );
  const encodedNames = components.map(({ name }) => encoder.encode(name));
  const manifestLength =
    DECODE_INPUT_DOMAIN.byteLength +
    2 +
    2 +
    encodedNames.reduce((total, name) => total + 2 + name.byteLength + 8 + 32, 0);
  const manifest = new Uint8Array(manifestLength);
  const view = new DataView(manifest.buffer);
  let offset = 0;
  manifest.set(DECODE_INPUT_DOMAIN, offset);
  offset += DECODE_INPUT_DOMAIN.byteLength;
  view.setUint16(offset, 1, true);
  offset += 2;
  view.setUint16(offset, components.length, true);
  offset += 2;
  for (let index = 0; index < components.length; index += 1) {
    const name = encodedNames[index]!;
    const component = components[index]!;
    view.setUint16(offset, name.byteLength, true);
    offset += 2;
    manifest.set(name, offset);
    offset += name.byteLength;
    view.setBigUint64(offset, BigInt(component.bytes.byteLength), true);
    offset += 8;
    manifest.set(componentDigests[index]!, offset);
    offset += 32;
  }
  const digest = new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', manifest));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** Rejects v1, truncation, trailing bytes and a worker/main input-identity split. */
export function validateDecodeArtifactV3(artifact: ArrayBuffer, expectedInputHash: string): void {
  const bytes = new Uint8Array(artifact);
  if (
    bytes.byteLength < DECODE_ARTIFACT_HEADER_BYTES ||
    !DECODE_ARTIFACT_MAGIC.every((byte, index) => bytes[index] === byte)
  ) {
    throw new Error('decode artifact v3 header is invalid');
  }
  const view = new DataView(artifact);
  if (
    view.getUint16(8, true) !== DECODE_ARTIFACT_VERSION ||
    view.getBigUint64(10, true) !== BigInt(bytes.byteLength - DECODE_ARTIFACT_HEADER_BYTES)
  ) {
    throw new Error('decode artifact v3 version or length is invalid');
  }
  const artifactHash = Array.from(bytes.subarray(18, DECODE_ARTIFACT_HEADER_BYTES), (byte) =>
    byte.toString(16).padStart(2, '0'),
  ).join('');
  if (!/^[0-9a-f]{64}$/.test(expectedInputHash) || artifactHash !== expectedInputHash) {
    throw new Error('decode artifact input manifest hash mismatch');
  }
}

class DynamicRequestSemaphore {
  private readonly waiters: RequestWaiter[] = [];
  private active = 0;
  private peak = 0;
  private started = 0;
  private cancelledBeforeStart = 0;
  private abortedAfterStart = 0;
  private disposed = false;

  constructor(private limit: number) {}

  setLimit(limit: number): void {
    if (this.disposed) throw new Error('request semaphore has been disposed');
    this.limit = limit;
    this.drain();
  }

  diagnostics(): {
    readonly active: number;
    readonly queued: number;
    readonly peak: number;
    readonly started: number;
    readonly cancelledBeforeStart: number;
    readonly abortedAfterStart: number;
  } {
    return {
      active: this.active,
      queued: this.waiters.length,
      peak: this.peak,
      started: this.started,
      cancelledBeforeStart: this.cancelledBeforeStart,
      abortedAfterStart: this.abortedAfterStart,
    };
  }

  async run<T>(signal: AbortSignal, operation: () => Promise<T>): Promise<T> {
    const release = await this.acquire(signal);
    if (signal.aborted || this.disposed) {
      this.cancelledBeforeStart += 1;
      release();
      throw abortError();
    }
    try {
      this.started += 1;
      return await operation();
    } catch (error) {
      if (isAbort(error)) this.abortedAfterStart += 1;
      throw error;
    } finally {
      release();
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const waiter of this.waiters.splice(0)) {
      waiter.signal.removeEventListener('abort', waiter.abort);
      this.cancelledBeforeStart += 1;
      waiter.reject(abortError());
    }
  }

  private acquire(signal: AbortSignal): Promise<() => void> {
    if (this.disposed || signal.aborted) return Promise.reject(abortError());
    return new Promise<() => void>((resolve, reject) => {
      const abort = (): void => {
        const index = this.waiters.indexOf(waiter);
        if (index >= 0) {
          this.waiters.splice(index, 1);
          this.cancelledBeforeStart += 1;
        }
        reject(abortError());
      };
      const waiter: RequestWaiter = { signal, resolve, reject, abort };
      signal.addEventListener('abort', abort, { once: true });
      this.waiters.push(waiter);
      this.drain();
    });
  }

  private drain(): void {
    while (!this.disposed && this.active < this.limit && this.waiters.length > 0) {
      const waiter = this.waiters.shift()!;
      waiter.signal.removeEventListener('abort', waiter.abort);
      if (waiter.signal.aborted) {
        this.cancelledBeforeStart += 1;
        waiter.reject(abortError());
        continue;
      }
      this.active += 1;
      this.peak = Math.max(this.peak, this.active);
      let released = false;
      waiter.resolve(() => {
        if (released) return;
        released = true;
        this.active -= 1;
        this.drain();
      });
    }
  }
}

function validateRuntimeLimit(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value <= 0 || value > 0xffff) {
    throw new RangeError(`${name} must be an integer in 1..65535`);
  }
}

function abortError(): DOMException {
  return new DOMException('aborted', 'AbortError');
}

function transferableBuffer(bytes: Uint8Array): ArrayBuffer {
  // Shared empty sentinels must never be detached by a transferable postMessage.
  if (bytes.byteLength === 0) return new ArrayBuffer(0);
  if (
    bytes.byteOffset === 0 &&
    bytes.byteLength === bytes.buffer.byteLength &&
    bytes.buffer instanceof ArrayBuffer
  ) {
    return bytes.buffer;
  }
  return bytes.slice().buffer;
}

function globalFetch(input: string, init: RequestInit): Promise<Response> {
  return globalThis.fetch(input, init);
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const source =
    bytes.buffer instanceof ArrayBuffer &&
    bytes.byteOffset === 0 &&
    bytes.byteLength === bytes.buffer.byteLength
      ? bytes.buffer
      : bytes.slice().buffer;
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', source));
  return [...digest].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}
