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
  constructor(
    readonly viewer: WgpuKernelViewer,
    readonly streaming: KernelStreamingDriver,
    private readonly requestFrame: () => void = () => undefined,
  ) {}

  loadCanonical(
    admissions: readonly KernelCanonicalRenderAdmission[],
  ): readonly KernelViewerEntityHandle[] {
    this.viewer.publishCanonicalRepresentations(admissions);
    const handles = handlesForAdmissions(this, admissions);
    this.requestFrame();
    return handles;
  }

  async loadPotree(
    input: KernelPotreeDatasetAdmission,
    signal?: AbortSignal,
  ): Promise<KernelViewerEntityHandle> {
    await admitCanonicalPotreeDataset(this.viewer, this.streaming, input, signal);
    const handle = new KernelViewerEntityHandle(this, input.admission.entity.id, input.datasetId);
    this.requestFrame();
    return handle;
  }

  async loadPreparedMesh(
    input: KernelPreparedMeshDatasetAdmission,
    signal?: AbortSignal,
  ): Promise<KernelPreparedMeshDatasetResult & { readonly handle: KernelViewerEntityHandle }> {
    const result = await admitCanonicalPreparedMeshDataset(
      this.viewer,
      this.streaming,
      input,
      signal,
    );
    const handle = new KernelViewerEntityHandle(this, input.admission.entity.id, input.datasetId);
    this.requestFrame();
    return { ...result, handle };
  }

  async loadPreparedTin(
    input: KernelPreparedTinDatasetAdmission,
    signal?: AbortSignal,
  ): Promise<KernelPreparedTinDatasetResult & { readonly handle: KernelViewerEntityHandle }> {
    const result = await admitCanonicalPreparedTinDataset(
      this.viewer,
      this.streaming,
      input,
      signal,
    );
    const handle = new KernelViewerEntityHandle(this, input.admission.entity.id, input.datasetId);
    this.requestFrame();
    return { ...result, handle };
  }

  loadPreparedHierarchy(
    input: KernelPreparedHierarchyAdmission,
  ): readonly KernelViewerEntityHandle[] {
    this.viewer.registerPreparedDatasetAndPublishCanonicalRepresentations(
      input.datasetId,
      input.formatId,
      input.manifestUri,
      input.manifestBytes,
      input.admissions,
      input.topology,
    );
    const handles = handlesForAdmissions(this, input.admissions, input.datasetId);
    this.requestFrame();
    return handles;
  }

  setEntityVisibility(entityId: string, visible: boolean): void {
    this.viewer.setEntityVisibility(entityId, visible);
    this.requestFrame();
  }

  unloadEntity(entityId: string): KernelCanonicalRetirementMutation {
    const mutation = this.viewer.detachCanonicalEntities(
      this.viewer.canonicalEntityBindings(entityId),
    );
    for (const datasetId of mutation.retiredDatasetIds) this.streaming.detachDataset(datasetId);
    this.requestFrame();
    return mutation;
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
