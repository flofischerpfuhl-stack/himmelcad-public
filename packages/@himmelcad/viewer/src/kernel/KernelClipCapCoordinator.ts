import type { GeometryRepresentationBindingRef } from './generated/index.js';
import {
  evaluateCanonicalSectionTopologyWith,
  type KernelSectionTopologyPartitionLocation,
} from './KernelSectionTopologyEvaluation.js';
import type {
  KernelAuthoritativeSectionProduct,
  KernelClipVolume,
  KernelRenderStyle,
  KernelSectionMutation,
  KernelSectionRequest,
} from './WgpuKernelViewer.js';

export interface KernelClipCapSource {
  readonly entityId: string;
  readonly binding: GeometryRepresentationBindingRef;
  readonly sectionTopologyParts: readonly KernelSectionTopologyPartitionLocation[];
  readonly closedManifold: boolean;
  readonly tolerance: number;
  readonly style?: KernelRenderStyle;
}

export interface KernelClipCapUpdate {
  readonly volumes: readonly KernelClipVolume[];
  readonly sources: readonly KernelClipCapSource[];
}

interface ClipCapViewer {
  setClipVolumes(volumes: readonly KernelClipVolume[]): void;
  sectionTopologyPartitionContentHash: Parameters<
    typeof evaluateCanonicalSectionTopologyWith
  >[0]['sectionTopologyPartitionContentHash'];
  beginAuthoritativeSectionEvaluation: Parameters<
    typeof evaluateCanonicalSectionTopologyWith
  >[0]['beginAuthoritativeSectionEvaluation'];
  skipAuthoritativeSectionPartition: Parameters<
    typeof evaluateCanonicalSectionTopologyWith
  >[0]['skipAuthoritativeSectionPartition'];
  pushAuthoritativeSectionPartition: Parameters<
    typeof evaluateCanonicalSectionTopologyWith
  >[0]['pushAuthoritativeSectionPartition'];
  finishAuthoritativeSectionEvaluation: Parameters<
    typeof evaluateCanonicalSectionTopologyWith
  >[0]['finishAuthoritativeSectionEvaluation'];
  cancelAuthoritativeSectionEvaluation: Parameters<
    typeof evaluateCanonicalSectionTopologyWith
  >[0]['cancelAuthoritativeSectionEvaluation'];
  sectionProductContentHash(product: KernelAuthoritativeSectionProduct): string;
  registerSectionProduct(objectHash: string, product: KernelAuthoritativeSectionProduct): void;
  upsertSection(request: KernelSectionRequest): KernelSectionMutation;
  removeSection(sectionId: string): boolean;
}

export interface KernelClipCapFetcher {
  fetchImmutableResource(
    reference: {
      readonly uri: string;
      readonly byteOffset: number | null;
      readonly byteLength: number | null;
    },
    signal?: AbortSignal,
  ): Promise<Uint8Array>;
}

interface ClipCapJob {
  readonly version: number;
  readonly signature: string;
  readonly controller: AbortController;
  readonly completion: Promise<void>;
}

interface DesiredCap {
  readonly sectionId: string;
  readonly volume: KernelClipVolume;
  readonly planeIndex: number;
  readonly source: KernelClipCapSource;
  readonly plane: KernelAuthoritativeSectionProduct['plane'];
  readonly geometrySignature: string;
  readonly signature: string;
}

interface CommittedCap {
  readonly geometrySignature: string;
  readonly signature: string;
  readonly productHash: string;
}

/**
 * Owns exact caps for resource-backed closed meshes independently from render-tile residency.
 * GPU clipping is published synchronously; exact cap replacement follows asynchronously.
 */
export class KernelClipCapCoordinator {
  private readonly jobs = new Map<string, ClipCapJob>();
  private readonly committed = new Map<string, CommittedCap>();
  private version = 0;
  private disposed = false;

  constructor(
    private readonly viewer: ClipCapViewer,
    private readonly streaming: KernelClipCapFetcher,
  ) {}

  synchronize(update: KernelClipCapUpdate): Promise<void> {
    this.assertAlive();
    // Navigation sees the clip immediately; no topology or tile fetch is on this path.
    this.viewer.setClipVolumes(update.volumes);
    return this.synchronizePublished(update);
  }

  /** Synchronizes exact caps after the viewer already published the composed GPU clips. */
  synchronizePublished(update: KernelClipCapUpdate): Promise<void> {
    this.assertAlive();
    const desired = desiredCaps(update);
    const desiredIds = new Set(desired.keys());

    for (const [sectionId, job] of this.jobs) {
      if (desiredIds.has(sectionId)) continue;
      job.controller.abort();
      this.jobs.delete(sectionId);
    }
    for (const sectionId of this.committed.keys()) {
      if (desiredIds.has(sectionId)) continue;
      this.viewer.removeSection(sectionId);
      this.committed.delete(sectionId);
    }

    const completions: Promise<void>[] = [];
    for (const cap of desired.values()) {
      const current = this.jobs.get(cap.sectionId);
      if (current?.signature === cap.signature) {
        completions.push(current.completion);
        continue;
      }
      const committed = this.committed.get(cap.sectionId);
      if (current === undefined && committed?.signature === cap.signature) {
        continue;
      }
      if (current === undefined && committed?.geometrySignature === cap.geometrySignature) {
        this.commitCap(cap, committed.productHash);
        continue;
      }
      current?.controller.abort();
      const version = ++this.version;
      const controller = new AbortController();
      const completion = this.evaluateAndCommit(cap, version, controller).finally(() => {
        const latest = this.jobs.get(cap.sectionId);
        if (latest?.version === version) this.jobs.delete(cap.sectionId);
      });
      this.jobs.set(cap.sectionId, { version, signature: cap.signature, controller, completion });
      completions.push(completion);
    }
    return Promise.all(completions).then(() => undefined);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const job of this.jobs.values()) job.controller.abort();
    this.jobs.clear();
    for (const sectionId of this.committed.keys()) this.viewer.removeSection(sectionId);
    this.committed.clear();
  }

  /** Stable exact-section identities currently owned by this coordinator. */
  committedSectionIds(): readonly string[] {
    this.assertAlive();
    return [...this.committed.keys()].sort();
  }

  private async evaluateAndCommit(
    cap: DesiredCap,
    version: number,
    controller: AbortController,
  ): Promise<void> {
    try {
      const product = await evaluateCanonicalSectionTopologyWith(
        this.viewer,
        this.streaming,
        {
          operationId: `${cap.sectionId}@${version}`,
          binding: cap.source.binding,
          plane: cap.plane,
          tolerance: cap.source.tolerance,
          parts: cap.source.sectionTopologyParts,
        },
        controller.signal,
      );
      controller.signal.throwIfAborted();
      const current = this.jobs.get(cap.sectionId);
      if (current?.version !== version || current.signature !== cap.signature) return;
      if (
        !product.source.closedManifold ||
        product.source.entityId !== cap.source.entityId ||
        product.source.versionHash !== cap.source.binding.key.entityVersionHash
      ) {
        throw new Error('clip-cap section product does not match its closed canonical source');
      }
      const productHash = this.viewer.sectionProductContentHash(product);
      // No await is allowed between the last generation gate and atomic visual replacement.
      this.viewer.registerSectionProduct(productHash, product);
      this.commitCap(cap, productHash);
    } catch (error) {
      if (controller.signal.aborted || isAbortError(error)) return;
      throw error;
    }
  }

  private commitCap(cap: DesiredCap, productHash: string): void {
    this.viewer.upsertSection({
      sectionId: cap.sectionId,
      entityId: cap.source.entityId,
      productHash,
      plane: cap.plane,
      tolerance: cap.source.tolerance,
      ...(cap.source.style === undefined ? {} : { style: cap.source.style }),
      clipCap: { volumeId: cap.volume.id, planeIndex: cap.planeIndex },
    });
    this.committed.set(cap.sectionId, {
      geometrySignature: cap.geometrySignature,
      signature: cap.signature,
      productHash,
    });
  }

  private assertAlive(): void {
    if (this.disposed) throw new Error('clip-cap coordinator is disposed');
  }
}

function desiredCaps(update: KernelClipCapUpdate): Map<string, DesiredCap> {
  const desired = new Map<string, DesiredCap>();
  const volumeIds = new Set<string>();
  const sourceIds = new Set<string>();
  for (const source of update.sources) {
    validateSource(source);
    if (sourceIds.has(source.entityId)) {
      throw new TypeError(`duplicate clip-cap source entity: ${source.entityId}`);
    }
    sourceIds.add(source.entityId);
  }
  for (const volume of update.volumes) {
    if (volumeIds.has(volume.id)) throw new TypeError(`duplicate clip volume id: ${volume.id}`);
    volumeIds.add(volume.id);
    if (!volume.enabled || !volume.previewCap) continue;
    for (const source of update.sources) {
      if (!source.closedManifold) continue;
      for (let planeIndex = 0; planeIndex < volume.planes.length; planeIndex += 1) {
        const clipPlane = volume.planes[planeIndex];
        if (clipPlane === undefined) continue;
        const lengthSquared =
          clipPlane.normal.x ** 2 + clipPlane.normal.y ** 2 + clipPlane.normal.z ** 2;
        if (
          !Number.isFinite(clipPlane.distance) ||
          !Number.isFinite(lengthSquared) ||
          lengthSquared <= 0
        ) {
          throw new RangeError('clip-cap planes must be finite and have a non-zero normal');
        }
        const length = Math.sqrt(lengthSquared);
        const normal = {
          x: clipPlane.normal.x / length,
          y: clipPlane.normal.y / length,
          z: clipPlane.normal.z / length,
        };
        const scale = -clipPlane.distance / length;
        const plane = {
          origin: {
            x: normal.x * scale,
            y: normal.y * scale,
            z: normal.z * scale,
          },
          normal,
        };
        const sectionId = stableSectionId(source.entityId, volume.id, planeIndex);
        const geometrySignature = JSON.stringify({
          binding: source.binding,
          parts: source.sectionTopologyParts,
          plane,
          tolerance: source.tolerance,
        });
        const signature = JSON.stringify({
          geometrySignature,
          volumePlanes: volume.planes,
          operation: volume.operation,
          sectionFillResource: volume.sectionFillResource ?? null,
          sectionMaterialHatches: volume.sectionMaterialHatches ?? null,
          style: source.style ?? null,
        });
        desired.set(sectionId, {
          sectionId,
          volume,
          planeIndex,
          source,
          plane,
          geometrySignature,
          signature,
        });
      }
    }
  }
  return desired;
}

function validateSource(source: KernelClipCapSource): void {
  if (
    source.entityId.length === 0 ||
    source.binding.key.slot.entityId !== source.entityId ||
    !Number.isFinite(source.tolerance) ||
    source.tolerance <= 0 ||
    (source.closedManifold && source.sectionTopologyParts.length === 0)
  ) {
    throw new RangeError('clip-cap source identity, topology and tolerance must be valid');
  }
}

function stableSectionId(entityId: string, volumeId: string, planeIndex: number): string {
  return `clip-cap:${encodeURIComponent(entityId)}:${encodeURIComponent(volumeId)}:${planeIndex}`;
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError';
}
