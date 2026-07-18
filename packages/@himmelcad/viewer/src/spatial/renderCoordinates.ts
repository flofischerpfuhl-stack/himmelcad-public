/**
 * PhotoLab world/render coordinate contract.
 *
 * World tuples are always `[Easting, Northing, Height]`. WebGL receives only
 * render-local coordinates: `local = world - renderOrigin`. Keeping this
 * conversion in one place prevents an accidental mixture of reconstruction-
 * local and projected-world coordinates from destroying float precision.
 */
export type Coordinate3 = readonly [number, number, number];

/** A single PhotoLab scene wider than 1,000 km is almost certainly malformed. */
export const MAX_RENDER_LOCAL_COMPONENT_METERS = 500_000;

export function isFiniteCoordinate3(value: Coordinate3): boolean {
  return value.every(Number.isFinite);
}

export function toRenderLocal(
  world: Coordinate3,
  renderOrigin: Coordinate3,
): [number, number, number] | null {
  if (!isFiniteCoordinate3(world) || !isFiniteCoordinate3(renderOrigin)) return null;
  const local: [number, number, number] = [
    world[0] - renderOrigin[0],
    world[1] - renderOrigin[1],
    world[2] - renderOrigin[2],
  ];
  return isPlausibleRenderLocal(local) ? local : null;
}

export function isPlausibleRenderLocal(local: Coordinate3): boolean {
  return (
    isFiniteCoordinate3(local) &&
    local.every((component) => Math.abs(component) <= MAX_RENDER_LOCAL_COMPONENT_METERS)
  );
}
