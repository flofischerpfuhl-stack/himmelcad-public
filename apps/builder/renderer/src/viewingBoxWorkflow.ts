import type { KernelViewingBoxState } from '@himmelcad/viewer/kernel';

/** Keeps the shipped `viewing_box.*` SDK namespace on the canonical command rows. */
export function canonicalViewingBoxCommandId(method: string): string {
  return method.startsWith('viewing_box.')
    ? `view.box.${method.slice('viewing_box.'.length)}`
    : method;
}

export interface ViewingBoxPoint {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

export interface ViewingBoxExtents {
  readonly min: ViewingBoxPoint;
  readonly max: ViewingBoxPoint;
}

const MIN_HALF_EXTENT = 1e-6;

export function viewingBoxExtents(state: KernelViewingBoxState): ViewingBoxExtents {
  return {
    min: {
      x: state.center.x - state.halfExtents.x,
      y: state.center.y - state.halfExtents.y,
      z: state.center.z - state.halfExtents.z,
    },
    max: {
      x: state.center.x + state.halfExtents.x,
      y: state.center.y + state.halfExtents.y,
      z: state.center.z + state.halfExtents.z,
    },
  };
}

export function setViewingBoxExtent(
  state: KernelViewingBoxState,
  bound: 'min' | 'max',
  axis: keyof ViewingBoxPoint,
  value: number,
): KernelViewingBoxState {
  const extents = viewingBoxExtents(state);
  const opposite = bound === 'min' ? extents.max[axis] : extents.min[axis];
  const minimum = bound === 'min' ? Math.min(value, opposite - MIN_HALF_EXTENT * 2) : opposite;
  const maximum = bound === 'max' ? Math.max(value, opposite + MIN_HALF_EXTENT * 2) : opposite;
  return {
    ...state,
    center: { ...state.center, [axis]: (minimum + maximum) * 0.5 },
    halfExtents: {
      ...state.halfExtents,
      [axis]: Math.max(MIN_HALF_EXTENT, (maximum - minimum) * 0.5),
    },
  };
}

/** Builds an axis-aligned box on the camera target plane while retaining depth on edge-on axes. */
export function viewingBoxFromViewportDrag(
  seed: KernelViewingBoxState,
  start: ViewingBoxPoint,
  end: ViewingBoxPoint,
): KernelViewingBoxState {
  const threshold = Math.max(
    MIN_HALF_EXTENT * 2,
    Math.min(seed.halfExtents.x, seed.halfExtents.y, seed.halfExtents.z) * 1e-5,
  );
  const axis = (name: keyof ViewingBoxPoint): readonly [number, number] => {
    const delta = Math.abs(end[name] - start[name]);
    return delta > threshold
      ? [(start[name] + end[name]) * 0.5, Math.max(MIN_HALF_EXTENT, delta * 0.5)]
      : [seed.center[name], seed.halfExtents[name]];
  };
  const [centerX, extentX] = axis('x');
  const [centerY, extentY] = axis('y');
  const [centerZ, extentZ] = axis('z');
  return {
    ...seed,
    center: { x: centerX, y: centerY, z: centerZ },
    halfExtents: { x: extentX, y: extentY, z: extentZ },
    rotation: [0, 0, 0, 1],
  };
}
