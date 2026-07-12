import type { EntityId, GeometryDatasetKind, GeometryPrimitiveRef } from '@himmelcad/data';

/**
 * One coarse hit reported by the GPU pick pass. Used to identify the
 * topmost visible primitive at a screen position in constant time
 * regardless of total point/triangle count.
 *
 * The exact world position is reconstructed by the per-entity provider
 * (e.g. `PointCloudSnapProvider`) from `pointIndex` + the layer's positions
 * buffer. We deliberately avoid encoding depth in the pick texture; the
 * per-vertex authoritative position is always more accurate than a depth
 * round-trip and we already need the layer reference to dispatch
 * refinement to the right provider.
 */
export interface PickResult {
  entityId: EntityId;
  datasetKind: GeometryDatasetKind;
  primitive: GeometryPrimitiveRef;
  /** Index into the layer's positions/indices array. */
  pointIndex: number;
  /** Source layer id for cross-referencing. */
  layerId: string;
  /** Cursor pixel at which the readback was taken. */
  cursorClient: { x: number; y: number };
  /** Wall-clock timestamp of the readback. */
  timestampMs: number;
}

export interface PickReadbackInput {
  /** Cursor in client (window) pixels. */
  clientX: number;
  clientY: number;
}
