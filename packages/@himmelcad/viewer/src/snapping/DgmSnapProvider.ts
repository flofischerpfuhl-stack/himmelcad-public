import type { SnapResult } from '@himmelcad/data';

import type { SnapProvider, SnapQueryInput } from './SnapProvider.js';

/**
 * Digital terrain model cursor provider — STUB.
 *
 * Implementation gated by:
 *   - `DgmLayer` carrying regular grid tiles (`himmelcad-spatial::grid_dgm`).
 *   - DGM importer that writes the grid header + heights blob.
 *
 * Once those land:
 *   - `query()` intersects the cursor ray with the DGM grid (analytic
 *     bilinear or grid-marching), returning a `Face` candidate with the
 *     interpolated height.
 *   - Cheap O(1) per intersection; no GPU pick needed for DGMs because the
 *     surface is fully described by the grid.
 *
 * Returns no candidates today — the pipeline is unchanged.
 */
export class DgmSnapProvider implements SnapProvider {
  readonly id: string;

  constructor(layerId: string) {
    this.id = `${layerId}:dgm-snap`;
  }

  query(_input: SnapQueryInput): readonly SnapResult[] {
    return [];
  }
}
