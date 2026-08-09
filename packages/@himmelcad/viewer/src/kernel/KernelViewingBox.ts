import type { KernelClipVolume, KernelWorldPoint } from './WgpuKernelViewer.js';

const MINIMUM_EXTENT = 1e-6;
const MINIMUM_VIEW_SPAN = 1e-5;

export type KernelViewingBoxMode = 'resize' | 'move' | 'rotate';
export type KernelViewingBoxAxis = 'x' | 'y' | 'z';

/**
 * View-local, non-canonical clipping tool state. Rotation is expressed as a
 * unit quaternion in `[x, y, z, w]` order so repeated handle drags do not
 * accumulate Euler singularities.
 */
export interface KernelViewingBoxState {
  readonly id: string;
  readonly center: KernelWorldPoint;
  readonly halfExtents: KernelWorldPoint;
  readonly rotation: readonly [number, number, number, number];
  readonly mode: KernelViewingBoxMode;
  readonly enabled: boolean;
}

export interface KernelViewingBoxViewportSeed {
  readonly center: KernelWorldPoint;
  readonly visibleWidth: number;
  readonly visibleHeight: number;
  /** Visible depth around the navigation target; defaults to the smaller plan span. */
  readonly visibleDepth?: number;
  readonly id?: string;
}

/** Creates a box that occupies 60% of the current view, so its initial size tracks zoom. */
export function viewingBoxFromViewport(seed: KernelViewingBoxViewportSeed): KernelViewingBoxState {
  assertPoint(seed.center, 'viewing box center');
  assertPositive(seed.visibleWidth, 'visible width', MINIMUM_VIEW_SPAN);
  assertPositive(seed.visibleHeight, 'visible height', MINIMUM_VIEW_SPAN);
  const depth = seed.visibleDepth ?? Math.min(seed.visibleWidth, seed.visibleHeight);
  assertPositive(depth, 'visible depth', MINIMUM_VIEW_SPAN);
  const id = seed.id ?? 'builder:viewing-box';
  assertId(id);
  return {
    id,
    center: { ...seed.center },
    halfExtents: {
      x: seed.visibleWidth * 0.3,
      y: seed.visibleHeight * 0.3,
      z: depth * 0.3,
    },
    rotation: [0, 0, 0, 1],
    mode: 'move',
    enabled: true,
  };
}

export function setViewingBoxMode(
  state: KernelViewingBoxState,
  mode: KernelViewingBoxMode,
): KernelViewingBoxState {
  assertViewingBox(state);
  return { ...state, mode };
}

export function placeViewingBoxCenter(
  state: KernelViewingBoxState,
  center: KernelWorldPoint,
): KernelViewingBoxState {
  assertViewingBox(state);
  assertPoint(center, 'viewing box center');
  return { ...state, center: { ...center } };
}

export function moveViewingBox(
  state: KernelViewingBoxState,
  delta: KernelWorldPoint,
): KernelViewingBoxState {
  assertViewingBox(state);
  assertPoint(delta, 'viewing box translation');
  return {
    ...state,
    center: {
      x: state.center.x + delta.x,
      y: state.center.y + delta.y,
      z: state.center.z + delta.z,
    },
  };
}

/** Resizes one local half-axis. The opposite face remains fixed when `anchorOpposite` is true. */
export function resizeViewingBox(
  state: KernelViewingBoxState,
  axis: KernelViewingBoxAxis,
  signedDelta: number,
  anchorOpposite = true,
): KernelViewingBoxState {
  assertViewingBox(state);
  assertFinite(signedDelta, 'viewing box resize delta');
  const oldExtent = state.halfExtents[axis];
  const nextExtent = Math.max(MINIMUM_EXTENT, oldExtent + signedDelta * 0.5);
  const appliedFaceDelta = (nextExtent - oldExtent) * 2;
  const localShift = anchorOpposite ? appliedFaceDelta * 0.5 : 0;
  const axisVector = viewingBoxAxes(state)[axisIndex(axis)];
  return {
    ...state,
    center: {
      x: state.center.x + axisVector.x * localShift,
      y: state.center.y + axisVector.y * localShift,
      z: state.center.z + axisVector.z * localShift,
    },
    halfExtents: { ...state.halfExtents, [axis]: nextExtent },
  };
}

export function rotateViewingBox(
  state: KernelViewingBoxState,
  axis: KernelViewingBoxAxis,
  angleRadians: number,
): KernelViewingBoxState {
  assertViewingBox(state);
  assertFinite(angleRadians, 'viewing box rotation');
  const half = angleRadians * 0.5;
  const sine = Math.sin(half);
  const delta: readonly [number, number, number, number] =
    axis === 'x'
      ? [sine, 0, 0, Math.cos(half)]
      : axis === 'y'
        ? [0, sine, 0, Math.cos(half)]
        : [0, 0, sine, Math.cos(half)];
  return { ...state, rotation: normalizeQuaternion(multiplyQuaternions(state.rotation, delta)) };
}

/** Six inward planes consumed by the renderer's composable clip-scope API. */
export function viewingBoxClipVolume(state: KernelViewingBoxState): KernelClipVolume {
  assertViewingBox(state);
  const axes = viewingBoxAxes(state);
  const extents = [state.halfExtents.x, state.halfExtents.y, state.halfExtents.z] as const;
  const planes = axes.flatMap((axis, index) => {
    const extent = extents[index]!;
    const projection = dot(axis, state.center);
    return [
      { normal: axis, distance: -projection + extent },
      {
        normal: { x: -axis.x, y: -axis.y, z: -axis.z },
        distance: projection + extent,
      },
    ];
  });
  return {
    id: state.id,
    planes,
    operation: 'keepInside',
    previewCap: true,
    enabled: state.enabled,
  };
}

export function viewingBoxAxes(
  state: Pick<KernelViewingBoxState, 'rotation'>,
): readonly [KernelWorldPoint, KernelWorldPoint, KernelWorldPoint] {
  const [x, y, z, w] = normalizeQuaternion(state.rotation);
  return [
    {
      x: 1 - 2 * (y * y + z * z),
      y: 2 * (x * y + z * w),
      z: 2 * (x * z - y * w),
    },
    {
      x: 2 * (x * y - z * w),
      y: 1 - 2 * (x * x + z * z),
      z: 2 * (y * z + x * w),
    },
    {
      x: 2 * (x * z + y * w),
      y: 2 * (y * z - x * w),
      z: 1 - 2 * (x * x + y * y),
    },
  ];
}

export function assertViewingBox(state: KernelViewingBoxState): void {
  assertId(state.id);
  assertPoint(state.center, 'viewing box center');
  assertPositive(state.halfExtents.x, 'viewing box x extent', MINIMUM_EXTENT);
  assertPositive(state.halfExtents.y, 'viewing box y extent', MINIMUM_EXTENT);
  assertPositive(state.halfExtents.z, 'viewing box z extent', MINIMUM_EXTENT);
  normalizeQuaternion(state.rotation);
  if (!['resize', 'move', 'rotate'].includes(state.mode)) {
    throw new RangeError('viewing box mode is invalid');
  }
}

function axisIndex(axis: KernelViewingBoxAxis): 0 | 1 | 2 {
  return axis === 'x' ? 0 : axis === 'y' ? 1 : 2;
}

function multiplyQuaternions(
  left: readonly [number, number, number, number],
  right: readonly [number, number, number, number],
): readonly [number, number, number, number] {
  const [lx, ly, lz, lw] = left;
  const [rx, ry, rz, rw] = right;
  return [
    lw * rx + lx * rw + ly * rz - lz * ry,
    lw * ry - lx * rz + ly * rw + lz * rx,
    lw * rz + lx * ry - ly * rx + lz * rw,
    lw * rw - lx * rx - ly * ry - lz * rz,
  ];
}

function normalizeQuaternion(
  value: readonly [number, number, number, number],
): readonly [number, number, number, number] {
  if (value.length !== 4 || value.some((component) => !Number.isFinite(component))) {
    throw new RangeError('viewing box rotation must be a finite quaternion');
  }
  const length = Math.hypot(...value);
  if (length < 1e-12) throw new RangeError('viewing box rotation quaternion is degenerate');
  return [value[0] / length, value[1] / length, value[2] / length, value[3] / length];
}

function dot(left: KernelWorldPoint, right: KernelWorldPoint): number {
  return left.x * right.x + left.y * right.y + left.z * right.z;
}

function assertId(id: string): void {
  if (id.length === 0 || id.trim() !== id) {
    throw new RangeError('viewing box id must be non-empty and trimmed');
  }
}

function assertPoint(value: KernelWorldPoint, label: string): void {
  assertFinite(value.x, label);
  assertFinite(value.y, label);
  assertFinite(value.z, label);
}

function assertFinite(value: number, label: string): void {
  if (!Number.isFinite(value)) throw new RangeError(`${label} must be finite`);
}

function assertPositive(value: number, label: string, minimum: number): void {
  if (!Number.isFinite(value) || value < minimum) {
    throw new RangeError(`${label} must be finite and at least ${minimum}`);
  }
}
