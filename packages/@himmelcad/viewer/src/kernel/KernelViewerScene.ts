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

/** Generic prepared hierarchy admission used by raster and splat providers. */
export interface KernelPreparedHierarchyAdmission {
  readonly datasetId: string;
  readonly formatId: string;
  readonly manifestUri: string;
  readonly manifestBytes: Uint8Array;
  readonly admissions: readonly KernelCanonicalRenderAdmission[];
  readonly topology?: readonly KernelPreparedTopologyRegistration[];
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
    this.viewerState.registerPreparedDatasetAndPublishCanonicalRepresentations(
      input.datasetId,
      input.formatId,
      input.manifestUri,
      input.manifestBytes,
      input.admissions,
      input.topology,
    );
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
    this.viewerState.setEntityVisibility(entityId, visible);
    this.visibility.set(entityId, visible);
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
      for (const [entityId, visible] of this.visibility) {
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

function replaySnapshot<T>(value: T): T {
  return structuredClone(value);
}
