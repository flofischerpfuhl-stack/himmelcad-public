import type { Camera, Ray, Vector2 } from 'three';

import type { SnapResult, SnapTargetMask } from '@himmelcad/data';

import type { NeighborhoodHit } from '../picking/PickingPass.js';
import type { PickResult } from '../picking/PickResult.js';

/**
 * A snap provider is registered per layer kind. The SnappingService queries
 * all providers and picks the best result.
 */
export interface SnapProvider {
  readonly id: string;
  query(input: SnapQueryInput): readonly SnapResult[];
}

/**
 * Cursor intent. Lets providers tune the trade-off between exact and stable
 * results (e.g. orbit pivot prefers a stable surface estimate; click prefers
 * the exact picked vertex).
 */
export type SnapIntent = 'hover' | 'pivot' | 'pick' | 'draw';

export interface SnapQueryInput {
  pointerNdc: Vector2;
  pointerClient: Vector2;
  viewportRect: DOMRectReadOnly;
  pixelTolerance: number;
  interpolationPixelRadius: number;
  camera: Camera;
  ray: Ray;
  sceneRenderOffset: [number, number, number];
  previous: SnapResult | null;
  /**
   * Central snap-toggle state. Providers can use it to skip expensive
   * candidates early, while SnappingService still filters every result as a
   * final safety net before ranking.
   */
  targetMask: SnapTargetMask;
  /**
   * Latest GPU-pick neighbourhood, if available. Providers MAY use this to
   * skip per-pixel scans and address geometry by primitive id directly.
   * Null when the pick pass is offline or the cursor is over the background.
   */
  pick: PickResult | null;
  /**
   * On-demand readback of all distinct primitives within a window around
   * the cursor. Populated only when the user explicitly asks for snap
   * hierarchy (e.g. Space-key cycling). Providers should add additional
   * candidates for hits that belong to them.
   */
  pickNeighborhood: readonly NeighborhoodHit[] | null;
  /** Intent classification; defaults to 'hover'. */
  intent: SnapIntent;
}
