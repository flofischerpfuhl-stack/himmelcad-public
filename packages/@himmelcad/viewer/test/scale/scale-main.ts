import { KernelDecodeWorkerPool } from '../../src/kernel/KernelDecodeWorkerPool';
import {
  KernelStreamingDriver,
  type KernelStreamingDriverDiagnostics,
} from '../../src/kernel/KernelStreamingDriver';
import { WgpuKernelViewer } from '../../src/kernel/WgpuKernelViewer';
import type {
  HimmelcadViewerWasmModule,
  KernelDeviceCalibration,
  KernelFrameTelemetrySnapshot,
  KernelGeometryObject,
  KernelGpuTextureCacheStats,
  KernelHardwareInventory,
  KernelResourceBudget,
  KernelResolvedHardwarePolicy,
  KernelResourceCost,
  KernelRuntimeQualityState,
  KernelStreamingAction,
  KernelStreamingRuntimeState,
  KernelWorldCamera,
} from '../../src/kernel/WgpuKernelViewer';

declare global {
  interface Window {
    __HCAD_SCALE__?: ScaleGateState;
  }
}

interface ScaleServerStats {
  readonly rangeRequests: number;
  readonly requestedBytes: number;
  readonly uniqueNodes: number;
  readonly duplicateNodeRequests: number;
  readonly requestedNodeIds: readonly string[];
  readonly hierarchyRangeRequests: number;
  readonly hierarchyPageRangeRequests: number;
  readonly uniqueHierarchyPages: number;
  readonly preparedContentRequests: number;
  readonly meshContentRequests: number;
  readonly splatContentRequests: number;
  readonly preparedRequestedBytes: number;
}

interface InteractionBurstTelemetry {
  readonly name: string;
  readonly frames: number;
  readonly inputToFirstPresentedMs: number;
  readonly maximumCpuMs: number;
  readonly maximumEventLoopDelayMs: number;
  readonly longFrames: number;
  readonly inflightObserved: boolean;
}

interface PhaseLatencyTelemetry {
  readonly p50Ms: number;
  readonly p95Ms: number;
  readonly p99Ms: number;
  readonly maximumMs: number;
}

interface ScaleStreamingRuntime extends KernelStreamingRuntimeState {
  readonly trackedEntries: number;
  readonly residencyStageCounts: {
    readonly unloaded: number;
    readonly fetching: number;
    readonly queuedDecode: number;
    readonly decoding: number;
    readonly queuedUpload: number;
    readonly uploading: number;
    readonly resident: number;
    readonly failed: number;
  };
}

interface ScaleGateState {
  ready: boolean;
  phase: string;
  error: string | null;
  capabilities: unknown;
  hierarchy: {
    logicalPoints: number;
    nodeCount: number;
    virtualOctreeBytes: number;
    bounds: { min: readonly number[]; max: readonly number[] };
    projection: string;
    logicalTriangles: number;
    logicalSplats: number;
  } | null;
  maximumTraversedNodes: number;
  maximumPlanTiles: number;
  actionCounts: Record<KernelStreamingAction['kind'], number>;
  evictedTiles: string[];
  reenteredTiles: string[];
  fetchedTiles: string[];
  renderedTiles: string[];
  runtimeLimits: { decoderWorkers: number; contentRequests: number } | null;
  driverDiagnostics: KernelStreamingDriverDiagnostics | null;
  frameTelemetry: KernelFrameTelemetrySnapshot | null;
  textureCache: KernelGpuTextureCacheStats | null;
  streamingRuntime: ScaleStreamingRuntime | null;
  serverStats: ScaleServerStats | null;
  residentPointCeiling: number;
  performanceProfile: string | null;
  interactionBursts: InteractionBurstTelemetry[];
  interactionLatency: PhaseLatencyTelemetry | null;
  interactionPhases: {
    readonly plan: PhaseLatencyTelemetry;
    readonly streamingHost: PhaseLatencyTelemetry;
    readonly renderPresent: PhaseLatencyTelemetry;
  } | null;
  trackedEntries: number;
  locallyTrackedEntries: number;
  queuedUploadDecodedUpperBoundBytes: number;
  hardwarePolicy: KernelResolvedHardwarePolicy | null;
  runtimeQuality: KernelRuntimeQualityState | null;
  profileMinimum: {
    readonly points: number;
    readonly triangles: number;
    readonly splats: number;
    readonly textureBytes: number;
    readonly drawCalls: number;
  } | null;
  profilePeak: {
    readonly points: number;
    readonly triangles: number;
    readonly splats: number;
    readonly textureBytes: number;
    readonly drawCalls: number;
  } | null;
  profilePeaksReached: boolean;
  viewport: {
    readonly width: number;
    readonly height: number;
    readonly devicePixelRatio: number;
  } | null;
  calibration: KernelDeviceCalibration | null;
  residencyPlateau: {
    readonly drainedCosts: readonly KernelResourceCost[];
    readonly reloadCosts: readonly KernelResourceCost[];
    readonly reloadRequestDeltas: readonly number[];
  } | null;
}

type PerformanceProfileName = 'mobile' | 'low' | 'mainstream' | 'high';

interface PerformanceProfile {
  readonly inventory: KernelHardwareInventory;
  readonly minimumPoints: number;
  readonly minimumPointDrawCalls: number;
  readonly minimumTriangles: number;
  readonly minimumSplats: number;
  readonly minimumTextureBytes: number;
  readonly minimumDrawCalls: number;
}

const DATASET_ID = 'ahn4-c31hz1-logical-scale';
const ENTITY_ID = 'ahn4-c31hz1-point-cloud';
const MESH_DATASET_ID = 'synthetic-textured-dgm';
const MESH_ENTITY_ID = 'synthetic-textured-dgm-entity';
const SPLAT_DATASET_ID = 'synthetic-gaussian-splats';
const SPLAT_ENTITY_ID = 'synthetic-gaussian-splats-entity';
const PREPARED_FORMAT = 'himmelcad-prepared-hierarchy@1';
const LOGICAL_POINTS = 1_185_930_249;
const NODE_COUNT = 37_449;
const LOGICAL_TRIANGLES = 4_194_304;
const LOGICAL_SPLATS = 2_000_000;
const MESH_TRIANGLES_PER_TILE = 8_192;
const SPLATS_PER_TILE = 10_000;
const TEXTURE_BYTES_PER_TILE = 256 * 256 * 4;
const MAXIMUM_TRAVERSED_NODES = 12_000;
const MINIMUM_POINTS_PER_NODE = 31_667;
const MAXIMUM_POINTS_PER_NODE = 31_668;
const GPU_POINT_BYTES = 36;
const query = new URLSearchParams(location.search);
const VIEWPORT_WIDTH = Number(query.get('width') ?? 1280);
const VIEWPORT_HEIGHT = Number(query.get('height') ?? 720);
const PERFORMANCE_PROFILE = performanceProfile(query.get('profile'));
const SOFTWARE_CORRECTNESS = query.get('backend') === 'webgl2' && PERFORMANCE_PROFILE === null;
const PERFORMANCE_PROFILES: Readonly<Record<PerformanceProfileName, PerformanceProfile>> = {
  mobile: {
    inventory: { gpuMemoryBytes: 1024 ** 3, systemMemoryBytes: 4 * 1024 ** 3, logicalCores: 4 },
    minimumPoints: 1_000_000,
    minimumPointDrawCalls: 32,
    minimumTriangles: 131_072,
    minimumSplats: 50_000,
    minimumTextureBytes: 16 * TEXTURE_BYTES_PER_TILE,
    minimumDrawCalls: 53,
  },
  low: {
    inventory: { gpuMemoryBytes: 2 * 1024 ** 3, systemMemoryBytes: 8 * 1024 ** 3, logicalCores: 4 },
    minimumPoints: 3_000_000,
    minimumPointDrawCalls: 96,
    minimumTriangles: 524_288,
    minimumSplats: 100_000,
    minimumTextureBytes: 64 * TEXTURE_BYTES_PER_TILE,
    minimumDrawCalls: 170,
  },
  mainstream: {
    inventory: {
      gpuMemoryBytes: 8 * 1024 ** 3,
      systemMemoryBytes: 32 * 1024 ** 3,
      logicalCores: 12,
    },
    minimumPoints: 10_000_000,
    minimumPointDrawCalls: 384,
    minimumTriangles: 2_097_152,
    minimumSplats: 500_000,
    minimumTextureBytes: 256 * TEXTURE_BYTES_PER_TILE,
    minimumDrawCalls: 690,
  },
  high: {
    inventory: {
      gpuMemoryBytes: 24 * 1024 ** 3,
      systemMemoryBytes: 64 * 1024 ** 3,
      logicalCores: 24,
    },
    minimumPoints: 30_000_000,
    minimumPointDrawCalls: 768,
    minimumTriangles: LOGICAL_TRIANGLES,
    minimumSplats: LOGICAL_SPLATS,
    minimumTextureBytes: 512 * TEXTURE_BYTES_PER_TILE,
    minimumDrawCalls: 1_480,
  },
};
const SOURCE_BOUNDS = {
  min: [130_000, 450_000, -3.36] as const,
  max: [134_999.999, 456_249.999, 79.899] as const,
};
const CENTER = {
  x: (SOURCE_BOUNDS.min[0] + SOURCE_BOUNDS.max[0]) * 0.5,
  y: (SOURCE_BOUNDS.min[1] + SOURCE_BOUNDS.max[1]) * 0.5,
  z: (SOURCE_BOUNDS.min[2] + SOURCE_BOUNDS.max[2]) * 0.5,
};
const state: ScaleGateState = {
  ready: false,
  phase: 'boot',
  error: null,
  capabilities: null,
  hierarchy: null,
  maximumTraversedNodes: MAXIMUM_TRAVERSED_NODES,
  maximumPlanTiles: 0,
  actionCounts: {
    fetchTile: 0,
    decodeTile: 0,
    uploadTile: 0,
    fetchHierarchyPage: 0,
    evictTile: 0,
  },
  evictedTiles: [],
  reenteredTiles: [],
  fetchedTiles: [],
  renderedTiles: [],
  runtimeLimits: null,
  driverDiagnostics: null,
  frameTelemetry: null,
  textureCache: null,
  streamingRuntime: null,
  serverStats: null,
  residentPointCeiling: 220_000,
  performanceProfile: PERFORMANCE_PROFILE,
  interactionBursts: [],
  interactionLatency: null,
  interactionPhases: null,
  trackedEntries: 0,
  locallyTrackedEntries: 0,
  queuedUploadDecodedUpperBoundBytes: 0,
  hardwarePolicy: null,
  runtimeQuality: null,
  profileMinimum:
    PERFORMANCE_PROFILE === null
      ? null
      : {
          points: PERFORMANCE_PROFILES[PERFORMANCE_PROFILE].minimumPoints,
          triangles: PERFORMANCE_PROFILES[PERFORMANCE_PROFILE].minimumTriangles,
          splats: PERFORMANCE_PROFILES[PERFORMANCE_PROFILE].minimumSplats,
          textureBytes: PERFORMANCE_PROFILES[PERFORMANCE_PROFILE].minimumTextureBytes,
          drawCalls: PERFORMANCE_PROFILES[PERFORMANCE_PROFILE].minimumDrawCalls,
        },
  profilePeak: null,
  profilePeaksReached: PERFORMANCE_PROFILE === null,
  viewport: null,
  calibration: null,
  residencyPlateau: null,
};
window.__HCAD_SCALE__ = state;

function style() {
  return {
    baseColor: [0.22, 0.78, 1, 1] as const,
    opacity: 1,
    verticalExaggeration: 1,
    colorMode: { kind: 'uniform' } as const,
    fill: { kind: 'color' } as const,
    stroke: {
      mode: { kind: 'color' } as const,
      color: { kind: 'inherit' } as const,
      width: { kind: 'source' } as const,
      cap: 'butt' as const,
      join: 'miter' as const,
      miterLimit: 4,
    },
  };
}

function camera(
  target: { x: number; y: number; z: number },
  radius: number,
  azimuth: number,
): KernelWorldCamera {
  return {
    eye: {
      x: target.x + Math.cos(azimuth) * radius,
      y: target.y + Math.sin(azimuth) * radius,
      z: target.z + radius * 0.72,
    },
    target,
    up: { x: 0, y: 0, z: 1 },
    projection: {
      kind: 'perspective',
      verticalFovRadians: Math.PI / 3,
      aspect: VIEWPORT_WIDTH / VIEWPORT_HEIGHT,
      near: 0.1,
      far: 50_000,
    },
  };
}

function tileKey(
  action:
    | Extract<KernelStreamingAction, { kind: 'fetchTile' }>
    | Extract<KernelStreamingAction, { kind: 'evictTile' }>,
): string {
  const key = action.kind === 'fetchTile' ? action.ticket.key : action.key;
  return `${key.datasetId}/${key.tileId}`;
}

async function run(): Promise<void> {
  const canvas = document.querySelector<HTMLCanvasElement>('#viewer');
  const status = document.querySelector<HTMLOutputElement>('#status');
  if (canvas === null || status === null) throw new Error('scale gate DOM is incomplete');

  state.phase = 'load-hierarchy';
  const metadataResponse = await fetch('/scale/metadata.json');
  if (!metadataResponse.ok) throw new Error('synthetic metadata endpoint failed');
  const metadataBytes = new Uint8Array(await metadataResponse.arrayBuffer());
  const metadata = JSON.parse(new TextDecoder().decode(metadataBytes)) as {
    points: number;
    projection: string;
    boundingBox: { min: number[]; max: number[] };
    hierarchy: { firstChunkSize: number };
    himmelcadScaleGate: {
      logicalNodeCount: number;
      initialNodeCount: number;
      proxyPageCount: number;
    };
  };
  if (
    metadata.points !== LOGICAL_POINTS ||
    metadata.hierarchy.firstChunkSize !== 73 * 22 ||
    metadata.himmelcadScaleGate.logicalNodeCount !== NODE_COUNT ||
    metadata.himmelcadScaleGate.initialNodeCount !== 73 ||
    metadata.himmelcadScaleGate.proxyPageCount !== 64
  ) {
    throw new Error(`logical hierarchy identity mismatch: ${JSON.stringify(metadata)}`);
  }
  const hierarchyResponse = await fetch('/scale/hierarchy.bin', {
    headers: { Range: `bytes=0-${String(metadata.hierarchy.firstChunkSize - 1)}` },
  });
  if (hierarchyResponse.status !== 206)
    throw new Error('synthetic initial hierarchy Range endpoint failed');
  const hierarchyBytes = new Uint8Array(await hierarchyResponse.arrayBuffer());
  if (JSON.stringify(metadata.boundingBox) !== JSON.stringify(SOURCE_BOUNDS)) {
    throw new Error('authority-coordinate bounds were changed');
  }
  state.hierarchy = {
    logicalPoints: metadata.points,
    nodeCount: metadata.himmelcadScaleGate.logicalNodeCount,
    virtualOctreeBytes: metadata.points * 12,
    bounds: metadata.boundingBox,
    projection: metadata.projection,
    logicalTriangles: LOGICAL_TRIANGLES,
    logicalSplats: LOGICAL_SPLATS,
  };

  state.phase = 'create-viewer';
  const wasmModuleUrl = '/wasm/himmelcad_wasm.js';
  const requestedBackend = query.get('backend');
  const viewer = await WgpuKernelViewer.create(
    canvas,
    async () => (await import(wasmModuleUrl)) as unknown as HimmelcadViewerWasmModule,
    VIEWPORT_WIDTH,
    VIEWPORT_HEIGHT,
    requestedBackend === 'webgl2'
      ? 'webgl2'
      : requestedBackend === 'webgpu'
        ? 'webgpu'
        : 'automatic',
  );
  if (PERFORMANCE_PROFILE !== null && isSoftwareAdapter(viewer.capabilities)) {
    throw new Error(
      `${PERFORMANCE_PROFILE} hardware profile is unsupported on software adapter ${viewer.capabilities.adapterName}`,
    );
  }
  const profile = PERFORMANCE_PROFILE === null ? null : PERFORMANCE_PROFILES[PERFORMANCE_PROFILE];
  if (profile !== null) {
    state.phase = 'calibration';
    state.calibration = await calibrateHardware(viewer);
  }
  viewer.setClearColor([0.006, 0.012, 0.02, 1]);
  viewer.registerPotreeDataset(
    DATASET_ID,
    'potree@2',
    '/scale/metadata.json',
    metadataBytes,
    hierarchyBytes,
  );
  const pointCloudGeometry: KernelGeometryObject = {
    kind: 'pointCloud',
    dataset: {
      formatId: 'potree@2',
      metadata: {
        objectHash: await sha256Bytes(metadataBytes),
        mediaType: 'application/json',
        byteLength: metadataBytes.byteLength,
      },
      elementCount: LOGICAL_POINTS,
    },
  };
  const pointAdmission = canonicalAdmission(viewer, ENTITY_ID, DATASET_ID, pointCloudGeometry);
  const pointMutation = viewer.publishCanonicalRepresentations([pointAdmission]);
  let activeBindings = [...pointMutation.bindings];
  let meshManifest: Uint8Array | null = null;
  let splatManifest: Uint8Array | null = null;
  let mixedAdmissions: ReturnType<typeof canonicalAdmission>[] = [];
  if (profile !== null) {
    const [meshManifestResponse, splatManifestResponse] = await Promise.all([
      fetch('/scale/mixed/mesh/manifest.json'),
      fetch('/scale/mixed/splat/manifest.json'),
    ]);
    if (!meshManifestResponse.ok || !splatManifestResponse.ok) {
      throw new Error('synthetic mixed hierarchy endpoint failed');
    }
    meshManifest = new Uint8Array(await meshManifestResponse.arrayBuffer());
    splatManifest = new Uint8Array(await splatManifestResponse.arrayBuffer());
    viewer.registerPreparedDataset(
      MESH_DATASET_ID,
      PREPARED_FORMAT,
      '/scale/mixed/mesh/manifest.json',
      meshManifest,
    );
    viewer.registerPreparedDataset(
      SPLAT_DATASET_ID,
      PREPARED_FORMAT,
      '/scale/mixed/splat/manifest.json',
      splatManifest,
    );
    const meshManifestHash = await sha256Bytes(meshManifest);
    const splatManifestHash = await sha256Bytes(splatManifest);
    const meshGeometry: KernelGeometryObject = {
      kind: 'surface3d',
      mesh: {
        storage: {
          kind: 'resource',
          resource: {
            objectHash: meshManifestHash,
            mediaType: PREPARED_FORMAT,
            byteLength: meshManifest.byteLength,
          },
        },
        closedManifold: false,
        triangleMaterialSlots: null,
        materials: null,
      },
    };
    const splatGeometry: KernelGeometryObject = {
      kind: 'gaussianSplatCloud',
      dataset: {
        formatId: PREPARED_FORMAT,
        metadata: {
          objectHash: splatManifestHash,
          mediaType: 'application/json',
          byteLength: splatManifest.byteLength,
        },
        elementCount: LOGICAL_SPLATS,
      },
    };
    mixedAdmissions = [
      canonicalAdmission(viewer, MESH_ENTITY_ID, MESH_DATASET_ID, meshGeometry),
      canonicalAdmission(viewer, SPLAT_ENTITY_ID, SPLAT_DATASET_ID, splatGeometry),
    ];
    const mixedMutation = viewer.publishCanonicalRepresentations(mixedAdmissions);
    activeBindings.push(...mixedMutation.bindings);
  }

  const inventory = profile?.inventory ?? {
    gpuMemoryBytes: null,
    systemMemoryBytes: 8 * 1024 ** 3,
    logicalCores: 2,
  };
  const resolvedPolicy =
    state.calibration === null
      ? viewer.resolveHardwarePolicy(
          inventory,
          null,
          PERFORMANCE_PROFILE === 'mobile' ? 'mobileWebView' : 'desktop',
        )
      : viewer.resolveHardwarePolicy(
          inventory,
          state.calibration,
          PERFORMANCE_PROFILE === 'mobile' ? 'mobileWebView' : 'desktop',
        );
  state.hardwarePolicy = resolvedPolicy;
  let runtimeQuality = viewer.runtimeQuality();
  state.runtimeQuality = runtimeQuality;
  const viewportDpr =
    profile === null ? 1 : Math.min(window.devicePixelRatio || 1, runtimeQuality.renderScale);
  state.viewport = viewer.resize(VIEWPORT_WIDTH, VIEWPORT_HEIGHT, viewportDpr);
  viewer.setWorldCamera(camera(CENTER, 8_500, -0.85), [CENTER.x, CENTER.y, CENTER.z]);
  const runtimeLimits = {
    decoderWorkers: resolvedPolicy.decoderWorkers,
    contentRequests: resolvedPolicy.contentRequests,
  };
  const decodePool = new KernelDecodeWorkerPool(
    '/decode-wasm/himmelcad_decode_wasm.js',
    runtimeLimits.decoderWorkers,
    () => new Worker('/decode-worker.js', { type: 'module', name: 'himmelcad-scale-decode' }),
    Math.min(768 * 1024 * 1024, resolvedPolicy.resources.cpuDecodedBytes),
  );
  const driver = new KernelStreamingDriver(viewer, undefined, undefined, undefined, decodePool);
  driver.setRuntimeLimits(runtimeLimits);
  state.runtimeLimits = runtimeLimits;
  state.capabilities = viewer.capabilities;

  const budget = scaleBudget(resolvedPolicy, profile);
  state.residentPointCeiling = budget.points;
  const frameBudget =
    profile === null
      ? {
          targetFrameMs: 16.7,
          traversalMs: 5,
          decodeMs: 8,
          uploadBytes: 4 * 1024 * 1024,
          newRequests: runtimeLimits.contentRequests,
        }
      : resolvedPolicy.frame;
  let detailScale = profile === null ? 1.5 : Math.min(1.5, runtimeQuality.detailScale);
  const fetched = new Set<string>();
  const evicted = new Set<string>();
  const reentered = new Set<string>();
  const rendered = new Set<string>();
  const tracked = new Map<string, 'fetching' | 'decoded' | 'resident'>();
  const interactionFrameMs: number[] = [];
  const interactionPlanMs: number[] = [];
  const interactionStreamingHostMs: number[] = [];
  const interactionRenderPresentMs: number[] = [];

  const observeActions = (actions: readonly KernelStreamingAction[]): void => {
    for (const action of actions) {
      state.actionCounts[action.kind] += 1;
      if (action.kind === 'fetchTile') {
        const key = tileKey(action);
        if (evicted.has(key)) reentered.add(key);
        fetched.add(key);
        tracked.set(key, 'fetching');
        if (action.descriptor.id === 'r') {
          const bounds = action.descriptor.bounds;
          if (
            bounds.kind !== 'axisAlignedBox' ||
            JSON.stringify(bounds.bounds.min) !==
              JSON.stringify({
                x: SOURCE_BOUNDS.min[0],
                y: SOURCE_BOUNDS.min[1],
                z: SOURCE_BOUNDS.min[2],
              }) ||
            JSON.stringify(bounds.bounds.max) !==
              JSON.stringify({
                x: SOURCE_BOUNDS.max[0],
                y: SOURCE_BOUNDS.max[1],
                z: SOURCE_BOUNDS.max[2],
              })
          ) {
            throw new Error('Potree provider did not retain exact f64 root bounds');
          }
        }
      } else if (action.kind === 'evictTile') {
        const key = tileKey(action);
        evicted.add(key);
        tracked.delete(key);
      } else if (action.kind === 'decodeTile') {
        tracked.set(`${action.ticket.key.datasetId}/${action.ticket.key.tileId}`, 'decoded');
      } else if (action.kind === 'uploadTile') {
        tracked.set(`${action.ticket.key.datasetId}/${action.ticket.key.tileId}`, 'resident');
      }
    }
  };

  const recycleCanonicalScene = async (): Promise<KernelResourceCost> => {
    const retirement = viewer.detachCanonicalEntities(activeBindings);
    for (const datasetId of retirement.retiredDatasetIds) {
      driver.detachDataset(datasetId);
      for (const key of tracked.keys()) {
        if (key.startsWith(`${datasetId}/`)) tracked.delete(key);
      }
    }
    await driver.settled();
    const drained = viewer.streamingRuntime();
    if (
      drained.trackedEntries !== 0 ||
      Object.values(drained.residencyStageCounts).some((count) => count !== 0) ||
      Object.values(drained.residencyCost).some((cost) => cost !== 0)
    ) {
      throw new Error(`canonical unload retained streamed residency: ${JSON.stringify(drained)}`);
    }

    const tombstones = new Map(
      retirement.tombstones.map((tombstone) => [
        `${tombstone.key.slot.entityId}\u0000${tombstone.key.slot.representationSlot}`,
        tombstone.generation,
      ]),
    );
    const replayAdmissions = [pointAdmission, ...mixedAdmissions].map((item) => ({
      ...item,
      admission: {
        ...item.admission,
        expectedGeneration:
          tombstones.get(`${item.admission.entity.id}\u0000${item.admission.representationSlot}`) ??
          null,
      },
    }));
    viewer.registerPotreeDataset(
      DATASET_ID,
      'potree@2',
      '/scale/metadata.json',
      metadataBytes,
      hierarchyBytes,
    );
    if (meshManifest !== null && splatManifest !== null) {
      viewer.registerPreparedDataset(
        MESH_DATASET_ID,
        PREPARED_FORMAT,
        '/scale/mixed/mesh/manifest.json',
        meshManifest,
      );
      viewer.registerPreparedDataset(
        SPLAT_DATASET_ID,
        PREPARED_FORMAT,
        '/scale/mixed/splat/manifest.json',
        splatManifest,
      );
    }
    activeBindings = [...viewer.publishCanonicalRepresentations(replayAdmissions).bindings];
    return drained.residencyCost;
  };

  const runFrame = async (
    interacting: boolean,
    settle: boolean,
  ): Promise<{
    cpuMs: number;
    eventLoopDelayMs: number;
    presented: boolean;
    inflight: boolean;
  }> => {
    const started = performance.now();
    const activeFrameBudget = interacting ? resolvedPolicy.interaction.frame : frameBudget;
    const maximumTraversedNodes = interacting
      ? resolvedPolicy.interaction.maximumTraversedNodes
      : Math.min(MAXIMUM_TRAVERSED_NODES, resolvedPolicy.maximumTraversedNodes);
    const plan = viewer.planStreamingFrame({
      resourceBudget: budget,
      frameBudget: activeFrameBudget,
      maximumScreenSpaceError: 0.7,
      detailScale,
      maximumTraversedNodes,
      includeRenderKeys: !interacting,
    });
    const plannedAt = performance.now();
    state.maximumPlanTiles = Math.max(
      state.maximumPlanTiles,
      plan.renderCount + plan.actions.length,
    );
    if (state.maximumPlanTiles > MAXIMUM_TRAVERSED_NODES) {
      throw new Error('observable streaming plan exceeded its traversal work bound');
    }
    observeActions(plan.actions);
    for (const key of plan.render) rendered.add(`${key.datasetId}/${key.tileId}`);
    const uploadedBytes = driver.execute(plan);
    const streamedAt = performance.now();
    const inflight =
      driver.diagnostics().activeRequests > 0 ||
      driver.diagnostics().activeDecodes > 0 ||
      driver.diagnostics().queuedDecodes > 0;
    const outcome = viewer.render();
    const renderedAt = performance.now();
    let cpuMs = renderedAt - started;
    const qualityObservation = viewer.observeFrameTelemetry({
      cpuMs,
      interacting,
      uploadedBytes,
    });
    if (profile !== null && qualityObservation.adjustment !== 'unchanged') {
      runtimeQuality = qualityObservation.quality;
      state.runtimeQuality = runtimeQuality;
      detailScale = Math.min(1.5, runtimeQuality.detailScale);
      state.viewport = viewer.resize(
        VIEWPORT_WIDTH,
        VIEWPORT_HEIGHT,
        Math.min(window.devicePixelRatio || 1, runtimeQuality.renderScale),
      );
      cpuMs = performance.now() - started;
    }
    if (interacting) {
      interactionFrameMs.push(cpuMs);
      interactionPlanMs.push(plannedAt - started);
      interactionStreamingHostMs.push(streamedAt - plannedAt);
      interactionRenderPresentMs.push(renderedAt - streamedAt);
    }
    if (settle) await driver.settled();
    const eventLoopStarted = performance.now();
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    return {
      cpuMs,
      eventLoopDelayMs: Math.max(0, performance.now() - eventLoopStarted - 16.7),
      presented: outcome.status === 'presented',
      inflight,
    };
  };

  const runBurst = async (
    name: string,
    frames: number,
    updateCamera: (frame: number) => void,
  ): Promise<void> => {
    const inputAt = performance.now();
    let inputToFirstPresentedMs = Number.POSITIVE_INFINITY;
    let maximumCpuMs = 0;
    let maximumEventLoopDelayMs = 0;
    let longFrames = 0;
    let inflightObserved = false;
    for (let frame = 0; frame < frames; frame += 1) {
      updateCamera(frame);
      const observation = await runFrame(true, false);
      if (observation.presented && !Number.isFinite(inputToFirstPresentedMs)) {
        inputToFirstPresentedMs = performance.now() - inputAt;
      }
      maximumCpuMs = Math.max(maximumCpuMs, observation.cpuMs);
      maximumEventLoopDelayMs = Math.max(maximumEventLoopDelayMs, observation.eventLoopDelayMs);
      longFrames += Number(observation.cpuMs > 50);
      inflightObserved ||= observation.inflight;
    }
    state.interactionBursts.push({
      name,
      frames,
      inputToFirstPresentedMs,
      maximumCpuMs,
      maximumEventLoopDelayMs,
      longFrames,
      inflightObserved,
    });
  };

  const corners = [
    { x: 130_260, y: 450_320, z: 20 },
    { x: 134_740, y: 455_930, z: 20 },
    { x: 130_300, y: 455_900, z: 20 },
    { x: 134_700, y: 450_350, z: 20 },
    { x: 130_260, y: 450_320, z: 20 }, // deterministic re-entry target
  ] as const;
  state.phase = 'camera-path';
  viewer.setWorldCamera(camera(CENTER, 9_000, -0.9), [CENTER.x, CENTER.y, CENTER.z]);
  for (let frame = 0; frame < (SOFTWARE_CORRECTNESS ? 6 : 10); frame += 1)
    await runFrame(true, true);

  if (profile !== null) {
    state.phase = 'profile-fill';
    const minimumNodes = profile.minimumDrawCalls;
    const maximumFillFrames =
      Math.ceil(minimumNodes / Math.max(1, frameBudget.newRequests)) * 4 + 64;
    for (let frame = 0; frame < maximumFillFrames; frame += 1) {
      viewer.setWorldCamera(camera(CENTER, 7_500, -0.9 + frame * 0.003), [
        CENTER.x,
        CENTER.y,
        CENTER.z,
      ]);
      await runFrame(false, true);
      const telemetry = viewer.frameTelemetry();
      const textureCache = viewer.gpuTextureCacheStats();
      if (
        telemetry !== null &&
        telemetry.peakPoints >= profile.minimumPoints &&
        telemetry.peakTriangles >= profile.minimumTriangles &&
        telemetry.peakSplats >= profile.minimumSplats &&
        textureCache.gpuTextureBytes >= profile.minimumTextureBytes &&
        telemetry.peakDrawCalls >= profile.minimumDrawCalls
      ) {
        state.profilePeak = {
          points: telemetry.peakPoints,
          triangles: telemetry.peakTriangles,
          splats: telemetry.peakSplats,
          textureBytes: textureCache.gpuTextureBytes,
          drawCalls: telemetry.peakDrawCalls,
        };
        state.profilePeaksReached = true;
        break;
      }
    }
    if (!state.profilePeaksReached) {
      const telemetry = viewer.frameTelemetry();
      const failureDiagnostics = driver.diagnostics();
      const failureRuntime = viewer.streamingRuntime();
      const failureServerStats = (await fetch('/scale/stats.json').then(
        async (response) => await response.json(),
      )) as ScaleServerStats;
      throw new Error(
        `${PERFORMANCE_PROFILE} profile did not physically reach its workload before latency sampling: ${JSON.stringify(
          {
            requiredPoints: profile.minimumPoints,
            requiredTriangles: profile.minimumTriangles,
            requiredSplats: profile.minimumSplats,
            requiredTextureBytes: profile.minimumTextureBytes,
            requiredDrawCalls: profile.minimumDrawCalls,
            peakPoints: telemetry?.peakPoints ?? 0,
            peakTriangles: telemetry?.peakTriangles ?? 0,
            peakSplats: telemetry?.peakSplats ?? 0,
            peakResidentGpuBytes: telemetry?.peakResidentGpuBytes ?? 0,
            gpuTextureBytes: viewer.gpuTextureCacheStats().gpuTextureBytes,
            peakDrawCalls: telemetry?.peakDrawCalls ?? 0,
            maximumFillFrames,
            driver: failureDiagnostics,
            streaming: failureRuntime,
            server: failureServerStats,
          },
        )}`,
      );
    }
    interactionFrameMs.length = 0;
    interactionPlanMs.length = 0;
    interactionStreamingHostMs.length = 0;
    interactionRenderPresentMs.length = 0;
    state.phase = 'camera-path';
  }

  const primerTarget = corners[3];
  viewer.setWorldCamera(camera(primerTarget, 40, 2.4), [
    primerTarget.x,
    primerTarget.y,
    primerTarget.z,
  ]);
  const liveStreamingPrimer = viewer.planStreamingFrame({
    resourceBudget: budget,
    frameBudget,
    maximumScreenSpaceError: 0.7,
    detailScale: 1.5,
    maximumTraversedNodes: Math.min(MAXIMUM_TRAVERSED_NODES, resolvedPolicy.maximumTraversedNodes),
    includeRenderKeys: true,
  });
  if (
    !liveStreamingPrimer.actions.some(
      (action) => action.kind === 'fetchTile' || action.kind === 'decodeTile',
    )
  ) {
    throw new Error('deep-view primer did not schedule real fetch/decode work');
  }
  observeActions(liveStreamingPrimer.actions);
  driver.execute(liveStreamingPrimer);
  const burstTarget = corners[0];
  await runBurst('zoom-orbit-with-live-streaming', SOFTWARE_CORRECTNESS ? 12 : 24, (frame) => {
    const radius = 520 - frame * 15;
    viewer.setWorldCamera(camera(burstTarget, radius, -0.8 + frame * 0.19), [
      burstTarget.x,
      burstTarget.y,
      burstTarget.z,
    ]);
  });
  if (!state.interactionBursts[0]?.inflightObserved) {
    throw new Error('interaction burst never overlapped real fetch/decode work');
  }
  await driver.settled();
  for (let frame = 0; frame < (SOFTWARE_CORRECTNESS ? 5 : 8); frame += 1)
    await runFrame(true, true);

  await runBurst('rapid-direction-change-and-cancel', SOFTWARE_CORRECTNESS ? 8 : 18, (frame) => {
    const target = corners[1 + (frame % 3)]!;
    viewer.setWorldCamera(camera(target, 260, frame * 1.07), [target.x, target.y, target.z]);
  });
  await driver.settled();
  for (const [cornerIndex, target] of corners.entries()) {
    for (let orbit = 0; orbit < (SOFTWARE_CORRECTNESS ? 1 : 3); orbit += 1) {
      viewer.setWorldCamera(camera(target, 360 - orbit * 70, cornerIndex * 1.31 + orbit * 0.73), [
        target.x,
        target.y,
        target.z,
      ]);
      for (let frame = 0; frame < (SOFTWARE_CORRECTNESS ? 5 : 9); frame += 1)
        await runFrame(true, true);
    }
  }
  const firstEvicted = [...evicted].find((key) => key.startsWith(`${DATASET_ID}/`));
  if (firstEvicted !== undefined) {
    const tileId = firstEvicted.slice(firstEvicted.indexOf('/') + 1);
    const focus = tileCenter(tileId);
    for (
      let frame = 0;
      frame < (SOFTWARE_CORRECTNESS ? 16 : 24) && reentered.size === 0;
      frame += 1
    ) {
      viewer.setWorldCamera(camera(focus, 190, frame * 0.31), [focus.x, focus.y, focus.z]);
      await runFrame(true, true);
    }
  }
  viewer.setWorldCamera(camera(CENTER, 9_000, 2.1), [CENTER.x, CENTER.y, CENTER.z]);
  for (let frame = 0; frame < (SOFTWARE_CORRECTNESS ? 6 : 12); frame += 1)
    await runFrame(false, true);
  await driver.settled();

  state.phase = 'residency-plateau';
  const drainedCosts: KernelResourceCost[] = [];
  const reloadCosts: KernelResourceCost[] = [];
  const reloadRequestDeltas: number[] = [];
  const plateauCycles = SOFTWARE_CORRECTNESS ? 2 : 3;
  const plateauTarget = corners[0];
  for (let cycle = 0; cycle < plateauCycles; cycle += 1) {
    drainedCosts.push(await recycleCanonicalScene());

    const requestsBeforeReload = driver.diagnostics().startedRequests;
    viewer.setWorldCamera(camera(plateauTarget, 240, -0.8), [
      plateauTarget.x,
      plateauTarget.y,
      plateauTarget.z,
    ]);
    for (let frame = 0; frame < (SOFTWARE_CORRECTNESS ? 16 : 32); frame += 1) {
      await runFrame(false, true);
    }
    for (let frame = 0; frame < 512; frame += 1) {
      const runtime = viewer.streamingRuntime();
      if (
        runtime.residencyStageCounts.fetching === 0 &&
        runtime.residencyStageCounts.queuedDecode === 0 &&
        runtime.residencyStageCounts.decoding === 0 &&
        runtime.residencyStageCounts.uploading === 0
      ) {
        break;
      }
      await runFrame(false, true);
    }
    const reloaded = viewer.streamingRuntime();
    const requestDelta = driver.diagnostics().startedRequests - requestsBeforeReload;
    if (reloaded.residencyStageCounts.resident === 0 || requestDelta === 0) {
      throw new Error(
        `drained residency did not reload from immutable providers: ${JSON.stringify({ reloaded, requestDelta })}`,
      );
    }
    reloadCosts.push(reloaded.residencyCost);
    reloadRequestDeltas.push(requestDelta);
  }
  state.residencyPlateau = { drainedCosts, reloadCosts, reloadRequestDeltas };
  assertResidencyPlateau(reloadCosts, budget);

  state.phase = 'assertions';
  state.driverDiagnostics = driver.diagnostics();
  state.frameTelemetry = viewer.frameTelemetry();
  state.textureCache = viewer.gpuTextureCacheStats();
  const streamingRuntime = viewer.streamingRuntime() as ScaleStreamingRuntime;
  const stageCounts = streamingRuntime.residencyStageCounts;
  if (
    !Number.isSafeInteger(streamingRuntime.trackedEntries) ||
    streamingRuntime.trackedEntries < 0 ||
    stageCounts === undefined ||
    Object.values(stageCounts).some((count) => !Number.isSafeInteger(count) || count < 0)
  ) {
    throw new Error(
      `kernel streaming runtime omitted trackedEntries: ${JSON.stringify(streamingRuntime)}`,
    );
  }
  state.streamingRuntime = streamingRuntime;
  state.serverStats = (await fetch('/scale/stats.json').then(
    async (response) => await response.json(),
  )) as ScaleServerStats;
  state.evictedTiles = [...evicted].sort();
  state.reenteredTiles = [...reentered].sort();
  state.fetchedTiles = [...fetched].sort();
  state.renderedTiles = [...rendered].sort();
  state.trackedEntries = streamingRuntime.trackedEntries;
  state.locallyTrackedEntries = tracked.size;
  state.queuedUploadDecodedUpperBoundBytes =
    stageCounts.queuedUpload * MAXIMUM_POINTS_PER_NODE * GPU_POINT_BYTES;
  state.interactionLatency = phaseLatency(interactionFrameMs);
  const interactionP95 = state.interactionLatency.p95Ms;
  const interactionP99 = state.interactionLatency.p99Ms;
  state.interactionPhases = {
    plan: phaseLatency(interactionPlanMs),
    streamingHost: phaseLatency(interactionStreamingHostMs),
    renderPresent: phaseLatency(interactionRenderPresentMs),
  };

  if (
    state.hierarchy.nodeCount !== NODE_COUNT ||
    state.hierarchy.logicalPoints !== LOGICAL_POINTS ||
    state.hierarchy.logicalTriangles !== LOGICAL_TRIANGLES ||
    state.hierarchy.logicalSplats !== LOGICAL_SPLATS
  ) {
    throw new Error('scale hierarchy totals changed during the run');
  }
  if (
    state.actionCounts.fetchTile === 0 ||
    state.actionCounts.decodeTile === 0 ||
    state.actionCounts.uploadTile === 0
  ) {
    throw new Error(
      `real streaming lifecycle did not complete: ${JSON.stringify(state.actionCounts)}`,
    );
  }
  if (
    state.actionCounts.fetchHierarchyPage === 0 ||
    state.serverStats.hierarchyPageRangeRequests === 0
  ) {
    throw new Error(
      `lazy Potree hierarchy pages were not range-loaded: ${JSON.stringify(state.serverStats)}`,
    );
  }
  if (state.actionCounts.evictTile === 0 || reentered.size === 0) {
    throw new Error(
      `camera path did not prove eviction and re-entry: ${JSON.stringify(state.actionCounts)}`,
    );
  }
  if (
    state.driverDiagnostics.peakRequests > runtimeLimits.contentRequests ||
    state.driverDiagnostics.actualDecodeWorkers > runtimeLimits.decoderWorkers
  ) {
    throw new Error(
      `host concurrency ceiling was exceeded: ${JSON.stringify(state.driverDiagnostics)}`,
    );
  }
  if (
    state.frameTelemetry === null ||
    state.frameTelemetry.peakPoints > state.residentPointCeiling
  ) {
    throw new Error(`resident point budget was exceeded: ${JSON.stringify(state.frameTelemetry)}`);
  }
  if (state.frameTelemetry.peakResidentGpuBytes >= state.hierarchy.virtualOctreeBytes) {
    throw new Error('logical octree size leaked into physical GPU residency');
  }
  if (
    !Number.isFinite(state.driverDiagnostics.mainThreadDecodeIngestMs) ||
    !Number.isFinite(state.driverDiagnostics.maximumMainThreadDecodeIngestMs) ||
    state.driverDiagnostics.maximumMainThreadDecodeIngestMs >
      state.driverDiagnostics.mainThreadDecodeIngestMs ||
    state.driverDiagnostics.retainedFetchedCompressedBytes !== 0
  ) {
    throw new Error(
      `final decode/drain accounting is inconsistent: ${JSON.stringify(state.driverDiagnostics)}`,
    );
  }
  const countedStages = Object.values(stageCounts).reduce((total, count) => total + count, 0);
  const maximumResidentEntries = budget.drawCalls;
  if (
    state.trackedEntries !== countedStages ||
    state.trackedEntries !== state.locallyTrackedEntries ||
    stageCounts.fetching !== 0 ||
    stageCounts.queuedDecode !== 0 ||
    stageCounts.decoding !== 0 ||
    stageCounts.uploading !== 0 ||
    stageCounts.failed !== 0 ||
    state.driverDiagnostics.failedOperations !== 0 ||
    stageCounts.unloaded !== 0 ||
    stageCounts.resident > maximumResidentEntries ||
    stageCounts.queuedUpload !== state.driverDiagnostics.decodedReadyTiles ||
    state.queuedUploadDecodedUpperBoundBytes > budget.cpuDecodedBytes
  ) {
    throw new Error(
      `Rust/host residency stages escaped or diverged after drain: ${JSON.stringify({
        rust: state.trackedEntries,
        host: state.locallyTrackedEntries,
        stageCounts,
        maximumResidentEntries,
        decodedReadyTiles: state.driverDiagnostics.decodedReadyTiles,
        failedOperations: state.driverDiagnostics.failedOperations,
        recentFailures: state.driverDiagnostics.recentFailures,
        queuedUploadDecodedUpperBoundBytes: state.queuedUploadDecodedUpperBoundBytes,
        cpuDecodedBudget: budget.cpuDecodedBytes,
      })}`,
    );
  }
  const contentActions = state.actionCounts.fetchTile + state.actionCounts.fetchHierarchyPage;
  const startedContentRequests =
    state.serverStats.rangeRequests +
    state.serverStats.hierarchyPageRangeRequests +
    state.serverStats.preparedContentRequests;
  if (
    state.driverDiagnostics.startedRequests +
      state.driverDiagnostics.cancelledBeforeStartRequests !==
      contentActions ||
    startedContentRequests > state.driverDiagnostics.startedRequests ||
    state.driverDiagnostics.startedRequests - startedContentRequests >
      state.driverDiagnostics.abortedAfterStartRequests ||
    state.serverStats.duplicateNodeRequests === 0
  ) {
    throw new Error(
      `virtual Range endpoint did not prove selective re-fetch/cancellation: ${JSON.stringify({ server: state.serverStats, driver: state.driverDiagnostics, contentActions })}`,
    );
  }
  if (state.serverStats.hierarchyPageRangeRequests !== state.actionCounts.fetchHierarchyPage) {
    throw new Error('hierarchy action count does not match the Range endpoint audit');
  }
  if (
    profile !== null &&
    (state.serverStats.meshContentRequests <
      Math.ceil(profile.minimumTriangles / MESH_TRIANGLES_PER_TILE) ||
      state.serverStats.splatContentRequests < Math.ceil(profile.minimumSplats / SPLATS_PER_TILE))
  ) {
    throw new Error(
      `mixed providers did not fetch enough physical tiles: ${JSON.stringify(state.serverStats)}`,
    );
  }

  if (
    profile !== null &&
    (state.profilePeak === null ||
      state.profilePeak.points < profile.minimumPoints ||
      state.profilePeak.triangles < profile.minimumTriangles ||
      state.profilePeak.splats < profile.minimumSplats ||
      state.profilePeak.textureBytes < profile.minimumTextureBytes ||
      state.profilePeak.drawCalls < profile.minimumDrawCalls)
  ) {
    throw new Error(
      `${PERFORMANCE_PROFILE} profile workload regressed before latency assertion: ${JSON.stringify(
        {
          requiredPoints: profile.minimumPoints,
          requiredTriangles: profile.minimumTriangles,
          requiredSplats: profile.minimumSplats,
          requiredTextureBytes: profile.minimumTextureBytes,
          requiredDrawCalls: profile.minimumDrawCalls,
          peakPoints: state.profilePeak?.points ?? 0,
          peakTriangles: state.profilePeak?.triangles ?? 0,
          peakSplats: state.profilePeak?.splats ?? 0,
          peakResidentGpuBytes: state.frameTelemetry.peakResidentGpuBytes,
          gpuTextureBytes: state.profilePeak?.textureBytes ?? 0,
          peakDrawCalls: state.profilePeak?.drawCalls ?? 0,
        },
      )}`,
    );
  }
  if (PERFORMANCE_PROFILE === 'low' && (interactionP95 > 33 || interactionP99 > 50)) {
    throw new Error(
      `low profile interaction target missed: p95=${interactionP95}, p99=${interactionP99}`,
    );
  }
  if (PERFORMANCE_PROFILE === 'mobile' && (interactionP95 > 33 || interactionP99 > 50)) {
    throw new Error(
      `mobile WebView short-profile target missed: p95=${interactionP95}, p99=${interactionP99}`,
    );
  }
  if (PERFORMANCE_PROFILE === 'mainstream' && (interactionP95 > 16.7 || interactionP99 > 33)) {
    throw new Error(
      `mainstream profile interaction target missed: p95=${interactionP95}, p99=${interactionP99}`,
    );
  }
  if (PERFORMANCE_PROFILE === 'high' && interactionP95 > 16.7) {
    throw new Error(`high profile interaction target missed: p95=${interactionP95}`);
  }

  state.phase = 'complete';
  state.ready = true;
  status.textContent = `${LOGICAL_POINTS.toLocaleString()} points + ${LOGICAL_TRIANGLES.toLocaleString()} triangles + ${LOGICAL_SPLATS.toLocaleString()} splats`;
  driver.dispose();
  viewer.dispose();
}

void run().catch((error: unknown) => {
  state.phase = 'failed';
  state.error = error instanceof Error ? `${error.message}\n${error.stack ?? ''}` : String(error);
  const status = document.querySelector<HTMLOutputElement>('#status');
  if (status) status.textContent = state.error;
  console.error(error);
});

function percentile(sorted: readonly number[], fraction: number): number {
  if (sorted.length === 0) return Number.POSITIVE_INFINITY;
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)]!;
}

function assertResidencyPlateau(
  samples: readonly KernelResourceCost[],
  budget: KernelResourceBudget,
): void {
  if (samples.length < 2) throw new Error('residency plateau requires repeated reload samples');
  const dimensions = [
    'cpuCompressedBytes',
    'cpuDecodedBytes',
    'gpuBufferBytes',
    'gpuTextureBytes',
    'stagingBytes',
    'points',
    'triangles',
    'splats',
    'drawCalls',
  ] as const;
  for (const dimension of dimensions) {
    const values = samples.map((sample) => sample[dimension]);
    const maximum = Math.max(...values);
    const minimum = Math.min(...values);
    const tolerance = Math.max(1, Math.ceil(budget[dimension] * 0.15));
    if (maximum > budget[dimension] || maximum - minimum > tolerance) {
      throw new Error(
        `residency ${dimension} did not plateau across complete reloads: ${JSON.stringify({ values, budget: budget[dimension], tolerance })}`,
      );
    }
  }
}

function phaseLatency(samples: readonly number[]): PhaseLatencyTelemetry {
  const sorted = [...samples].sort((left, right) => left - right);
  return {
    p50Ms: percentile(sorted, 0.5),
    p95Ms: percentile(sorted, 0.95),
    p99Ms: percentile(sorted, 0.99),
    maximumMs: sorted.at(-1) ?? Number.POSITIVE_INFINITY,
  };
}

function performanceProfile(value: string | null): PerformanceProfileName | null {
  if (value === null || value === '') return null;
  if (value === 'mobile' || value === 'low' || value === 'mainstream' || value === 'high') {
    return value;
  }
  throw new TypeError(`unknown scale performance profile ${value}`);
}

function profileResidentNodes(profile: PerformanceProfile): number {
  return Math.max(
    profile.minimumPointDrawCalls,
    Math.ceil(profile.minimumPoints / MINIMUM_POINTS_PER_NODE),
  );
}

function scaleBudget(
  policy: KernelResolvedHardwarePolicy,
  profile: PerformanceProfile | null,
): KernelResourceBudget {
  if (profile === null) {
    return {
      cpuCompressedBytes: 4 * 1024 * 1024,
      cpuDecodedBytes: 16 * 1024 * 1024,
      gpuBufferBytes: 16 * 1024 * 1024,
      gpuTextureBytes: 1,
      stagingBytes: 16 * 1024 * 1024,
      points: 220_000,
      triangles: 1,
      splats: 1,
      drawCalls: 8,
    };
  }
  const residentNodes = profileResidentNodes(profile);
  const pointCeiling = residentNodes * MAXIMUM_POINTS_PER_NODE;
  const gpuBufferBytes =
    pointCeiling * GPU_POINT_BYTES + profile.minimumTriangles * 96 + profile.minimumSplats * 32;
  if (
    policy.resources.points < pointCeiling ||
    policy.resources.triangles < profile.minimumTriangles ||
    policy.resources.splats < profile.minimumSplats ||
    policy.resources.drawCalls < profile.minimumDrawCalls ||
    policy.resources.gpuBufferBytes < gpuBufferBytes ||
    policy.resources.gpuTextureBytes < profile.minimumTextureBytes
  ) {
    throw new Error(
      `${PERFORMANCE_PROFILE} profile is unsupported by the resolved Rust hardware policy: ${JSON.stringify(
        {
          required: {
            resourcePoints: pointCeiling,
            workloadPoints: profile.minimumPoints,
            triangles: profile.minimumTriangles,
            splats: profile.minimumSplats,
            drawCalls: profile.minimumDrawCalls,
            gpuBufferBytes,
            gpuTextureBytes: profile.minimumTextureBytes,
          },
          resolved: { resources: policy.resources, workload: policy.workload },
        },
      )}`,
    );
  }
  return {
    cpuCompressedBytes: policy.resources.cpuCompressedBytes,
    cpuDecodedBytes: policy.resources.cpuDecodedBytes,
    gpuBufferBytes,
    gpuTextureBytes: profile.minimumTextureBytes,
    stagingBytes: policy.resources.stagingBytes,
    points: pointCeiling,
    triangles: profile.minimumTriangles,
    splats: profile.minimumSplats,
    drawCalls: profile.minimumDrawCalls,
  };
}

async function calibrateHardware(viewer: WgpuKernelViewer): Promise<KernelDeviceCalibration> {
  let progress = viewer.beginHardwareCalibration();
  for (let attempt = 0; progress.calibration === null && attempt < 600; attempt += 1) {
    progress = viewer.stepHardwareCalibration();
    viewer.render();
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  }
  if (progress.calibration === null) {
    throw new Error(`hardware profile calibration did not complete: ${JSON.stringify(progress)}`);
  }
  return progress.calibration;
}

function isSoftwareAdapter(capabilities: WgpuKernelViewer['capabilities']): boolean {
  const identity =
    `${capabilities.adapterName} ${capabilities.driver} ${capabilities.driverInfo}`.toLowerCase();
  return (
    capabilities.deviceKind === 'cpu' || /swiftshader|llvmpipe|software rasterizer/.test(identity)
  );
}

function canonicalAdmission(
  viewer: WgpuKernelViewer,
  entityId: string,
  datasetId: string,
  geometry: KernelGeometryObject,
) {
  const geometryRef = viewer.geometryObjectContentHash(geometry);
  const selected = {
    role: 'canonical' as const,
    geometryRef,
    authority: 'authoritative' as const,
    dependencyHash: null,
  };
  const entityWithoutVersion = {
    id: entityId,
    revision: 1,
    typeId: 'de.himmelcad.scale-point-cloud@1',
    name: 'AHN4 C_31HZ1 synthetic logical scale cloud',
    owner: null,
    layerIds: [],
    placement: null,
    representations: [selected],
    componentsRef: 'c1'.repeat(32),
    attributesRef: 'a1'.repeat(32),
    relationsRef: 'e1'.repeat(32),
    styleRef: null,
    schemaVersion: 1,
  };
  const versionHash = viewer.canonicalEntityVersionHash({
    ...entityWithoutVersion,
    versionHash: '00'.repeat(32),
  });
  return {
    admission: {
      entity: { ...entityWithoutVersion, versionHash },
      selected,
      representationSlot: 'primary',
      expectedGeneration: null,
      resolvedGeometry: geometry,
    },
    datasetId,
    style: style(),
  };
}

async function sha256Bytes(bytes: Uint8Array): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes.slice().buffer));
  return [...digest].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function tileCenter(tileId: string): { x: number; y: number; z: number } {
  const bounds: { min: number[]; max: number[] } = {
    min: [...SOURCE_BOUNDS.min],
    max: [...SOURCE_BOUNDS.max],
  };
  for (const digit of tileId.slice(1)) {
    const index = Number(digit);
    const middle = [0, 1, 2].map((axis) => (bounds.min[axis]! + bounds.max[axis]!) * 0.5);
    for (let axis = 0; axis < 3; axis += 1) {
      const high = (index & (axis === 0 ? 0b100 : axis === 1 ? 0b010 : 0b001)) !== 0;
      if (high) bounds.min[axis] = middle[axis]!;
      else bounds.max[axis] = middle[axis]!;
    }
  }
  return {
    x: (bounds.min[0]! + bounds.max[0]!) * 0.5,
    y: (bounds.min[1]! + bounds.max[1]!) * 0.5,
    z: (bounds.min[2]! + bounds.max[2]!) * 0.5,
  };
}
