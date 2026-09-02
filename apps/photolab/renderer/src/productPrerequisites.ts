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
  if (kind === 'depth' || kind === 'splat') return { met: true };
  if (kind === 'dense') {
    if (hasAny(status, ['depth', 'depthReuse'])) return { met: true };
    return missing(
      'Dense point clouds need compatible depth maps.',
      'Build depth maps first',
      'products.depth',
    );
  }
  if (kind === 'dem') {
    if (status.availableArtifacts.has('dense')) return { met: true };
    return missing(
      'DEMs need a dense point cloud from this alignment lineage.',
      'Build a dense point cloud first',
      'products.dense',
    );
  }
  if (kind === 'ortho') {
    if (!status.availableArtifacts.has('dense')) {
      return missing(
        'Orthomosaics need a dense point cloud from this alignment lineage.',
        'Build a dense point cloud first',
        'products.dense',
      );
    }
    if (status.externalDemBound || status.availableArtifacts.has('dem')) return { met: true };
    return missing(
      'Orthomosaics need a DEM unless an external DEM is bound.',
      'Build a DEM first',
      'products.dem',
    );
  }
  if (hasAny(status, status.meshSourceKinds)) return { met: true };
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
