import assert from 'node:assert/strict';

import type {
  KernelDecodeJob,
  KernelDecodedArtifact,
} from '../../src/kernel/KernelDecodeWorkerPool.js';
import {
  decodeInputManifestHash,
  KernelStreamingDriver,
  type KernelDecodeExecutor,
  type KernelFetch,
  type KernelStreamingDriverDiagnostics,
  type KernelStreamingTarget,
} from '../../src/kernel/KernelStreamingDriver.js';
import type {
  KernelAssetDependency,
  KernelContentReference,
  KernelResidencyTicket,
  KernelResourceCost,
  KernelStreamingAction,
  KernelStreamingFramePlan,
  KernelStreamingPublish,
  KernelThreeDTilesContentMetadata,
  KernelTileDescriptor,
  KernelTileKey,
} from '../../src/kernel/WgpuKernelViewer.js';

export interface StreamingTelemetryFixtureResult {
  readonly tilePairs: number;
  readonly diagnostics: KernelStreamingDriverDiagnostics;
}

/**
 * Exercises the provider-neutral point/mesh lifecycle without external data,
 * a browser, a GPU, or wall-clock-sensitive assertions.
 */
export async function runStreamingTelemetryFixture(
  tilePairs = 64,
): Promise<StreamingTelemetryFixtureResult> {
  assert(Number.isSafeInteger(tilePairs) && tilePairs > 0 && tilePairs <= 1_024);
  const target = new TelemetryTarget();
  const fetchBytes: KernelFetch = (uri, init) => {
    const range = new Headers(init.headers).get('Range');
    const isPoint = uri.endsWith('point-pages.bin');
    assert.equal(range !== null, isPoint);
    return Promise.resolve(
      new Response(new Uint8Array(isPoint ? 1024 * 1024 : 24), {
        status: isPoint ? 206 : 200,
      }),
    );
  };
  let clockMs = 0;
  const driver = new KernelStreamingDriver(
    target,
    fetchBytes,
    undefined,
    undefined,
    new TelemetryDecodeExecutor(),
    () => (clockMs += 0.25),
  );

  const entries = Array.from({ length: tilePairs }, (_, index) => [
    fixtureEntry('point', index),
    fixtureEntry('mesh', index),
  ]).flat();

  await loadEntries(driver, entries, 1);
  driver.execute(
    frame(
      [],
      entries.map((entry) => entry.key),
    ),
  );
  driver.execute(frame(entries.map((entry) => ({ kind: 'evictTile', key: entry.key }) as const)));
  await loadEntries(driver, entries, 2);

  const diagnostics = driver.diagnostics();
  assert.equal(target.failures.length, 0);
  driver.dispose();
  return { tilePairs, diagnostics };
}

export function assertStreamingTelemetryFixture(result: StreamingTelemetryFixtureResult): void {
  const { tilePairs, diagnostics } = result;
  const telemetry = diagnostics.streamingTelemetry;
  assert.equal(telemetry.schemaVersion, 1);
  assert.deepEqual(
    {
      started: telemetry.transport.startedRequests,
      completed: telemetry.transport.completedRequests,
      failed: telemetry.transport.failedRequests,
      aborted: telemetry.transport.abortedRequests,
      ranges: telemetry.transport.rangeRequests,
      full: telemetry.transport.fullRequests,
      bytes: telemetry.transport.receivedBytes,
    },
    {
      started: tilePairs + 1,
      completed: tilePairs + 1,
      failed: 0,
      aborted: 0,
      ranges: 1,
      full: tilePairs,
      bytes: 1024 * 1024 + tilePairs * 24,
    },
  );
  assert.equal(telemetry.transport.requestMs, (tilePairs + 1) * 0.25);
  assert.equal(telemetry.transport.maximumRequestMs, 0.25);

  for (const contentClass of ['point', 'mesh'] as const) {
    const lifecycle = telemetry.lifecycle[contentClass];
    assert.equal(lifecycle.coldLoads, tilePairs);
    assert.equal(lifecycle.revisitLoads, tilePairs);
    assert.equal(lifecycle.residencyHits, tilePairs);
    assert.equal(lifecycle.evictions, tilePairs);
    assert.equal(lifecycle.revisitsMadeResident, tilePairs);
    assert.equal(lifecycle.ramWarmHits, tilePairs);
    assert.equal(lifecycle.avoidedNetworkFetches, tilePairs);
    assert.equal(lifecycle.avoidedWorkerDecodes, tilePairs);
    assert.equal(lifecycle.completedFetches, contentClass === 'point' ? 1 : tilePairs);
    assert.equal(lifecycle.completedDecodes, tilePairs);
    assert.equal(lifecycle.completedUploads, tilePairs * 2);
    assert.equal(lifecycle.fetchedBytes, contentClass === 'point' ? 1024 * 1024 : tilePairs * 24);
    assert.equal(lifecycle.fetchMs, contentClass === 'point' ? 0.25 : tilePairs / 4);
    assert.equal(lifecycle.maximumFetchMs, 0.25);
    assert.equal(lifecycle.workerDecodeMs, tilePairs / 2);
    assert.equal(lifecycle.decodeTurnaroundMs, tilePairs / 4);
    assert.equal(lifecycle.maximumDecodeTurnaroundMs, 0.25);
    assert(lifecycle.uploadedBytes > 0);
    assert.equal(lifecycle.uploadMs, tilePairs / 2);
    assert.equal(lifecycle.maximumUploadMs, 0.25);
  }
  assert.deepEqual(telemetry.lifecycle.other, {
    coldLoads: 0,
    revisitLoads: 0,
    residencyHits: 0,
    evictions: 0,
    revisitsMadeResident: 0,
    ramWarmHits: 0,
    avoidedNetworkFetches: 0,
    avoidedWorkerDecodes: 0,
    completedFetches: 0,
    fetchedBytes: 0,
    fetchMs: 0,
    maximumFetchMs: 0,
    completedDecodes: 0,
    decodedArtifactBytes: 0,
    workerDecodeMs: 0,
    decodeTurnaroundMs: 0,
    maximumDecodeTurnaroundMs: 0,
    completedUploads: 0,
    uploadedBytes: 0,
    uploadMs: 0,
    maximumUploadMs: 0,
  });
  assert.equal(telemetry.ramWarmCache.entries, tilePairs * 2);
  assert.equal(telemetry.ramWarmCache.hits, tilePairs * 2);
  assert.equal(telemetry.ramWarmCache.misses, tilePairs * 2);
  assert.equal(telemetry.ramWarmCache.evictions, 0);
  assert.deepEqual(telemetry.physicalPages, {
    targetBytes: 1024 * 1024,
    budgetBytes: 128 * 1024 * 1024,
    retainedBytes: 1024 * 1024,
    entries: 1,
    hits: tilePairs - 1,
    misses: 1,
    coalescedWaiters: 0,
    networkPages: 1,
    logicalReads: tilePairs,
    logicalBytes: tilePairs * 16,
  });
}

interface FixtureEntry {
  readonly key: KernelTileKey;
  readonly descriptor: KernelTileDescriptor;
}

function fixtureEntry(kind: 'point' | 'mesh', index: number): FixtureEntry {
  const datasetId = `synthetic-${kind}`;
  const tileId = `tile-${String(index).padStart(4, '0')}`;
  const reference: KernelContentReference =
    kind === 'point'
      ? {
          kind: 'potreePoints',
          uri: 'https://synthetic.invalid/point-pages.bin',
          byteOffset: index * 16,
          byteLength: 16,
          primitiveCount: 1,
          contentHash: null,
          decoderParameters: {
            streamingPage: { schemaVersion: 1, targetBytes: 1024 * 1024 },
          },
        }
      : {
          kind: 'gltf',
          uri: `https://synthetic.invalid/${tileId}.glb`,
          byteOffset: null,
          byteLength: null,
          primitiveCount: 1,
          contentHash: null,
          decoderParameters: null,
        };
  return {
    key: { datasetId, tileId },
    descriptor: {
      id: tileId,
      parent: null,
      children: [],
      bounds: { kind: 'sphere', center: { x: index, y: 0, z: 0 }, radius: 1 },
      contentTransform: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
      geometricError: 0,
      refinement: kind === 'point' ? 'add' : 'replace',
      contents: [reference],
      childPage: null,
    },
  };
}

async function loadEntries(
  driver: KernelStreamingDriver,
  entries: readonly FixtureEntry[],
  generation: number,
): Promise<void> {
  for (const entry of entries) {
    const ticket: KernelResidencyTicket = { key: entry.key, generation };
    driver.execute(frame([{ kind: 'fetchTile', ticket, descriptor: entry.descriptor }]));
    await driver.settled();
    driver.execute(frame([{ kind: 'decodeTile', ticket }]));
    await driver.settled();
    driver.execute(frame([{ kind: 'uploadTile', ticket }]));
  }
}

function frame(
  actions: readonly KernelStreamingAction[],
  render: readonly KernelTileKey[] = [],
): KernelStreamingFramePlan {
  return {
    render,
    renderCount: render.length,
    actions,
    admission: {},
    eviction: {},
    claimedDecodeMs: 0,
  };
}

class TelemetryDecodeExecutor implements KernelDecodeExecutor {
  private workers = 1;

  setWorkerCount(workers: number): void {
    this.workers = workers;
  }

  async decode(job: KernelDecodeJob, signal: AbortSignal): Promise<KernelDecodedArtifact> {
    if (signal.aborted) throw new DOMException('aborted', 'AbortError');
    const artifact = await mockDecodeArtifact(job);
    return {
      artifact,
      primary: job.primary,
      bundle: job.bundle,
      secondary: job.secondary,
      workerDurationMs: 0.5,
      workerContext: true,
      workerBaselineLinearMemoryBytes: 1024,
      workerLinearMemoryBytes: 1024,
    };
  }

  diagnostics() {
    return {
      requestedDecodeWorkers: this.workers,
      actualDecodeWorkers: this.workers,
      workerRamBudgetBytes: 1024 * 1024,
      perWorkerReservationBytes: 1024,
      activeDecodes: 0,
      queuedDecodes: 0,
      transferredInputBytes: 0,
      transferredOutputBytes: 0,
      peakTransferBytes: 0,
      completedDecodes: 0,
      failedDecodes: 0,
      canceledDecodes: 0,
      workerDecodeMs: 0,
      mainThreadDispatchMs: 0,
      maximumWorkerBaselineLinearMemoryBytes: 1024,
      maximumWorkerLinearMemoryBytes: 1024,
    };
  }

  dispose(): void {
    return;
  }
}

class TelemetryTarget implements KernelStreamingTarget {
  readonly failures: string[] = [];
  private readonly kinds = new Map<string, KernelContentReference['kind']>();

  streamingFetched(): void {
    return;
  }
  streamingDecoded(): void {
    return;
  }
  streamingUploaded(): void {
    return;
  }
  streamingFailed(_ticket: KernelResidencyTicket, message: string): void {
    this.failures.push(message);
  }
  inspect3dTilesDependencies(
    _metadata: Pick<KernelThreeDTilesContentMetadata, 'contentUri' | 'contentKind'>,
  ): readonly KernelAssetDependency[] {
    return [];
  }
  canonicalStreamBinding(datasetId: string) {
    return {
      key: {
        slot: { entityId: `${datasetId}-entity`, representationSlot: 'streamed-primary' },
        entityRevision: 1,
        entityVersionHash: '11'.repeat(32),
        geometryRef: '22'.repeat(32),
      },
      generation: 1,
    };
  }
  remove3dTilesContent(): boolean {
    return true;
  }
  removePotreeContent(): boolean {
    return true;
  }
  removeGaussianSplatContent(): boolean {
    return true;
  }
  removeRasterContent(): boolean {
    return true;
  }
  publishStagedContents(streamIds: readonly string[]): KernelStreamingPublish {
    const uploadedBytes = streamIds.reduce(
      (total, streamId) => total + (this.kinds.get(streamId) === 'potreePoints' ? 64 : 96),
      0,
    );
    return {
      entities: 1,
      proxies: streamIds.length,
      generation: 1,
      cost: zeroCost(),
      uploadedBytes,
      streams: streamIds.map((streamId) => ({ streamId, proxyIds: [`proxy:${streamId}`] })),
    };
  }
  discardStagedContent(streamId: string): boolean {
    return this.kinds.delete(streamId);
  }
  potreeDecodeParameters(): string {
    return '{}';
  }
  stageDecodedStreamingPayload(
    kind: KernelContentReference['kind'],
    metadataJson: string,
  ): KernelResourceCost {
    const metadata = JSON.parse(metadataJson) as { readonly streamId: string };
    this.kinds.set(metadata.streamId, kind);
    return kind === 'potreePoints'
      ? { ...zeroCost(), cpuDecodedBytes: 32, points: 1 }
      : { ...zeroCost(), cpuDecodedBytes: 48, triangles: 1 };
  }
  applyHierarchyPage(): void {
    return;
  }
  hierarchyPageFailed(): void {
    return;
  }
}

async function mockDecodeArtifact(job: KernelDecodeJob): Promise<ArrayBuffer> {
  const hash = await decodeInputManifestHash(job);
  const artifact = new ArrayBuffer(50);
  const bytes = new Uint8Array(artifact);
  bytes.set(new TextEncoder().encode('HCDECODE'));
  const view = new DataView(artifact);
  view.setUint16(8, 5, true);
  view.setBigUint64(10, 0n, true);
  for (let index = 0; index < 32; index += 1) {
    bytes[18 + index] = Number.parseInt(hash.slice(index * 2, index * 2 + 2), 16);
  }
  return artifact;
}

function zeroCost(): KernelResourceCost {
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
