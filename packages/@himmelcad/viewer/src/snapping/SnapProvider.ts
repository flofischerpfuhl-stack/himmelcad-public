import type { Camera, Vector2 } from 'three';

import type { SnapResult } from '@himmelcad/data';

/**
 * A snap provider is registered per layer kind. The SnappingService queries
 * all providers and picks the best result.
 */
export interface SnapProvider {
  readonly id: string;
  query(input: SnapQueryInput): SnapResult | null;
}

export interface SnapQueryInput {
  pointerNdc: Vector2;
  pixelTolerance: number;
  camera: Camera;
}
