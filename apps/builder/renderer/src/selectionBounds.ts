import type { MeasurementAnchorV1 } from '@himmelcad/data/canonical';

export interface SelectionBounds {
  readonly min: readonly [number, number, number];
  readonly max: readonly [number, number, number];
}

export interface CanonicalSelectionBoundsResult {
  readonly bounds: SelectionBounds | null;
  readonly hasUnknownHeight: boolean;
}

interface CanonicalCurveBoundsSource {
  readonly entityId: string;
  readonly vertices: readonly {
    readonly x: number;
    readonly y: number;
    readonly z: number | null;
  }[];
}

interface CanonicalMeasurementBoundsSource {
  readonly entityId: string;
  readonly measurement: { readonly anchors: readonly MeasurementAnchorV1[] };
}

/**
 * Derives exact project-coordinate bounds for canonical geometry that does not
 * own a resident dataset. Point clouds deliberately stay on the renderer's
 * resident-bounds path.
 */
export function canonicalSelectionBounds(
  entityIds: ReadonlySet<string>,
  curves: readonly CanonicalCurveBoundsSource[],
  measurements: readonly CanonicalMeasurementBoundsSource[],
): CanonicalSelectionBoundsResult {
  const points: { readonly x: number; readonly y: number; readonly z: number | null }[] = [];
  for (const curve of curves) {
    if (entityIds.has(curve.entityId)) points.push(...curve.vertices);
  }
  for (const item of measurements) {
    if (!entityIds.has(item.entityId)) continue;
    for (const anchor of item.measurement.anchors) {
      if (anchor.binding === 'fixed') {
        points.push(anchor.position);
      } else {
        points.push({
          x: anchor.exactSourcePosition.x + anchor.offset.x,
          y: anchor.exactSourcePosition.y + anchor.offset.y,
          z:
            anchor.exactSourcePosition.z === null
              ? null
              : anchor.exactSourcePosition.z + anchor.offset.z,
        });
      }
    }
  }
  if (points.some((point) => point.z === null)) {
    return { bounds: null, hasUnknownHeight: true };
  }
  const finite = points.filter(
    (point): point is { readonly x: number; readonly y: number; readonly z: number } =>
      Number.isFinite(point.x) && Number.isFinite(point.y) && Number.isFinite(point.z),
  );
  if (finite.length === 0) return { bounds: null, hasUnknownHeight: false };
  const minimum = [finite[0]!.x, finite[0]!.y, finite[0]!.z];
  const maximum = [...minimum];
  for (const point of finite.slice(1)) {
    minimum[0] = Math.min(minimum[0]!, point.x);
    minimum[1] = Math.min(minimum[1]!, point.y);
    minimum[2] = Math.min(minimum[2]!, point.z);
    maximum[0] = Math.max(maximum[0]!, point.x);
    maximum[1] = Math.max(maximum[1]!, point.y);
    maximum[2] = Math.max(maximum[2]!, point.z);
  }
  return {
    bounds: {
      min: minimum as [number, number, number],
      max: maximum as [number, number, number],
    },
    hasUnknownHeight: false,
  };
}
