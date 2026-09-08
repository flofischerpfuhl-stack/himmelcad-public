import type { KernelWorldCamera, KernelWorldPoint } from './WgpuKernelViewer.js';

export type KernelFencePoint = readonly [number, number, number];

export type KernelFenceVolume =
  | {
      readonly kind: 'prism';
      readonly polygon: readonly KernelFencePoint[];
      readonly direction: KernelFencePoint;
    }
  | {
      readonly kind: 'frustum';
      readonly apex: KernelFencePoint;
      readonly polygon: readonly KernelFencePoint[];
    }
  | {
      readonly kind: 'box';
      readonly center: KernelFencePoint;
      readonly halfExtents: KernelFencePoint;
      /** Unit quaternion in x/y/z/w order. */
      readonly rotation: readonly [number, number, number, number];
    };

const EPSILON = 1e-9;

/** Creates the camera-free PC-D5 volume represented by a closed viewport fence. */
export function fenceVolumeFromCamera(
  camera: KernelWorldCamera,
  polygon: readonly KernelWorldPoint[],
): KernelFenceVolume {
  assertFencePolygon(polygon);
  const vertices = polygon.map(tuple);
  if (camera.projection.kind === 'perspective') {
    return Object.freeze({ kind: 'frustum', apex: tuple(camera.eye), polygon: vertices });
  }
  return Object.freeze({
    kind: 'prism',
    polygon: vertices,
    direction: tuple(normalize(subtract(camera.target, camera.eye))),
  });
}

/** Creates a camera-free orthographic prism from an explicitly typed world polygon. */
export function fencePrismFromPolygon(
  polygon: readonly KernelWorldPoint[],
): Extract<KernelFenceVolume, { kind: 'prism' }> {
  assertFencePolygon(polygon);
  const vertices = polygon.map(tuple);
  return Object.freeze({
    kind: 'prism',
    polygon: vertices,
    direction: polygonBasis(vertices).normal,
  });
}

/** World-unit area on the fence's view plane. */
export function fencePolygonArea(polygon: readonly KernelFencePoint[]): number {
  const basis = polygonBasis(polygon);
  let twiceArea = 0;
  for (let index = 0; index < polygon.length; index += 1) {
    const current = project2(polygon[index]!, basis);
    const next = project2(polygon[(index + 1) % polygon.length]!, basis);
    twiceArea += current[0] * next[1] - next[0] * current[1];
  }
  return Math.abs(twiceArea) * 0.5;
}

/** Exact shared membership predicate used by tint and apply verification. */
export function fenceVolumeContains(volume: KernelFenceVolume, point: KernelFencePoint): boolean {
  assertPoint(point, 'point');
  if (volume.kind === 'box') return boxContains(volume, point);
  const basis = polygonBasis(volume.polygon);
  if (volume.kind === 'prism') {
    const direction = normalizeTuple(volume.direction);
    const origin = volume.polygon[0]!;
    const denominator = dotTuple(direction, basis.normal);
    if (Math.abs(denominator) <= EPSILON) return false;
    const distance = dotTuple(subtractTuple(origin, point), basis.normal) / denominator;
    const projected: KernelFencePoint = [
      point[0] + direction[0] * distance,
      point[1] + direction[1] * distance,
      point[2] + direction[2] * distance,
    ];
    return polygonContains2(project2(projected, basis), volume.polygon, basis);
  }

  const ray = subtractTuple(point, volume.apex);
  const planeDistance = dotTuple(subtractTuple(volume.polygon[0]!, volume.apex), basis.normal);
  const denominator = dotTuple(ray, basis.normal);
  if (Math.abs(denominator) <= EPSILON || planeDistance * denominator <= 0) return false;
  const scale = planeDistance / denominator;
  if (scale < 0) return false;
  const projected: KernelFencePoint = [
    volume.apex[0] + ray[0] * scale,
    volume.apex[1] + ray[1] * scale,
    volume.apex[2] + ray[2] * scale,
  ];
  return polygonContains2(project2(projected, basis), volume.polygon, basis);
}

export function assertFenceVolume(volume: KernelFenceVolume): void {
  if (volume.kind === 'box') {
    assertPoint(volume.center, 'box center');
    assertPoint(volume.halfExtents, 'box half extents');
    if (volume.halfExtents.some((value) => value <= 0)) {
      throw new RangeError('fence box half extents must be positive');
    }
    if (
      volume.rotation.length !== 4 ||
      !volume.rotation.every(Number.isFinite) ||
      Math.abs(Math.hypot(...volume.rotation) - 1) > 1e-6
    ) {
      throw new TypeError('fence box rotation must be a unit quaternion');
    }
    return;
  }
  assertFencePolygon(volume.polygon.map(objectPoint));
  if (volume.kind === 'prism') {
    const direction = normalizeTuple(volume.direction);
    if (Math.abs(dotTuple(direction, polygonBasis(volume.polygon).normal)) <= EPSILON) {
      throw new RangeError('fence prism direction must cross the polygon plane');
    }
  } else assertPoint(volume.apex, 'frustum apex');
}

function boxContains(volume: Extract<KernelFenceVolume, { kind: 'box' }>, point: KernelFencePoint) {
  const [x, y, z, w] = volume.rotation;
  const relative = subtractTuple(point, volume.center);
  // Rotate by the quaternion conjugate into box-local coordinates.
  const tx = 2 * (-y * relative[2] + z * relative[1]);
  const ty = 2 * (-z * relative[0] + x * relative[2]);
  const tz = 2 * (-x * relative[1] + y * relative[0]);
  const local: KernelFencePoint = [
    relative[0] + w * tx + (-y * tz + z * ty),
    relative[1] + w * ty + (-z * tx + x * tz),
    relative[2] + w * tz + (-x * ty + y * tx),
  ];
  return local.every((value, index) => Math.abs(value) <= volume.halfExtents[index]! + EPSILON);
}

interface PolygonBasis {
  readonly origin: KernelFencePoint;
  readonly u: KernelFencePoint;
  readonly v: KernelFencePoint;
  readonly normal: KernelFencePoint;
}

function polygonBasis(polygon: readonly KernelFencePoint[]): PolygonBasis {
  if (polygon.length < 3) throw new RangeError('a fence polygon requires at least three vertices');
  polygon.forEach((point) => assertPoint(point, 'fence vertex'));
  const origin = polygon[0]!;
  let edge: KernelFencePoint | null = null;
  let normal: KernelFencePoint | null = null;
  for (let index = 1; index < polygon.length - 1 && !normal; index += 1) {
    const candidate = subtractTuple(polygon[index]!, origin);
    for (let next = index + 1; next < polygon.length; next += 1) {
      const cross = crossTuple(candidate, subtractTuple(polygon[next]!, origin));
      if (Math.hypot(...cross) > EPSILON) {
        edge = candidate;
        normal = normalizeTuple(cross);
        break;
      }
    }
  }
  if (!edge || !normal) throw new RangeError('fence polygon vertices are collinear');
  const u = normalizeTuple(edge);
  const v = crossTuple(normal, u);
  for (const point of polygon) {
    if (Math.abs(dotTuple(subtractTuple(point, origin), normal)) > 1e-6) {
      throw new RangeError('fence polygon vertices must be coplanar');
    }
  }
  return { origin, u, v, normal };
}

function polygonContains2(
  point: readonly [number, number],
  polygon: readonly KernelFencePoint[],
  basis: PolygonBasis,
): boolean {
  let inside = false;
  for (let index = 0, previous = polygon.length - 1; index < polygon.length; previous = index++) {
    const a = project2(polygon[index]!, basis);
    const b = project2(polygon[previous]!, basis);
    if (pointOnSegment2(point, a, b)) return true;
    if (
      a[1] > point[1] !== b[1] > point[1] &&
      point[0] < ((b[0] - a[0]) * (point[1] - a[1])) / (b[1] - a[1]) + a[0]
    ) {
      inside = !inside;
    }
  }
  return inside;
}

function pointOnSegment2(
  point: readonly [number, number],
  a: readonly [number, number],
  b: readonly [number, number],
): boolean {
  const cross = (point[0] - a[0]) * (b[1] - a[1]) - (point[1] - a[1]) * (b[0] - a[0]);
  if (Math.abs(cross) > EPSILON) return false;
  const dot = (point[0] - a[0]) * (b[0] - a[0]) + (point[1] - a[1]) * (b[1] - a[1]);
  const length = (b[0] - a[0]) ** 2 + (b[1] - a[1]) ** 2;
  return dot >= -EPSILON && dot <= length + EPSILON;
}

function project2(point: KernelFencePoint, basis: PolygonBasis): readonly [number, number] {
  const relative = subtractTuple(point, basis.origin);
  return [dotTuple(relative, basis.u), dotTuple(relative, basis.v)];
}

function assertFencePolygon(polygon: readonly KernelWorldPoint[]): void {
  polygonBasis(polygon.map(tuple));
}

function tuple(point: KernelWorldPoint): KernelFencePoint {
  const value = [point.x, point.y, point.z] as const;
  assertPoint(value, 'world point');
  return value;
}

function objectPoint(point: KernelFencePoint): KernelWorldPoint {
  return { x: point[0], y: point[1], z: point[2] };
}

function subtract(left: KernelWorldPoint, right: KernelWorldPoint): KernelWorldPoint {
  return { x: left.x - right.x, y: left.y - right.y, z: left.z - right.z };
}

function normalize(point: KernelWorldPoint): KernelWorldPoint {
  const length = Math.hypot(point.x, point.y, point.z);
  if (!Number.isFinite(length) || length <= EPSILON) throw new RangeError('zero-length vector');
  return { x: point.x / length, y: point.y / length, z: point.z / length };
}

function subtractTuple(left: KernelFencePoint, right: KernelFencePoint): KernelFencePoint {
  return [left[0] - right[0], left[1] - right[1], left[2] - right[2]];
}

function crossTuple(left: KernelFencePoint, right: KernelFencePoint): KernelFencePoint {
  return [
    left[1] * right[2] - left[2] * right[1],
    left[2] * right[0] - left[0] * right[2],
    left[0] * right[1] - left[1] * right[0],
  ];
}

function dotTuple(left: KernelFencePoint, right: KernelFencePoint): number {
  return left[0] * right[0] + left[1] * right[1] + left[2] * right[2];
}

function normalizeTuple(point: KernelFencePoint): KernelFencePoint {
  const length = Math.hypot(...point);
  if (!Number.isFinite(length) || length <= EPSILON) throw new RangeError('zero-length vector');
  return [point[0] / length, point[1] / length, point[2] / length];
}

function assertPoint(point: readonly number[], label: string): void {
  if (point.length !== 3 || !point.every(Number.isFinite)) {
    throw new TypeError(`${label} must contain three finite coordinates`);
  }
}
