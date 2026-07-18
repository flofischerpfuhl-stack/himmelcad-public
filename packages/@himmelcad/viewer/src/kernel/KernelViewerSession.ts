import { KernelCameraController } from './KernelCameraController.js';
import { KernelDecodeWorkerPool } from './KernelDecodeWorkerPool.js';
import type { KernelLoadOperationOptions, KernelLoadProgress } from './KernelLoadOperation.js';
import type { KernelPotreeDatasetAdmission } from './KernelPotreeDatasetAdmission.js';
import type {
  KernelPreparedMeshDatasetAdmission,
  KernelPreparedMeshDatasetResult,
} from './KernelPreparedMeshDatasetAdmission.js';
import type {
  KernelPreparedTinDatasetAdmission,
  KernelPreparedTinDatasetResult,
} from './KernelPreparedTinDatasetAdmission.js';
import {
  KernelStreamingDriver,
  type KernelDecodeExecutor,
  type KernelFetch,
  type KernelStreamingDriverDiagnostics,
} from './KernelStreamingDriver.js';
import { KernelViewerScene, type KernelViewerEntityHandle } from './KernelViewerScene.js';
import {
  kernelStreamingWorkPolicy,
  WgpuKernelViewer,
  type HimmelcadViewerWasmLoader,
  type KernelBackendPreference,
  type KernelCanvasExtent,
  type KernelClipVolume,
  type KernelDeviceCapabilities,
  type KernelEntityCommandMutation,
  type KernelEntityInteractionState,
  type KernelFrameOutcome,
  type KernelGpuFrameTimingDiagnostics,
  type KernelGpuModelCacheStats,
  type KernelGpuTextureCacheStats,
  type KernelHardwareInventory,
  type KernelPickResult,
  type KernelRenderStyle,
  type KernelResolvedHardwarePolicy,
  type KernelRuntimeQualityAdjustment,
  type KernelRuntimeQualityState,
  type KernelStreamingRuntimeState,
  type KernelTransformEntityCommand,
  type KernelWorldCamera,
  type KernelWorldPoint,
} from './WgpuKernelViewer.js';

export type KernelViewerSessionErrorCode =
  | 'aborted'
  | 'creationFailed'
  | 'deviceRecoveryFailed'
  | 'disposed'
  | 'frameFailed'
  | 'loadFailed';

/** Stable typed error boundary exposed to product hosts. */
export class KernelViewerSessionError extends Error {
  override readonly name = 'KernelViewerSessionError';

  constructor(
    readonly code: KernelViewerSessionErrorCode,
    message: string,
    options: { readonly cause?: unknown } = {},
  ) {
    super(message, options);
  }
}

export type KernelViewerSessionEvent =
  | { readonly type: 'frame'; readonly outcome: KernelFrameOutcome }
  | { readonly type: 'hardwarePolicy'; readonly policy: KernelResolvedHardwarePolicy }
  | {
      readonly type: 'runtimeQuality';
      readonly quality: KernelRuntimeQualityState;
      readonly adjustment: Exclude<KernelRuntimeQualityAdjustment, 'unchanged'>;
    }
  | {
      readonly type: 'deviceRecoveryStarted';
      readonly reason: 'deviceLost' | 'outOfMemory';
    }
  | { readonly type: 'deviceRecoveryCompleted' }
  | {
      readonly type: 'loadProgress';
      readonly operationId: string;
      readonly entityId: string;
      readonly datasetId: string;
      readonly progress: KernelLoadProgress;
    }
  | { readonly type: 'error'; readonly error: KernelViewerSessionError }
  | { readonly type: 'disposed' };

export interface KernelViewerSessionOptions {
  readonly canvas: HTMLCanvasElement;
  readonly wasmLoader: HimmelcadViewerWasmLoader;
  readonly backend?: KernelBackendPreference;
  readonly initialWidth?: number;
  readonly initialHeight?: number;
  readonly inventory?: KernelHardwareInventory;
  /** URL of the slim decode-only WASM module used inside transferable workers. */
  readonly decodeWasmModuleUrl?: string;
  readonly createDecodeExecutor?: (
    policy: KernelResolvedHardwarePolicy,
    inventory: KernelHardwareInventory,
  ) => KernelDecodeExecutor;
  readonly createDecodeWorker?: () => Worker;
  readonly fetch?: KernelFetch;
  readonly authoritativeSectionTolerance?: number;
  readonly requestFrame?: () => void;
  readonly signal?: AbortSignal;
}

export interface KernelViewerLoadOptions extends KernelLoadOperationOptions {
  readonly operationId?: string;
}

export interface KernelViewerSessionDiagnostics {
  readonly capabilities: KernelDeviceCapabilities;
  readonly hardwarePolicy: KernelResolvedHardwarePolicy;
  readonly runtimeQuality: KernelRuntimeQualityState;
  readonly streaming: KernelStreamingRuntimeState;
  readonly transport: KernelStreamingDriverDiagnostics;
  readonly gpuModels: KernelGpuModelCacheStats;
  readonly gpuTextures: KernelGpuTextureCacheStats;
  readonly gpuFrameTiming: KernelGpuFrameTimingDiagnostics;
  readonly recoveringDevice: boolean;
  readonly deviceGeneration: number;
}

/**
 * Framework-free owner of one complete shared-viewer lifetime.
 *
 * Product hosts provide only a canvas, asset URLs and scheduling policy. The
 * session owns the Rust/wgpu device, global streaming driver, stable canonical
 * scene, hardware governor and deterministic device replay.
 */
export class KernelViewerSession {
  static async create(options: KernelViewerSessionOptions): Promise<KernelViewerSession> {
    options.signal?.throwIfAborted();
    let viewer: WgpuKernelViewer | null = null;
    let streaming: KernelStreamingDriver | null = null;
    try {
      viewer = await WgpuKernelViewer.create(
        options.canvas,
        options.wasmLoader,
        options.initialWidth,
        options.initialHeight,
        options.backend,
      );
      options.signal?.throwIfAborted();
      const inventory = options.inventory ?? browserHardwareInventory();
      const policy = viewer.resolveHardwarePolicy(inventory);
      const decode = createDecodeExecutor(options, policy, inventory);
      streaming = new KernelStreamingDriver(
        viewer,
        options.fetch,
        options.requestFrame,
        undefined,
        decode,
      );
      streaming.setRuntimeLimits(policy);
      const session = new KernelViewerSession(options, viewer, streaming, inventory, policy);
      viewer.attachClipCapCoordinator(streaming, {
        tolerance: options.authoritativeSectionTolerance ?? 0.001,
        ...(options.requestFrame ? { requestFrame: options.requestFrame } : {}),
        onError: (error) => session.reportError('frameFailed', error),
      });
      viewer.beginHardwareCalibration();
      return session;
    } catch (error) {
      streaming?.dispose();
      viewer?.dispose();
      if (isAbort(error) || options.signal?.aborted) {
        throw new KernelViewerSessionError('aborted', 'viewer session creation was aborted', {
          cause: error,
        });
      }
      throw new KernelViewerSessionError('creationFailed', 'viewer session creation failed', {
        cause: error,
      });
    }
  }

  readonly camera: KernelCameraController;
  readonly scene: KernelViewerScene;
  private viewerState: WgpuKernelViewer;
  private streamingState: KernelStreamingDriver;
  private policyState: KernelResolvedHardwarePolicy;
  private qualityState: KernelRuntimeQualityState;
  private readonly listeners = new Set<(event: KernelViewerSessionEvent) => void>();
  private disposed = false;
  private calibrationComplete = false;
  private recovery: Promise<void> | null = null;
  private recoveryAbort: AbortController | null = null;
  private recoveryReason: 'deviceLost' | 'outOfMemory' | null = null;
  private nextOperationId = 1;
  private deviceGeneration = 1;

  private constructor(
    private readonly options: KernelViewerSessionOptions,
    viewer: WgpuKernelViewer,
    streaming: KernelStreamingDriver,
    private readonly inventory: KernelHardwareInventory,
    policy: KernelResolvedHardwarePolicy,
  ) {
    this.viewerState = viewer;
    this.streamingState = streaming;
    this.policyState = policy;
    this.qualityState = viewer.runtimeQuality();
    this.camera = new KernelCameraController(
      Math.max(1, options.initialWidth ?? options.canvas.clientWidth),
      Math.max(1, options.initialHeight ?? options.canvas.clientHeight),
    );
    this.scene = new KernelViewerScene(viewer, streaming, options.requestFrame);
  }

  get hardwarePolicy(): KernelResolvedHardwarePolicy {
    this.assertAlive();
    return this.policyState;
  }

  get runtimeQuality(): KernelRuntimeQualityState {
    this.assertAlive();
    return this.qualityState;
  }

  subscribe(listener: (event: KernelViewerSessionEvent) => void): () => void {
    this.assertAlive();
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  resize(width: number, height: number, devicePixelRatio = 1): KernelCanvasExtent {
    this.assertReady();
    const extent = this.viewerState.resize(width, height, devicePixelRatio);
    this.camera.setViewportSize(extent.width, extent.height);
    this.options.requestFrame?.();
    return extent;
  }

  setWorldCamera(
    camera: KernelWorldCamera,
    floatingOrigin?: readonly [number, number, number],
  ): void {
    this.assertReady();
    this.viewerState.setWorldCamera(
      camera,
      floatingOrigin ?? [camera.target.x, camera.target.y, camera.target.z],
    );
    this.options.requestFrame?.();
  }

  setClearColor(color: readonly [number, number, number, number]): void {
    this.assertReady();
    this.viewerState.setClearColor(color);
    this.options.requestFrame?.();
  }

  loadPotree(
    input: KernelPotreeDatasetAdmission,
    options: KernelViewerLoadOptions = {},
  ): Promise<KernelViewerEntityHandle> {
    return this.loadProvider(input.admission.entity.id, input.datasetId, options, (control) =>
      this.scene.loadPotree(input, control),
    );
  }

  loadPreparedMesh(
    input: KernelPreparedMeshDatasetAdmission,
    options: KernelViewerLoadOptions = {},
  ): Promise<KernelPreparedMeshDatasetResult & { readonly handle: KernelViewerEntityHandle }> {
    return this.loadProvider(input.admission.entity.id, input.datasetId, options, (control) =>
      this.scene.loadPreparedMesh(input, control),
    );
  }

  loadPreparedTin(
    input: KernelPreparedTinDatasetAdmission,
    options: KernelViewerLoadOptions = {},
  ): Promise<KernelPreparedTinDatasetResult & { readonly handle: KernelViewerEntityHandle }> {
    return this.loadProvider(input.admission.entity.id, input.datasetId, options, (control) =>
      this.scene.loadPreparedTin(input, control),
    );
  }

  setEntityVisibility(entityId: string, visible: boolean): void {
    this.scene.setEntityVisibility(entityId, visible);
  }

  setEntityStyle(entityId: string, style: KernelRenderStyle, exaggerationDatum = 0): number {
    this.assertReady();
    const generation = this.viewerState.setEntityStyle(entityId, style, exaggerationDatum);
    this.options.requestFrame?.();
    return generation;
  }

  setEntityInteractionState(entityId: string, state: KernelEntityInteractionState): number {
    this.assertReady();
    const generation = this.viewerState.setEntityInteractionState(entityId, state);
    this.options.requestFrame?.();
    return generation;
  }

  setClipVolumes(volumes: readonly KernelClipVolume[]): void {
    this.assertReady();
    this.viewerState.setClipVolumes(volumes);
    this.options.requestFrame?.();
  }

  setScopedClipVolume(scopeId: string, volume: KernelClipVolume | null): void {
    this.assertReady();
    this.viewerState.setScopedClipVolume(scopeId, volume);
    this.options.requestFrame?.();
  }

  transformEntity(
    command: KernelTransformEntityCommand,
    expectedBindings = this.viewerState.canonicalEntityBindings(command.entityId),
  ): KernelEntityCommandMutation {
    this.assertReady();
    const mutation = this.viewerState.transformEntity(command, expectedBindings);
    this.options.requestFrame?.();
    return mutation;
  }

  beginMovePreview(previewId: string, entityId: string, opacityMultiplier = 0.5): number {
    this.assertReady();
    const generation = this.viewerState.beginMovePreview(previewId, entityId, opacityMultiplier);
    this.options.requestFrame?.();
    return generation;
  }

  updateMovePreview(previewId: string, translation: KernelWorldPoint): void {
    this.assertReady();
    this.viewerState.updateMovePreview(previewId, translation);
    this.options.requestFrame?.();
  }

  commitMovePreview(previewId: string, commandId: string): KernelEntityCommandMutation {
    this.assertReady();
    const mutation = this.viewerState.commitMovePreview(previewId, commandId);
    this.options.requestFrame?.();
    return mutation;
  }

  removeMovePreview(previewId: string): boolean {
    this.assertReady();
    const removed = this.viewerState.removeMovePreview(previewId);
    if (removed) this.options.requestFrame?.();
    return removed;
  }

  pick(x: number, y: number, radius = 4): Promise<KernelPickResult> {
    this.assertReady();
    return this.viewerState.pick(x, y, radius);
  }

  frame(interacting = false): KernelFrameOutcome {
    this.assertAlive();
    if (this.recoveryReason !== null) {
      this.startDeviceRecovery();
      return { status: 'recreateDevice', reason: this.recoveryReason };
    }
    const started = performance.now();
    try {
      this.advanceCalibration();
      const work = kernelStreamingWorkPolicy(this.policyState, interacting);
      const plan = this.viewerState.planStreamingFrame({
        resourceBudget: this.policyState.resources,
        frameBudget: work.frame,
        detailScale: this.qualityState.detailScale,
        maximumScreenSpaceError: 2,
        maximumTraversedNodes: work.maximumTraversedNodes,
      });
      const uploadedBytes = this.streamingState.execute(plan);
      const outcome = this.viewerState.render();
      this.emit({ type: 'frame', outcome });
      if (outcome.status === 'recreateSurface') this.viewerState.recoverSurface();
      if (outcome.status === 'recreateDevice') {
        this.recoveryReason = outcome.reason;
        this.startDeviceRecovery();
        return outcome;
      }
      const observation = this.viewerState.observeFrameTelemetry({
        cpuMs: performance.now() - started,
        interacting,
        uploadedBytes,
      });
      this.qualityState = observation.quality;
      if (observation.adjustment !== 'unchanged') {
        this.emit({
          type: 'runtimeQuality',
          quality: observation.quality,
          adjustment: observation.adjustment,
        });
      }
      return outcome;
    } catch (error) {
      const typed = this.reportError('frameFailed', error);
      throw typed;
    }
  }

  async settled(): Promise<void> {
    this.assertAlive();
    await this.recovery;
    await Promise.all([this.streamingState.settled(), this.viewerState.clipCapsSettled()]);
  }

  diagnostics(): KernelViewerSessionDiagnostics {
    this.assertAlive();
    return {
      capabilities: this.viewerState.capabilities,
      hardwarePolicy: this.policyState,
      runtimeQuality: this.qualityState,
      streaming: this.viewerState.streamingRuntime(),
      transport: this.streamingState.diagnostics(),
      gpuModels: this.viewerState.gpuModelCacheStats(),
      gpuTextures: this.viewerState.gpuTextureCacheStats(),
      gpuFrameTiming: this.viewerState.gpuFrameTiming(),
      recoveringDevice: this.recovery !== null,
      deviceGeneration: this.deviceGeneration,
    };
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.recoveryAbort?.abort();
    this.viewerState.detachClipCapCoordinator();
    this.streamingState.dispose();
    this.viewerState.dispose();
    this.emit({ type: 'disposed' });
    this.listeners.clear();
  }

  private advanceCalibration(): void {
    if (this.calibrationComplete) return;
    const progress = this.viewerState.stepHardwareCalibration();
    if (progress.calibration === null) {
      this.options.requestFrame?.();
      return;
    }
    this.policyState = this.viewerState.resolveHardwarePolicy(this.inventory, progress.calibration);
    this.streamingState.setRuntimeLimits(this.policyState);
    this.qualityState = this.viewerState.runtimeQuality();
    this.calibrationComplete = true;
    this.emit({ type: 'hardwarePolicy', policy: this.policyState });
  }

  private startDeviceRecovery(): void {
    if (this.recovery !== null || this.recoveryReason === null || this.disposed) return;
    const reason = this.recoveryReason;
    const oldViewer = this.viewerState;
    const oldStreaming = this.streamingState;
    const abort = new AbortController();
    this.recoveryAbort = abort;
    oldViewer.detachClipCapCoordinator();
    oldStreaming.dispose();
    this.emit({ type: 'deviceRecoveryStarted', reason });
    this.recovery = (async () => {
      const created = await WgpuKernelViewer.create(
        this.options.canvas,
        this.options.wasmLoader,
        undefined,
        undefined,
        this.options.backend,
      );
      if (this.disposed || abort.signal.aborted) {
        created.dispose();
        return;
      }
      const policy = created.resolveHardwarePolicy(this.inventory);
      const decode = createDecodeExecutor(this.options, policy, this.inventory);
      const driver = new KernelStreamingDriver(
        created,
        this.options.fetch,
        this.options.requestFrame,
        undefined,
        decode,
      );
      driver.setRuntimeLimits(policy);
      try {
        oldViewer.replayDefinitionsInto(created);
        created.attachClipCapCoordinator(driver, {
          tolerance: this.options.authoritativeSectionTolerance ?? 0.001,
          ...(this.options.requestFrame ? { requestFrame: this.options.requestFrame } : {}),
          onError: (error) => this.reportError('frameFailed', error),
        });
        await this.scene.recover(created, driver, {
          signal: abort.signal,
          restoreViewState: () => oldViewer.replayViewStateInto(created),
        });
        abort.signal.throwIfAborted();
      } catch (error) {
        created.detachClipCapCoordinator();
        driver.dispose();
        created.dispose();
        throw error;
      }
      this.viewerState = created;
      this.streamingState = driver;
      this.policyState = policy;
      this.qualityState = created.runtimeQuality();
      this.deviceGeneration += 1;
      this.calibrationComplete = false;
      created.beginHardwareCalibration();
      this.recoveryReason = null;
      oldViewer.dispose();
      this.emit({ type: 'hardwarePolicy', policy });
      this.emit({ type: 'deviceRecoveryCompleted' });
      this.options.requestFrame?.();
    })()
      .catch((error) => {
        if (!this.disposed && !abort.signal.aborted) {
          this.reportError('deviceRecoveryFailed', error);
        }
      })
      .finally(() => {
        this.recovery = null;
        this.recoveryAbort = null;
      });
  }

  private async loadProvider<T>(
    entityId: string,
    datasetId: string,
    options: KernelViewerLoadOptions,
    load: (control: KernelLoadOperationOptions) => Promise<T>,
  ): Promise<T> {
    this.assertReady();
    const operationId = options.operationId ?? `viewer-load-${String(this.nextOperationId++)}`;
    if (operationId.length === 0) throw new RangeError('viewer load operationId must be non-empty');
    const onProgress = (progress: KernelLoadProgress): void => {
      try {
        options.onProgress?.(progress);
      } catch {
        // Product observers cannot affect canonical publication.
      }
      this.emit({ type: 'loadProgress', operationId, entityId, datasetId, progress });
    };
    try {
      return await load({
        ...(options.signal ? { signal: options.signal } : {}),
        onProgress,
      });
    } catch (cause) {
      const aborted = options.signal?.aborted || isAbort(cause);
      const error = new KernelViewerSessionError(
        aborted ? 'aborted' : 'loadFailed',
        aborted
          ? `viewer load ${operationId} was aborted`
          : `viewer load ${operationId} failed: ${errorMessage(cause)}`,
        { cause },
      );
      this.emit({ type: 'error', error });
      throw error;
    }
  }

  private reportError(
    code: Extract<KernelViewerSessionErrorCode, 'deviceRecoveryFailed' | 'frameFailed'>,
    cause: unknown,
  ): KernelViewerSessionError {
    const error =
      cause instanceof KernelViewerSessionError
        ? cause
        : new KernelViewerSessionError(code, errorMessage(cause), { cause });
    this.emit({ type: 'error', error });
    return error;
  }

  private emit(event: KernelViewerSessionEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        // Events are observational and never participate in viewer state changes.
      }
    }
  }

  private assertAlive(): void {
    if (this.disposed) throw new KernelViewerSessionError('disposed', 'viewer session is disposed');
  }

  private assertReady(): void {
    this.assertAlive();
    if (this.recoveryReason !== null || this.recovery !== null) {
      throw new KernelViewerSessionError(
        'deviceRecoveryFailed',
        'viewer session is rebuilding its GPU device',
      );
    }
  }
}

function createDecodeExecutor(
  options: KernelViewerSessionOptions,
  policy: KernelResolvedHardwarePolicy,
  inventory: KernelHardwareInventory,
): KernelDecodeExecutor {
  if (options.createDecodeExecutor !== undefined) {
    return options.createDecodeExecutor(policy, inventory);
  }
  if (options.decodeWasmModuleUrl === undefined || options.decodeWasmModuleUrl.length === 0) {
    throw new RangeError('decodeWasmModuleUrl or createDecodeExecutor is required');
  }
  return new KernelDecodeWorkerPool(
    options.decodeWasmModuleUrl,
    policy.decoderWorkers,
    options.createDecodeWorker,
    inventory.systemMemoryBytes === null
      ? 512 * 1024 * 1024
      : Math.max(192 * 1024 * 1024, Math.floor(inventory.systemMemoryBytes * 0.125)),
  );
}

function browserHardwareInventory(): KernelHardwareInventory {
  const browser = globalThis.navigator as
    | (Navigator & { readonly deviceMemory?: number })
    | undefined;
  return {
    gpuMemoryBytes: null,
    systemMemoryBytes:
      typeof browser?.deviceMemory === 'number' ? browser.deviceMemory * 1_073_741_824 : null,
    logicalCores: Math.max(1, Math.min(65_535, browser?.hardwareConcurrency ?? 1)),
  };
}

function isAbort(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError';
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
