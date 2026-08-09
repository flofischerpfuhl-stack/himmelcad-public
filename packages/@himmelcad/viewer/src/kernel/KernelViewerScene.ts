import {
  admitCanonicalPotreeDataset,
  type KernelPotreeDatasetAdmission,
} from './KernelPotreeDatasetAdmission.js';
import {
  admitCanonicalPreparedMeshDataset,
  type KernelPreparedMeshDatasetAdmission,
  type KernelPreparedMeshDatasetResult,
} from './KernelPreparedMeshDatasetAdmission.js';
import {
  admitCanonicalPreparedTinDataset,
  type KernelPreparedTinDatasetAdmission,
  type KernelPreparedTinDatasetResult,
} from './KernelPreparedTinDatasetAdmission.js';
import type { KernelStreamingDriver } from './KernelStreamingDriver.js';
import { loadOperationOptions, type KernelLoadControl } from './KernelLoadOperation.js';
import type {
  KernelCanonicalRenderAdmission,
  KernelCanonicalRetirementMutation,
  KernelPreparedTopologyRegistration,
  WgpuKernelViewer,
} from './WgpuKernelViewer.js';
import { isPlanViewMode, type KernelViewMode } from './KernelNavigationController.js';

export type KernelEntityViewAvailability = 'allModes' | 'planOnly';

/** Presentation admission kept separate from the canonical entity envelope. */
export interface KernelEntityViewPolicy {
  readonly availability: KernelEntityViewAvailability;
  /** Unknown height remains null even when 2.5D retains Source Z. */
  readonly sourceHeight?: 'known' | 'unknown';
  /** Resolves only when the entity can be revealed without a blank frame. */
  readonly prewarm?: () => void | Promise<void>;
}

/** Generic prepared hierarchy admission used by raster and splat providers. */
export interface KernelPreparedHierarchyAdmission {
  readonly datasetId: string;
  readonly formatId: string;
  readonly manifestUri: string;
  readonly manifestBytes: Uint8Array;
  readonly admissions: readonly KernelCanonicalRenderAdmission[];
  readonly topology?: readonly KernelPreparedTopologyRegistration[];
  /** View admission applied before the hierarchy's first renderable frame. */
  readonly viewPolicies?: Readonly<Record<string, KernelEntityViewPolicy>>;
}

type KernelSceneReplayEntry =
  | {
      readonly kind: 'canonical';
      readonly admissions: readonly KernelCanonicalRenderAdmission[];
    }
  | { readonly kind: 'potree'; readonly input: KernelPotreeDatasetAdmission }
  | { readonly kind: 'preparedMesh'; readonly input: KernelPreparedMeshDatasetAdmission }
  | { readonly kind: 'preparedTin'; readonly input: KernelPreparedTinDatasetAdmission }
  | { readonly kind: 'preparedHierarchy'; readonly input: KernelPreparedHierarchyAdmission };

/** Stable product-facing handle for one canonical entity in the shared viewer. */
export class KernelViewerEntityHandle {
  private loadedState = true;
  private visibleState = true;

  constructor(
    private readonly scene: KernelViewerScene,
    readonly entityId: string,
    readonly datasetId: string | null,
  ) {}

  get loaded(): boolean {
    return this.loadedState;
  }

  get visible(): boolean {
    return this.visibleState;
  }

  setVisible(visible: boolean): void {
    this.assertLoaded();
    this.scene.setEntityVisibility(this.entityId, visible);
    this.visibleState = visible;
  }

  unload(): KernelCanonicalRetirementMutation {
    this.assertLoaded();
    const mutation = this.scene.unloadEntity(this.entityId);
    this.loadedState = false;
    this.visibleState = false;
    return mutation;
  }

  private assertLoaded(): void {
    if (!this.loadedState) throw new Error(`entity ${this.entityId} is already unloaded`);
  }
}

/**
 * Stable load/unload/visibility facade shared by Builder, PhotoLab and WeltView.
 * Provider preparation stays outside; every admitted result enters the same
 * canonical registry, scheduler and render world.
 */
export class KernelViewerScene {
  private viewerState: WgpuKernelViewer;
  private streamingState: KernelStreamingDriver;
  private replayEntries: KernelSceneReplayEntry[] = [];
  private readonly visibility = new Map<string, boolean>();
  private readonly viewPolicies = new Map<string, KernelEntityViewPolicy>();
  private readonly inferredViewPolicies = new Set<string>();
  private readonly planPrewarmed = new Set<string>();
  private readonly planPrewarmPromises = new Map<string, Promise<void>>();
  private viewMode: KernelViewMode = '3d';
  private recovering = false;

  constructor(
    viewer: WgpuKernelViewer,
    streaming: KernelStreamingDriver,
    private readonly requestFrame: () => void = () => undefined,
  ) {
    this.viewerState = viewer;
    this.streamingState = streaming;
  }

  loadCanonical(
    admissions: readonly KernelCanonicalRenderAdmission[],
  ): readonly KernelViewerEntityHandle[] {
    this.assertMutable();
    this.viewerState.publishCanonicalRepresentations(admissions);
    this.applyInferredViewPolicies(admissions);
    this.replaceReplayEntities(entityIdsForAdmissions(admissions), {
      kind: 'canonical',
      admissions: replaySnapshot(admissions),
    });
    const handles = handlesForAdmissions(this, admissions);
    this.requestFrame();
    return handles;
  }

  async loadPotree(
    input: KernelPotreeDatasetAdmission,
    control?: KernelLoadControl,
  ): Promise<KernelViewerEntityHandle> {
    this.assertMutable();
    const options = loadOperationOptions(control);
    await admitCanonicalPotreeDataset(
      this.viewerState,
      this.streamingState,
      input,
      options.signal,
      options.onProgress,
    );
    this.applyInferredViewPolicies([{ admission: input.admission }]);
    this.replaceReplayEntities([input.admission.entity.id], {
      kind: 'potree',
      input: replaySnapshot(input),
    });
    const handle = new KernelViewerEntityHandle(this, input.admission.entity.id, input.datasetId);
    this.requestFrame();
    return handle;
  }

  async loadPreparedMesh(
    input: KernelPreparedMeshDatasetAdmission,
    control?: KernelLoadControl,
  ): Promise<KernelPreparedMeshDatasetResult & { readonly handle: KernelViewerEntityHandle }> {
    this.assertMutable();
    const options = loadOperationOptions(control);
    const result = await admitCanonicalPreparedMeshDataset(
      this.viewerState,
      this.streamingState,
      input,
      options.signal,
      options.onProgress,
    );
    this.applyInferredViewPolicies([{ admission: input.admission }]);
    this.replaceReplayEntities([input.admission.entity.id], {
      kind: 'preparedMesh',
      input: replaySnapshot(input),
    });
    const handle = new KernelViewerEntityHandle(this, input.admission.entity.id, input.datasetId);
    this.requestFrame();
    return { ...result, handle };
  }

  async loadPreparedTin(
    input: KernelPreparedTinDatasetAdmission,
    control?: KernelLoadControl,
  ): Promise<KernelPreparedTinDatasetResult & { readonly handle: KernelViewerEntityHandle }> {
    this.assertMutable();
    const options = loadOperationOptions(control);
    const result = await admitCanonicalPreparedTinDataset(
      this.viewerState,
      this.streamingState,
      input,
      options.signal,
      options.onProgress,
    );
    this.applyInferredViewPolicies([{ admission: input.admission }]);
    this.replaceReplayEntities([input.admission.entity.id], {
      kind: 'preparedTin',
      input: replaySnapshot(input),
    });
    const handle = new KernelViewerEntityHandle(this, input.admission.entity.id, input.datasetId);
    this.requestFrame();
    return { ...result, handle };
  }

  loadPreparedHierarchy(
    input: KernelPreparedHierarchyAdmission,
  ): readonly KernelViewerEntityHandle[] {
    this.assertMutable();
    assertDeclaredViewPolicies(input.admissions, input.viewPolicies);
    this.viewerState.registerPreparedDatasetAndPublishCanonicalRepresentations(
      input.datasetId,
      input.formatId,
      input.manifestUri,
      input.manifestBytes,
      input.admissions,
      input.topology,
    );
    this.applyDeclaredViewPolicies(input.viewPolicies);
    this.applyInferredViewPolicies(input.admissions);
    this.replaceReplayEntities(entityIdsForAdmissions(input.admissions), {
      kind: 'preparedHierarchy',
      input: replaySnapshot(input),
    });
    const handles = handlesForAdmissions(this, input.admissions, input.datasetId);
    this.requestFrame();
    return handles;
  }

  setEntityVisibility(entityId: string, visible: boolean): void {
    this.assertMutable();
    this.visibility.set(entityId, visible);
    this.viewerState.setEntityVisibility(entityId, this.effectiveVisibility(entityId));
    this.requestFrame();
  }

  /** Registers plan-only admission without changing canonical geometry truth. */
  setEntityViewPolicy(entityId: string, policy: KernelEntityViewPolicy): void {
    this.assertMutable();
    this.inferredViewPolicies.delete(entityId);
    this.viewPolicies.set(entityId, policy);
    this.planPrewarmed.delete(entityId);
    this.planPrewarmPromises.delete(entityId);
    this.viewerState.setEntityVisibility(entityId, this.effectiveVisibility(entityId));
    this.requestFrame();
  }

  clearEntityViewPolicy(entityId: string): void {
    this.assertMutable();
    this.viewPolicies.delete(entityId);
    this.inferredViewPolicies.delete(entityId);
    this.planPrewarmed.delete(entityId);
    this.planPrewarmPromises.delete(entityId);
    this.viewerState.setEntityVisibility(entityId, this.effectiveVisibility(entityId));
    this.requestFrame();
  }

  currentViewMode(): KernelViewMode {
    return this.viewMode;
  }

  entityHasKnownSourceHeight(entityId: string): boolean {
    return this.viewPolicies.get(entityId)?.sourceHeight !== 'unknown';
  }

  /** Prepares every hidden plan-only entity exactly once before reveal. */
  async prepareViewMode(mode: KernelViewMode): Promise<void> {
    this.assertMutable();
    if (!isPlanViewMode(mode)) return;
    const pending: Promise<void>[] = [];
    for (const [entityId, policy] of this.viewPolicies) {
      if (
        policy.availability !== 'planOnly' ||
        this.planPrewarmed.has(entityId) ||
        policy.prewarm === undefined
      ) {
        continue;
      }
      const inFlight = this.planPrewarmPromises.get(entityId);
      if (inFlight) {
        pending.push(inFlight);
        continue;
      }
      const prewarm = Promise.resolve(policy.prewarm())
        .then(() => {
          if (this.viewPolicies.get(entityId) === policy) this.planPrewarmed.add(entityId);
        })
        .finally(() => {
          if (this.planPrewarmPromises.get(entityId) === prewarm) {
            this.planPrewarmPromises.delete(entityId);
          }
        });
      this.planPrewarmPromises.set(entityId, prewarm);
      pending.push(prewarm);
    }
    await Promise.all(pending);
  }

  /** Atomically applies view-dependent visibility after preparation. */
  commitViewMode(mode: KernelViewMode): void {
    this.assertMutable();
    if (mode === this.viewMode) return;
    const sceneAvailabilityChanged = isPlanViewMode(mode) !== isPlanViewMode(this.viewMode);
    this.viewMode = mode;
    if (!sceneAvailabilityChanged) return;
    const entityIds = new Set([...this.visibility.keys(), ...this.viewPolicies.keys()]);
    for (const entityId of entityIds) {
      this.viewerState.setEntityVisibility(entityId, this.effectiveVisibility(entityId));
    }
    this.requestFrame();
  }

  unloadEntity(entityId: string): KernelCanonicalRetirementMutation {
    this.assertMutable();
    const mutation = this.viewerState.detachCanonicalEntities(
      this.viewerState.canonicalEntityBindings(entityId),
    );
    for (const datasetId of mutation.retiredDatasetIds)
      this.streamingState.detachDataset(datasetId);
    this.removeReplayEntities(new Set([entityId]));
    this.visibility.delete(entityId);
    this.viewPolicies.delete(entityId);
    this.inferredViewPolicies.delete(entityId);
    this.planPrewarmed.delete(entityId);
    this.planPrewarmPromises.delete(entityId);
    this.requestFrame();
    return mutation;
  }

  /**
   * Replays immutable dataset definitions onto a replacement device. Streamed
   * tile bytes are deliberately re-fetched by the new global driver instead of
   * being duplicated in this archive.
   */
  async recover(
    viewer: WgpuKernelViewer,
    streaming: KernelStreamingDriver,
    options: {
      readonly signal?: AbortSignal;
      readonly restoreViewState?: () => void;
    } = {},
  ): Promise<void> {
    this.assertMutable();
    this.recovering = true;
    const entries = replaySnapshot(this.replayEntries);
    try {
      for (const entry of entries) {
        options.signal?.throwIfAborted();
        switch (entry.kind) {
          case 'canonical':
            viewer.publishCanonicalRepresentations(entry.admissions);
            break;
          case 'potree':
            await admitCanonicalPotreeDataset(viewer, streaming, entry.input, options.signal);
            break;
          case 'preparedMesh':
            await admitCanonicalPreparedMeshDataset(viewer, streaming, entry.input, options.signal);
            break;
          case 'preparedTin':
            await admitCanonicalPreparedTinDataset(viewer, streaming, entry.input, options.signal);
            break;
          case 'preparedHierarchy':
            viewer.registerPreparedDatasetAndPublishCanonicalRepresentations(
              entry.input.datasetId,
              entry.input.formatId,
              entry.input.manifestUri,
              entry.input.manifestBytes,
              entry.input.admissions,
              entry.input.topology,
            );
            break;
        }
      }
      const visibleEntities = new Set([...this.visibility.keys(), ...this.viewPolicies.keys()]);
      for (const entityId of visibleEntities) {
        const visible = this.effectiveVisibility(entityId);
        if (!visible) viewer.setEntityVisibility(entityId, false);
      }
      options.restoreViewState?.();
      options.signal?.throwIfAborted();
      this.viewerState = viewer;
      this.streamingState = streaming;
      this.requestFrame();
    } finally {
      this.recovering = false;
    }
  }

  private replaceReplayEntities(
    entityIds: ReadonlySet<string> | readonly string[],
    entry: KernelSceneReplayEntry,
  ): void {
    const ids = entityIds instanceof Set ? entityIds : new Set(entityIds);
    this.removeReplayEntities(ids);
    this.replayEntries.push(entry);
  }

  private removeReplayEntities(entityIds: ReadonlySet<string>): void {
    const retained: KernelSceneReplayEntry[] = [];
    for (const entry of this.replayEntries) {
      if (
        entry.kind === 'potree' ||
        entry.kind === 'preparedMesh' ||
        entry.kind === 'preparedTin'
      ) {
        if (!entityIds.has(entry.input.admission.entity.id)) retained.push(entry);
        continue;
      }
      if (entry.kind === 'canonical') {
        const admissions = entry.admissions.filter(
          (item) => !entityIds.has(item.admission.entity.id),
        );
        if (admissions.length !== 0) retained.push({ ...entry, admissions });
        continue;
      }
      const admissions = entry.input.admissions.filter(
        (item) => !entityIds.has(item.admission.entity.id),
      );
      if (admissions.length !== 0) {
        retained.push({ ...entry, input: { ...entry.input, admissions } });
      }
    }
    this.replayEntries = retained;
  }

  private assertMutable(): void {
    if (this.recovering) throw new Error('viewer scene is recovering its GPU device');
  }

  /**
   * A canonical Position with `z: null` is authored plan geometry, not a point
   * on an arbitrary visible surface. Keep that source fact separate from the
   * renderer's locked-plan presentation elevation.
   */
  private applyInferredViewPolicies(admissions: readonly KernelCanonicalRenderAdmission[]): void {
    const unknownHeightByEntity = new Map<string, boolean>();
    for (const item of admissions) {
      const entityId = item.admission.entity.id;
      unknownHeightByEntity.set(
        entityId,
        (unknownHeightByEntity.get(entityId) ?? false) ||
          canonicalGeometryHasUnknownSourceHeight(item.admission.resolvedGeometry),
      );
    }

    for (const [entityId, unknownHeight] of unknownHeightByEntity) {
      let visibilityMayHaveChanged = false;
      if (unknownHeight) {
        if (!this.viewPolicies.has(entityId) || this.inferredViewPolicies.has(entityId)) {
          this.viewPolicies.set(entityId, {
            availability: 'planOnly',
            sourceHeight: 'unknown',
          });
          this.inferredViewPolicies.add(entityId);
          visibilityMayHaveChanged = true;
        }
      } else if (this.inferredViewPolicies.delete(entityId)) {
        this.viewPolicies.delete(entityId);
        visibilityMayHaveChanged = true;
      }

      if (visibilityMayHaveChanged) {
        this.viewerState.setEntityVisibility(entityId, this.effectiveVisibility(entityId));
      }
    }
  }

  private applyDeclaredViewPolicies(
    policies: Readonly<Record<string, KernelEntityViewPolicy>> | undefined,
  ): void {
    if (!policies) return;
    for (const [entityId, policy] of Object.entries(policies)) {
      this.viewPolicies.set(entityId, policy);
      this.inferredViewPolicies.delete(entityId);
      this.planPrewarmed.delete(entityId);
      this.planPrewarmPromises.delete(entityId);
      this.viewerState.setEntityVisibility(entityId, this.effectiveVisibility(entityId));
    }
  }

  private effectiveVisibility(entityId: string): boolean {
    const requested = this.visibility.get(entityId) ?? true;
    const policy = this.viewPolicies.get(entityId);
    return requested && (policy?.availability !== 'planOnly' || isPlanViewMode(this.viewMode));
  }
}

function handlesForAdmissions(
  scene: KernelViewerScene,
  admissions: readonly KernelCanonicalRenderAdmission[],
  defaultDatasetId: string | null = null,
): readonly KernelViewerEntityHandle[] {
  const entities = new Map<string, string | null>();
  for (const item of admissions) {
    entities.set(item.admission.entity.id, item.datasetId ?? defaultDatasetId);
  }
  return [...entities].map(
    ([entityId, datasetId]) => new KernelViewerEntityHandle(scene, entityId, datasetId),
  );
}

function entityIdsForAdmissions(
  admissions: readonly KernelCanonicalRenderAdmission[],
): Set<string> {
  return new Set(admissions.map((item) => item.admission.entity.id));
}

function assertDeclaredViewPolicies(
  admissions: readonly KernelCanonicalRenderAdmission[],
  policies: Readonly<Record<string, KernelEntityViewPolicy>> | undefined,
): void {
  if (!policies) return;
  const admittedEntities = entityIdsForAdmissions(admissions);
  for (const entityId of Object.keys(policies)) {
    if (!admittedEntities.has(entityId)) {
      throw new Error(`view policy references entity ${entityId} outside its hierarchy admission`);
    }
  }
}

function replaySnapshot<T>(value: T): T {
  return structuredClone(value);
}

/** Only canonical Position uses nullable Z; Vector3 and presentation frames do not. */
function canonicalGeometryHasUnknownSourceHeight(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(canonicalGeometryHasUnknownSourceHeight);
  if (value === null || typeof value !== 'object') return false;
  const record = value as Readonly<Record<string, unknown>>;
  if (
    Object.prototype.hasOwnProperty.call(record, 'x') &&
    Object.prototype.hasOwnProperty.call(record, 'y') &&
    Object.prototype.hasOwnProperty.call(record, 'z') &&
    typeof record.x === 'number' &&
    typeof record.y === 'number' &&
    record.z === null
  ) {
    return true;
  }
  return Object.values(record).some(canonicalGeometryHasUnknownSourceHeight);
}
