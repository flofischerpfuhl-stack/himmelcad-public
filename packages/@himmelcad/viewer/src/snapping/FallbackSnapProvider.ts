import { Plane, Vector3 } from 'three';

import type { SnapResult } from '@himmelcad/data';

import type { SnapProvider, SnapQueryInput } from './SnapProvider.js';

const UP = new Vector3(0, 0, 1);
const PLANE = new Plane(UP, 0);
const HIT = new Vector3();

/**
 * Lowest-priority coordinate provider.
 *
 * It keeps cursor coordinates usable even in empty space or point-cloud gaps.
 * If the previous stable cursor was on a surface above/below Z=0, we keep
 * projecting onto that height plane first; that feels much better for future
 * orbit/zoom pivots than snapping back to the global ground plane.
 */
export class FallbackSnapProvider implements SnapProvider {
  readonly id = 'fallback:stable-plane';

  query(input: SnapQueryInput): readonly SnapResult[] {
    const previous = input.previous;
    const planeZ = previous?.stable ? previous.position.z - input.sceneRenderOffset[2] : 0;
    PLANE.set(UP, -planeZ);
    const hit = input.ray.intersectPlane(PLANE, HIT);
    if (!hit) return [];
    const worldX = hit.x + input.sceneRenderOffset[0];
    const worldY = hit.y + input.sceneRenderOffset[1];
    const worldZ = hit.z + input.sceneRenderOffset[2];
    const stable = previous?.stable === true;
    return [
      {
        position: { x: worldX, y: worldY, z: worldZ },
        localPosition: { x: hit.x, y: hit.y, z: hit.z },
        kind: stable ? 'EstimatedSurface' : 'Grid',
        entity: null,
        confidence: stable ? 0.22 : 0.12,
        source: stable ? 'fallback' : 'grid',
        target: {
          datasetKind: stable ? 'fallback' : 'grid',
          entityId: null,
          primitive: stable
            ? { kind: 'estimated-surface', supportKind: 'fallback' }
            : { kind: 'grid' },
          exact: false,
        },
        distancePx: input.interpolationPixelRadius + 1,
        stable,
        candidateId: stable ? `fallback:stable-z:${planeZ.toFixed(3)}` : 'fallback:grid-z0',
      },
    ];
  }
}
