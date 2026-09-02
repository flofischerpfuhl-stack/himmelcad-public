import type { ProductOperation } from './productConfiguration.js';

export type ProductPrerequisiteArtifact = 'depth' | 'depthReuse' | 'dense' | 'dem';

export interface ProductPrerequisiteStatus {
  hasPublishedAlignment: boolean;
  mergedFrameGeoreferenced: boolean;
  availableArtifacts: ReadonlySet<ProductPrerequisiteArtifact>;
  externalDemBound: boolean;
  meshSourceKinds: readonly Extract<ProductPrerequisiteArtifact, 'dem' | 'dense'>[];
}

export interface ProductPrerequisiteDecision {
  met: boolean;
  reason?: string;
  actionLabel?: string;
  actionFunctionId?: string;
}

export interface ProductPrerequisiteOptions {
  externalDemBound: boolean;
  meshSourceKinds: readonly Extract<ProductPrerequisiteArtifact, 'dem' | 'dense'>[];
}

/**
 * Artifact alternatives for each prerequisite gate. Every returned group must
 * have at least one available artifact. Alignment is a shared prerequisite for
 * every product and is intentionally represented separately by callers.
 */
export function productPrerequisiteArtifactGroups(
  kind: ProductOperation,
  options: ProductPrerequisiteOptions,
): readonly (readonly ProductPrerequisiteArtifact[])[] {
  if (kind === 'depth' || kind === 'splat') return [];
  if (kind === 'dense') return [['depth', 'depthReuse']];
  if (kind === 'dem') return [['dense']];
  if (kind === 'ortho') {
    return options.externalDemBound ? [['dense']] : [['dense'], ['dem']];
  }
  return [options.meshSourceKinds];
}

export function evaluateProductPrerequisites(
  kind: ProductOperation,
  status: ProductPrerequisiteStatus,
): ProductPrerequisiteDecision {
  if (!status.hasPublishedAlignment) {
    return missing(
      'Products need a published sparse alignment.',
      'Run an alignment first',
      'alignment.run',
    );
  }
  if ((kind === 'dem' || kind === 'ortho') && !status.mergedFrameGeoreferenced) {
    return missing(
      'Overlap merges solve in an arbitrary frame. Run GCP optimization on the merged result before building georeferenced products.',
      'Optimize merged alignment',
      'alignment.optimize',
    );
  }
  const prerequisiteGroups = productPrerequisiteArtifactGroups(kind, status);
  if (prerequisiteGroups.length === 0) return { met: true };
  if (kind === 'dense') {
    if (hasAny(status, prerequisiteGroups[0] ?? [])) return { met: true };
    return missing(
      'Dense point clouds need compatible depth maps.',
      'Build depth maps first',
      'products.depth',
    );
  }
  if (kind === 'dem') {
    if (hasAny(status, prerequisiteGroups[0] ?? [])) return { met: true };
    return missing(
      'DEMs need a dense point cloud from this alignment lineage.',
      'Build a dense point cloud first',
      'products.dense',
    );
  }
  if (kind === 'ortho') {
    if (!hasAny(status, prerequisiteGroups[0] ?? [])) {
      return missing(
        'Orthomosaics need a dense point cloud from this alignment lineage.',
        'Build a dense point cloud first',
        'products.dense',
      );
    }
    if (prerequisiteGroups.slice(1).every((group) => hasAny(status, group))) return { met: true };
    return missing(
      'Orthomosaics need a DEM unless an external DEM is bound.',
      'Build a DEM first',
      'products.dem',
    );
  }
  if (hasAny(status, prerequisiteGroups[0] ?? [])) return { met: true };
  const denseAllowed = status.meshSourceKinds.includes('dense');
  return missing(
    denseAllowed
      ? 'Meshes need a DEM or dense point cloud from this alignment lineage.'
      : 'Meshes need a DEM from this alignment lineage.',
    denseAllowed ? 'Build a mesh source first' : 'Build a DEM first',
    denseAllowed ? 'products.dense' : 'products.dem',
  );
}

function hasAny(
  status: ProductPrerequisiteStatus,
  kinds: readonly ProductPrerequisiteArtifact[],
): boolean {
  return kinds.some((kind) => status.availableArtifacts.has(kind));
}

function missing(
  reason: string,
  actionLabel: string,
  actionFunctionId: string,
): ProductPrerequisiteDecision {
  return { met: false, reason, actionLabel, actionFunctionId };
}
