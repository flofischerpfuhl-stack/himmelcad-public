import type { SnapResult } from '@himmelcad/data';

import type { SnapProvider, SnapQueryInput } from './SnapProvider.js';

/**
 * Authored CAD geometry cursor provider — STUB (Phase E in the cursor plan).
 *
 * Implementation gated by the CAD entity model:
 *   - Lines, polylines, NURBS, IFC elements, axis/profile entities, etc.
 *   - Each entity stores its vertices, edges and faces explicitly so the
 *     provider can register them as direct snap candidates without ever
 *     touching the GPU pick (CAD geometry is small and authored).
 *
 * Once the CAD layer arrives, `query()` walks a per-scene CAD index
 * (kd-tree over vertex/edge endpoints) and returns:
 *   - `Vertex` for endpoint snaps,
 *   - `Edge` for nearest-on-edge,
 *   - `Face` for nearest-on-face,
 *   each with `worldPositionF64` so drawing tools have full precision.
 *
 * Returns no candidates today — the pipeline is unchanged.
 */
export class CadSnapProvider implements SnapProvider {
  readonly id: string;

  constructor(layerId: string) {
    this.id = `${layerId}:cad-snap`;
  }

  query(_input: SnapQueryInput): readonly SnapResult[] {
    return [];
  }
}
