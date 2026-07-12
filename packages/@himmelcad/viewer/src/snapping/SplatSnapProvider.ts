import type { SnapResult } from '@himmelcad/data';

import type { SnapProvider, SnapQueryInput } from './SnapProvider.js';

/**
 * Gaussian splat cursor provider — STUB (Phase E in the cursor plan).
 *
 * Implementation gated by:
 *   - `SplatLayer` carrying tiles with per-splat covariance.
 *   - `himmelcad-spatial::splat_tree` (octree variant tuned for splats).
 *   - Splat pick material that emits a per-splat id.
 *
 * Once those land, `query()` produces:
 *   - GPU-pick exact splat (`Point` kind, with the splat's mean position).
 *   - Surface estimate via splat covariance instead of a PCA plane fit (the
 *     covariance already encodes the local plane; we intersect that
 *     ellipsoid with the cursor ray).
 *
 * Today: no-op.
 */
export class SplatSnapProvider implements SnapProvider {
  readonly id: string;

  constructor(layerId: string) {
    this.id = `${layerId}:splat-snap`;
  }

  query(_input: SnapQueryInput): readonly SnapResult[] {
    return [];
  }
}
