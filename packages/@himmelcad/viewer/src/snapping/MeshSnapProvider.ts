import type { SnapResult } from '@himmelcad/data';

import type { SnapProvider, SnapQueryInput } from './SnapProvider.js';

/**
 * Triangle-mesh cursor provider — STUB.
 *
 * Implementation gated by:
 *   - `MeshLayer` (analogue of `PointCloudLayer`) carrying a per-tile BVH
 *     built in `himmelcad-spatial::bvh_triangles` (not yet ported).
 *   - Mesh tile format with persisted BVH alongside vertex/index buffers.
 *   - Pick material that emits a per-triangle id (`triangleId` attribute
 *     replicated to the three vertices of each triangle in the importer).
 *
 * Once those land, this provider consumes:
 *   - GPU pick (`input.pick.layerId === this.layer.id`) → exact triangle id
 *     → barycentric of the cursor ray vs. that triangle → exact surface
 *     point (`Face` kind), plus nearest-vertex (`Vertex`) and nearest-edge
 *     (`Edge`) candidates derived from the same triangle.
 *   - Octree/BVH ray-walk fallback for occluded geometry exposed via
 *     `input.pickNeighborhood` so Space cycling steps through stacked meshes.
 *
 * For now `query()` returns no results — the cursor pipeline silently
 * ignores absent providers, which keeps the existing point-cloud path
 * unaffected.
 */
export class MeshSnapProvider implements SnapProvider {
  readonly id: string;

  constructor(layerId: string) {
    this.id = `${layerId}:mesh-snap`;
  }

  query(_input: SnapQueryInput): readonly SnapResult[] {
    return [];
  }
}
