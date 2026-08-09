import { KernelCameraController } from './KernelCameraController.js';
import { KernelDecodeWorkerPool } from './KernelDecodeWorkerPool.js';
import type { KernelLoadOperationOptions, KernelLoadProgress } from './KernelLoadOperation.js';
import {
  KernelNavigationController,
  type KernelNavigationCallbacks,
  type KernelNavigationTarget,
  type KernelViewMode,
} from './KernelNavigationController.js';
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
import {
  KernelViewerScene,
  type KernelEntityViewPolicy,
  type KernelPreparedHierarchyAdmission,
  type KernelViewerEntityHandle,
} from './KernelViewerScene.js';
import {
  kernelStreamingWorkPolicy,
  WgpuKernelViewer,
  type HimmelcadViewerWasmLoader,
  type KernelBackendPreference,
  type KernelAnnotationStyle,
  type KernelAuthoritativeSectionProduct,
  type KernelBlockDefinition,
  type KernelCanvasExtent,
  type KernelCanonicalMaterialResourceSet,
  type KernelCanonicalRenderAdmission,
  type KernelCommittedEntityEffectMutation,
  type KernelClipVolume,
  type KernelDeviceCapabilities,
  type KernelEntityCommandMutation,
  type KernelEntityInteractionState,
  type KernelFrameOutcome,
  type KernelGpuFrameTimingDiagnostics,
  type KernelGpuModelCacheStats,
  type KernelGpuTextureCacheStats,
  type KernelHardwareInventory,
  type KernelGlyphAtlasMetadata,
  type KernelPickResult,
  type KernelRasterAnalysisView,
  type KernelRasterDepthDistanceMeasurement,
  type KernelRasterDepthMeasurement,
  type KernelRasterDepthPick,
  type KernelRgbaCaptureRequest,
  type KernelRgbaCaptureResult,
  type KernelRenderStyle,
  type KernelResolvedHardwarePolicy,
  type KernelRuntimeQualityAdjustment,
  type KernelRuntimeQualityState,
  type KernelSectionMutation,
  type KernelSectionRequest,
  type KernelStreamingRuntimeState,
  type KernelTransformEntityCommand,
  type KernelWorldCamera,
  type KernelWorldPoint,
} from './WgpuKernelViewer.js';
import type {
  CanonicalEntity,
  CanonicalEntityEffect,
  CanonicalResourceRef,
  GeometryRepresentationBindingRef,
  GeometryObject,
  HatchPatternResource,
  LineTypeResource,
  TextureResource,
} from './generated/index.js';

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

export type KernelPresentedFrameOutcome = Extract<
  KernelFrameOutcome,
  { readonly status: 'presented' }
>;

export interface KernelPresentedFrameOptions {
  readonly signal?: AbortSignal;
}

interface KernelPresentedFrameWaiter {
  readonly resolve: (outcome: KernelPresentedFrameOutcome) => void;
  readonly reject: (reason: unknown) => void;
  readonly signal: AbortSignal | null;
  onAbort: (() => void) | null;
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
  private navigationState: KernelNavigationController | null = null;
  private navigationInteracting = false;
  private currentStreamingCamera: KernelWorldCamera | null = null;
  private previousStreamingCamera: KernelWorldCamera | null = null;
  private viewModeRequestGeneration = 0;
  private pendingPickMappings = 0;
  private readonly pickMappingWaiters = new Set<() => void>();
  private readonly presentedFrameWaiters = new Set<KernelPresentedFrameWaiter>();

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

  attachNavigation(callbacks: KernelNavigationCallbacks = {}): KernelNavigationController {
    this.assertReady();
    this.navigationState?.dispose(true);
    this.navigationInteracting = false;
    const requestFrame = (): void => {
      this.options.requestFrame?.();
      if (callbacks.requestFrame !== this.options.requestFrame) callbacks.requestFrame?.();
    };
    const target: KernelNavigationTarget = {
      setScopedClipVolume: (scopeId, volume) =>
        this.viewerState.setScopedClipVolume(scopeId, volume),
      setRasterAnalysisView: (entityId) => this.viewerState.setRasterAnalysisView(entityId),
      clearRasterAnalysisView: () => this.viewerState.clearRasterAnalysisView(),
      setWorldCamera: (camera, origin) => this.setNavigationCamera(camera, origin),
      setCameraTransition: (from, to, progress, origin) =>
        this.viewerState.setCameraTransition(from, to, progress, origin),
      pick: (x, y, radius) => this.pick(x, y, radius),
      entityHasKnownSourceHeight: (entityId) => this.scene.entityHasKnownSourceHeight(entityId),
    };
    this.navigationState = new KernelNavigationController(
      this.options.canvas,
      target,
      this.camera,
      {
        ...(callbacks.onActivePick ? { onActivePick: callbacks.onActivePick } : {}),
        ...(callbacks.onCameraChanged ? { onCameraChanged: callbacks.onCameraChanged } : {}),
        ...(callbacks.onViewModeChanged ? { onViewModeChanged: callbacks.onViewModeChanged } : {}),
        ...(callbacks.onCursorCoordinate
          ? { onCursorCoordinate: callbacks.onCursorCoordinate }
          : {}),
        onInteractionChanged: (interacting) => {
          this.navigationInteracting = interacting;
          callbacks.onInteractionChanged?.(interacting);
          requestFrame();
        },
        requestFrame,
      },
    );
    const viewMode = this.scene.currentViewMode();
    if (viewMode !== '3d') void this.navigationState.setViewMode(viewMode, 0);
    return this.navigationState;
  }

  detachNavigation(preserveViewerState = false): void {
    this.assertAlive();
    this.navigationState?.dispose(preserveViewerState);
    this.navigationState = null;
    this.navigationInteracting = false;
  }

  resize(width: number, height: number, devicePixelRatio = 1): KernelCanvasExtent {
    this.assertReady();
    const extent = this.viewerState.resize(width, height, devicePixelRatio);
    if (this.navigationState === null) this.camera.setViewportSize(extent.width, extent.height);
    else this.navigationState.setViewportSize(extent.width, extent.height);
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
    this.currentStreamingCamera = replayWorldCamera(camera);
    this.options.requestFrame?.();
  }

  /**
   * Atomically adopts an external camera into both interactive navigation and
   * render/streaming state. The controller derives aspect from this viewport.
   */
  adoptWorldCamera(
    camera: KernelWorldCamera,
    floatingOrigin?: readonly [number, number, number],
  ): KernelWorldCamera {
    this.assertReady();
    if (this.navigationState) {
      return this.navigationState.adoptWorldCamera(camera, floatingOrigin);
    }
    const previous = this.camera.worldCamera();
    const adopted = this.camera.adoptWorldCamera(camera);
    try {
      this.setNavigationCamera(adopted, floatingOrigin ?? this.camera.recommendedFloatingOrigin());
    } catch (error) {
      this.camera.adoptWorldCamera(previous);
      throw error;
    }
    this.options.requestFrame?.();
    return adopted;
  }

  setClearColor(color: readonly [number, number, number, number]): void {
    this.assertReady();
    this.viewerState.setClearColor(color);
    this.options.requestFrame?.();
  }

  /** Changes point presentation without touching canonical state or tile residency. */
  setPointSize(pointSize: number): void {
    this.assertReady();
    this.viewerState.setPointSize(pointSize);
    this.options.requestFrame?.();
  }

  /** Rust-authoritative content hash used by product import adapters. */
  geometryObjectContentHash(geometry: GeometryObject): string {
    this.assertReady();
    return this.viewerState.geometryObjectContentHash(geometry);
  }

  /** Rust-authoritative entity-envelope hash used by product import adapters. */
  canonicalEntityVersionHash(entity: CanonicalEntity): string {
    this.assertReady();
    return this.viewerState.canonicalEntityVersionHash(entity);
  }

  loadPotree(
    input: KernelPotreeDatasetAdmission,
    options: KernelViewerLoadOptions = {},
  ): Promise<KernelViewerEntityHandle> {
    return this.loadProvider(input.admission.entity.id, input.datasetId, options, (control) =>
      this.scene.loadPotree(input, control),
    );
  }

  loadCanonical(
    admissions: readonly KernelCanonicalRenderAdmission[],
  ): readonly KernelViewerEntityHandle[] {
    this.assertReady();
    return this.scene.loadCanonical(admissions);
  }

  loadPreparedHierarchy(
    input: KernelPreparedHierarchyAdmission,
  ): readonly KernelViewerEntityHandle[] {
    this.assertReady();
    return this.scene.loadPreparedHierarchy(input);
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

  setEntityViewPolicy(entityId: string, policy: KernelEntityViewPolicy): void {
    this.assertReady();
    this.scene.setEntityViewPolicy(entityId, policy);
  }

  clearEntityViewPolicy(entityId: string): void {
    this.assertReady();
    this.scene.clearEntityViewPolicy(entityId);
  }

  /** Prewarms plan-only content before changing the shared camera/scene mode. */
  async setViewMode(mode: KernelViewMode, durationMilliseconds = 180): Promise<void> {
    this.assertReady();
    const requestGeneration = ++this.viewModeRequestGeneration;
    await this.scene.prepareViewMode(mode);
    this.assertReady();
    if (requestGeneration !== this.viewModeRequestGeneration) return;
    let transitionSettled: Promise<void> | null = null;
    if (this.navigationState) {
      transitionSettled = this.navigationState.setViewMode(mode, durationMilliseconds);
    } else {
      const transition = this.camera.setLockedTopDown(mode !== '3d');
      if (transition) {
        this.viewerState.setWorldCamera(transition.to, this.camera.recommendedFloatingOrigin());
        this.currentStreamingCamera = replayWorldCamera(transition.to);
      }
    }
    this.scene.commitViewMode(mode);
    this.options.requestFrame?.();
    await transitionSettled;
    this.assertReady();
    if (requestGeneration !== this.viewModeRequestGeneration) return;
  }

  registerGlyphAtlas(
    objectHash: string,
    metadata: KernelGlyphAtlasMetadata,
    rgba8: Uint8Array,
  ): void {
    this.assertReady();
    this.viewerState.registerGlyphAtlas(objectHash, metadata, rgba8);
  }

  registerAnnotationStyle(objectHash: string, style: KernelAnnotationStyle): void {
    this.assertReady();
    this.viewerState.registerAnnotationStyle(objectHash, style);
  }

  registerBlockDefinition(definition: KernelBlockDefinition): void {
    this.assertReady();
    this.viewerState.registerBlockDefinition(definition);
  }

  registerBlockMemberStyle(resource: CanonicalResourceRef, style: KernelRenderStyle): void {
    this.assertReady();
    this.viewerState.registerBlockMemberStyle(resource, style);
  }

  registerBlockAttributeTable(objectHash: string, bytes: Uint8Array): void {
    this.assertReady();
    this.viewerState.registerBlockAttributeTable(objectHash, bytes);
  }

  registerImageResource(
    objectHash: string,
    width: number,
    height: number,
    rgba8: Uint8Array,
  ): void {
    this.assertReady();
    this.viewerState.registerImageResource(objectHash, width, height, rgba8);
  }

  registerDepthResource(
    objectHash: string,
    width: number,
    height: number,
    values: Float32Array,
  ): void {
    this.assertReady();
    this.viewerState.registerDepthResource(objectHash, width, height, values);
  }

  registerRasterBinaryResource(objectHash: string, bytes: Uint8Array): void {
    this.assertReady();
    this.viewerState.registerRasterBinaryResource(objectHash, bytes);
  }

  registerMeshResource(objectHash: string, mesh: Readonly<Record<string, unknown>>): void {
    this.assertReady();
    this.viewerState.registerMeshResource(objectHash, mesh);
  }

  registerCanonicalHatchPatternResource(resource: HatchPatternResource): void {
    this.assertReady();
    this.viewerState.registerCanonicalHatchPatternResource(resource);
  }

  registerCanonicalTextureResource(
    resource: TextureResource,
    width: number,
    height: number,
    rgba8: Uint8Array,
  ): void {
    this.assertReady();
    this.viewerState.registerCanonicalTextureResource(resource, width, height, rgba8);
  }

  registerCanonicalMaterialResourceSet(resources: KernelCanonicalMaterialResourceSet): void {
    this.assertReady();
    this.viewerState.registerCanonicalMaterialResourceSet(resources);
  }

  registerCanonicalLineTypeResource(resource: LineTypeResource): void {
    this.assertReady();
    this.viewerState.registerCanonicalLineTypeResource(resource);
  }

  registerSectionProduct(objectHash: string, product: KernelAuthoritativeSectionProduct): void {
    this.assertReady();
    this.viewerState.registerSectionProduct(objectHash, product);
  }

  measureRasterDepthSample(
    entityId: string,
    column: number,
    row: number,
  ): KernelRasterDepthMeasurement {
    this.assertReady();
    return this.viewerState.measureRasterDepthSample(entityId, column, row);
  }

  measureRasterDepthDistance(
    picks: readonly KernelRasterDepthPick[],
  ): KernelRasterDepthDistanceMeasurement {
    this.assertReady();
    return this.viewerState.measureRasterDepthDistance(picks);
  }

  setRasterAnalysisView(entityId: string): KernelRasterAnalysisView {
    this.assertReady();
    const view = this.viewerState.setRasterAnalysisView(entityId);
    this.options.requestFrame?.();
    return view;
  }

  clearRasterAnalysisView(): boolean {
    this.assertReady();
    const cleared = this.viewerState.clearRasterAnalysisView();
    if (cleared) this.options.requestFrame?.();
    return cleared;
  }

  upsertSection(request: KernelSectionRequest): KernelSectionMutation {
    this.assertReady();
    const mutation = this.viewerState.upsertSection(request);
    this.options.requestFrame?.();
    return mutation;
  }

  removeSection(sectionId: string): boolean {
    this.assertReady();
    const removed = this.viewerState.removeSection(sectionId);
    if (removed) this.options.requestFrame?.();
    return removed;
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

  /** Projects an effect already committed by the canonical document authority. */
  applyCommittedCanonicalEffect(
    effect: CanonicalEntityEffect,
    expectedBindings: readonly GeometryRepresentationBindingRef[] = this.viewerState.canonicalEntityBindings(
      effect.entityId,
    ),
  ): KernelCommittedEntityEffectMutation {
    this.assertReady();
    const mutation = this.viewerState.applyCommittedCanonicalEffect(effect, expectedBindings);
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
    return this.performPick(x, y, radius);
  }

  /** Captures renderer pixels without resizing or sampling the session canvas. */
  captureRgba(request: KernelRgbaCaptureRequest): Promise<KernelRgbaCaptureResult> {
    this.assertReady();
    const pending = this.viewerState.captureRgba(request);
    // Downlevel WebGPU mapping callbacks may need a subsequent ordinary device poll.
    this.options.requestFrame?.();
    return pending;
  }

  /** Waits for current pick mappings without blocking viewer mutation or presentation. */
  async readbacksSettled(): Promise<void> {
    this.assertAlive();
    if (this.pendingPickMappings === 0) return;
    await new Promise<void>((resolve) => this.pickMappingWaiters.add(resolve));
  }

  /**
   * Resolves after the next kernel surface present succeeds. This does not
   * claim browser-compositor display or pixel-readback completion.
   */
  waitForNextPresentedFrame(
    options: KernelPresentedFrameOptions = {},
  ): Promise<KernelPresentedFrameOutcome> {
    this.assertAlive();
    options.signal?.throwIfAborted();
    return new Promise<KernelPresentedFrameOutcome>((resolve, reject) => {
      const signal = options.signal ?? null;
      const waiter: KernelPresentedFrameWaiter = { resolve, reject, signal, onAbort: null };
      const onAbort = (): void => {
        this.presentedFrameWaiters.delete(waiter);
        reject(abortReason(signal));
      };
      if (signal) waiter.onAbort = onAbort;
      this.presentedFrameWaiters.add(waiter);
      if (signal) {
        signal.addEventListener('abort', onAbort, { once: true });
        if (signal.aborted) onAbort();
      }
      this.options.requestFrame?.();
    });
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
      const interactionActive = interacting || this.navigationInteracting;
      const work = kernelStreamingWorkPolicy(this.policyState, interactionActive);
      const prefetchCamera = interactionActive
        ? predictedPrefetchCamera(this.previousStreamingCamera, this.currentStreamingCamera)
        : null;
      this.previousStreamingCamera = this.currentStreamingCamera;
      const plan = this.viewerState.planStreamingFrame({
        resourceBudget: this.policyState.resources,
        frameBudget: work.frame,
        // Camera motion may reduce *new* I/O/decode/upload work, but it must
        // never select a coarser render frontier. Otherwise resident ADD tiles
        // disappear on pointer-down and reappear on settle as visible flicker.
        detailScale: this.policyState.maximumDetailScale,
        // Two physical pixels is the neutral mesh/raster baseline. Potree uses
        // its own point-diameter coverage target inside the kernel, so point
        // quality no longer forces every other provider to over-refine.
        maximumScreenSpaceError: 2,
        maximumTraversedNodes: work.maximumTraversedNodes,
        ...(prefetchCamera === null ? {} : { prefetchCamera }),
      });
      const uploadedBytes = this.streamingState.execute(plan);
      const outcome = this.viewerState.render();
      if (outcome.status === 'presented') this.resolvePresentedFrameWaiters(outcome);
      this.emit({ type: 'frame', outcome });
      if (outcome.status === 'recreateSurface') this.viewerState.recoverSurface();
      if (outcome.status === 'recreateDevice') {
        this.recoveryReason = outcome.reason;
        this.startDeviceRecovery();
        return outcome;
      }
      const observation = this.viewerState.observeFrameTelemetry({
        cpuMs: performance.now() - started,
        interacting: interactionActive,
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
      if (
        this.pendingPickMappings > 0 ||
        plan.actions.some(
          (action) => action.kind !== 'fetchTile' && action.kind !== 'fetchHierarchyPage',
        ) ||
        (!interactionActive &&
          observation.adjustment !== 'reduced' &&
          (this.qualityState.renderScale + 1e-4 < this.policyState.maximumRenderScale ||
            this.qualityState.detailScale + 1e-4 < this.policyState.maximumDetailScale)) ||
        outcome.status === 'recreateSurface'
      ) {
        this.options.requestFrame?.();
      }
      return outcome;
    } catch (error) {
      const typed = this.reportError('frameFailed', error);
      throw typed;
    }
  }

  async settled(): Promise<void> {
    this.assertAlive();
    await this.readbacksSettled();
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
    this.navigationState?.dispose(true);
    this.navigationState = null;
    this.navigationInteracting = false;
    this.disposed = true;
    this.recoveryAbort?.abort();
    this.viewerState.detachClipCapCoordinator();
    this.streamingState.dispose();
    this.viewerState.dispose();
    for (const resolve of this.pickMappingWaiters) resolve();
    this.pickMappingWaiters.clear();
    const disposedError = new KernelViewerSessionError('disposed', 'viewer session is disposed');
    for (const waiter of this.presentedFrameWaiters) {
      this.removePresentedFrameAbortListener(waiter);
      waiter.reject(disposedError);
    }
    this.presentedFrameWaiters.clear();
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
    this.navigationState?.setEnabled(false);
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
      this.navigationState?.setEnabled(true);
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
      const aborted = options.signal?.aborted === true || isAbort(cause);
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

  private resolvePresentedFrameWaiters(outcome: KernelPresentedFrameOutcome): void {
    if (this.presentedFrameWaiters.size === 0) return;
    const waiters = [...this.presentedFrameWaiters];
    this.presentedFrameWaiters.clear();
    for (const waiter of waiters) {
      this.removePresentedFrameAbortListener(waiter);
      waiter.resolve(outcome);
    }
  }

  private removePresentedFrameAbortListener(waiter: KernelPresentedFrameWaiter): void {
    if (waiter.signal && waiter.onAbort) {
      waiter.signal.removeEventListener('abort', waiter.onAbort);
    }
  }

  private assertAlive(): void {
    if (this.disposed) throw new KernelViewerSessionError('disposed', 'viewer session is disposed');
  }

  private async performPick(x: number, y: number, radius: number): Promise<KernelPickResult> {
    this.pendingPickMappings += 1;
    try {
      const result = this.viewerState.pick(x, y, radius);
      // WebGL2 advances mapped-buffer callbacks from device polls. Keep the
      // ordinary frame loop alive until the mapping settles; unlike the former
      // monolithic WASM borrow, every one of these frames remains presentable.
      this.options.requestFrame?.();
      return await result;
    } finally {
      this.pendingPickMappings = Math.max(0, this.pendingPickMappings - 1);
      if (this.pendingPickMappings === 0) {
        for (const resolve of this.pickMappingWaiters) resolve();
        this.pickMappingWaiters.clear();
      }
      if (!this.disposed) this.options.requestFrame?.();
    }
  }

  private setNavigationCamera(
    camera: KernelWorldCamera,
    origin: readonly [number, number, number],
  ): void {
    this.viewerState.setWorldCamera(camera, origin);
    this.currentStreamingCamera = replayWorldCamera(camera);
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

function predictedPrefetchCamera(
  previous: KernelWorldCamera | null,
  current: KernelWorldCamera | null,
): KernelWorldCamera | null {
  if (previous === null || current?.projection.kind !== previous.projection.kind) {
    return null;
  }
  const eyeDelta = {
    x: current.eye.x - previous.eye.x,
    y: current.eye.y - previous.eye.y,
    z: current.eye.z - previous.eye.z,
  };
  const targetDelta = {
    x: current.target.x - previous.target.x,
    y: current.target.y - previous.target.y,
    z: current.target.z - previous.target.z,
  };
  const eyeSpeed = Math.hypot(eyeDelta.x, eyeDelta.y, eyeDelta.z);
  const targetSpeed = Math.hypot(targetDelta.x, targetDelta.y, targetDelta.z);
  const speed = Math.max(eyeSpeed, targetSpeed);
  const viewDistance = Math.max(
    1e-6,
    Math.hypot(
      current.eye.x - current.target.x,
      current.eye.y - current.target.y,
      current.eye.z - current.target.z,
    ),
  );
  if (!Number.isFinite(speed) || speed < viewDistance * 0.0005) return null;
  const horizon = Math.min(3, (viewDistance * 0.35) / speed);
  return {
    ...replayWorldCamera(current),
    eye: {
      x: current.eye.x + eyeDelta.x * horizon,
      y: current.eye.y + eyeDelta.y * horizon,
      z: current.eye.z + eyeDelta.z * horizon,
    },
    target: {
      x: current.target.x + targetDelta.x * horizon,
      y: current.target.y + targetDelta.y * horizon,
      z: current.target.z + targetDelta.z * horizon,
    },
  };
}

function replayWorldCamera(camera: KernelWorldCamera): KernelWorldCamera {
  return {
    eye: { ...camera.eye },
    target: { ...camera.target },
    up: { ...camera.up },
    projection: { ...camera.projection },
  };
}

function isAbort(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError';
}

function abortReason(signal: AbortSignal | null): Error {
  return signal?.reason instanceof Error
    ? signal.reason
    : new DOMException('Aborted', 'AbortError');
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
