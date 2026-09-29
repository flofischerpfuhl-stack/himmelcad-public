/**
 * Rigid motions (rotation, mirror, translation) applied consistently to
 * OCCT shapes and to the naming layer's face descriptors, so a moved,
 * rotated or mirrored body keeps its face keys (see `../naming.ts`).
 * Pure TypeScript (no OCCT, safe for the UI bundle); `occRigid.ts` applies the same ops to shapes.
 */
import type { Vec3 } from '../../model/document.js';
import { cylinderId, type FaceGeom, type SurfaceId } from '../naming.js';

export type RigidOp =
  | { kind: 'rotate'; point: Vec3; axis: Vec3; angle: number /* radians */ }
  | { kind: 'mirror'; point: Vec3; normal: Vec3 }
  | { kind: 'translate'; vector: Vec3 };

/** Affine map `x -> m * x + t`, `m` row-major 3x3. */
export interface Affine {
  m: number[];
  t: Vec3;
}

export const IDENTITY: Affine = { m: [1, 0, 0, 0, 1, 0, 0, 0, 1], t: [0, 0, 0] };

export function opAffine(op: RigidOp): Affine {
  if (op.kind === 'translate') return { m: [...IDENTITY.m], t: [...op.vector] };
  if (op.kind === 'mirror') {
    const n = normalize(op.normal);
    const m = [0, 1, 2].flatMap((i) => [0, 1, 2].map((j) => (i === j ? 1 : 0) - 2 * n[i]! * n[j]!));
    return withFixedPoint(m, op.point);
  }
  const [x, y, z] = normalize(op.axis);
  const c = Math.cos(op.angle);
  const s = Math.sin(op.angle);
  const k = 1 - c;
  const m = [
    c + x * x * k,
    x * y * k - z * s,
    x * z * k + y * s,
    y * x * k + z * s,
    c + y * y * k,
    y * z * k - x * s,
    z * x * k - y * s,
    z * y * k + x * s,
    c + z * z * k,
  ];
  return withFixedPoint(m, op.point);
}

/** `x -> m (x - p) + p`. */
function withFixedPoint(m: number[], p: Vec3): Affine {
  const mp = mulMat(m, p);
  return { m, t: [p[0] - mp[0], p[1] - mp[1], p[2] - mp[2]] };
}

/** `a` after `b`. */
export function compose(a: Affine, b: Affine): Affine {
  const m: number[] = [];
  for (let i = 0; i < 3; i += 1) {
    for (let j = 0; j < 3; j += 1) {
      let sum = 0;
      for (let k = 0; k < 3; k += 1) sum += a.m[i * 3 + k]! * b.m[k * 3 + j]!;
      m.push(sum);
    }
  }
  const t = add(mulMat(a.m, b.t), a.t);
  return { m, t };
}

/** The affine map of `ops` applied in order. */
export function opsAffine(ops: readonly RigidOp[]): Affine {
  return ops.reduce<Affine>((acc, op) => compose(opAffine(op), acc), IDENTITY);
}

export function applyPoint(a: Affine, p: Vec3): Vec3 {
  return add(mulMat(a.m, p), a.t);
}

export function applyDir(a: Affine, d: Vec3): Vec3 {
  return normalize(mulMat(a.m, d));
}

/** The same face descriptor after the rigid motion `a` (rotation/reflection + translation). */
export function transformGeom<T extends FaceGeom>(face: T, a: Affine): T {
  let id: SurfaceId;
  if (face.id.type === 'plane') {
    const normal = applyDir(a, face.id.normal);
    const onPlane = applyPoint(a, scale(face.id.normal, face.id.offset));
    id = { type: 'plane', normal, offset: dot(normal, onPlane) };
  } else if (face.id.type === 'cylinder') {
    id = cylinderId(
      applyDir(a, face.id.axis),
      applyPoint(a, face.id.point),
      face.id.radius,
      face.id.convex,
    );
  } else {
    id = { ...face.id, centroid: applyPoint(a, face.id.centroid) };
  }
  return {
    ...face,
    id,
    centroid: applyPoint(a, face.centroid),
    normal: face.normal ? applyDir(a, face.normal) : null,
  };
}

/** Ops of a Move/Rotate transform: rotate about X, Y, Z (degrees) through `pivot`, then translate. */
export function transformOps(feature: {
  dx: number;
  dy: number;
  dz: number;
  rx: number;
  ry: number;
  rz: number;
  pivot: Vec3;
}): RigidOp[] {
  const ops: RigidOp[] = [];
  const axes: [number, Vec3][] = [
    [feature.rx, [1, 0, 0]],
    [feature.ry, [0, 1, 0]],
    [feature.rz, [0, 0, 1]],
  ];
  for (const [degrees, axis] of axes) {
    if (degrees !== 0) {
      ops.push({ kind: 'rotate', point: feature.pivot, axis, angle: (degrees * Math.PI) / 180 });
    }
  }
  if (feature.dx !== 0 || feature.dy !== 0 || feature.dz !== 0) {
    ops.push({ kind: 'translate', vector: [feature.dx, feature.dy, feature.dz] });
  }
  return ops;
}

// ---- vector helpers -------------------------------------------------------------

export function dot(a: Vec3, b: Vec3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

export function add(a: Vec3, b: Vec3): Vec3 {
  return [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
}

export function sub(a: Vec3, b: Vec3): Vec3 {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}

export function scale(a: Vec3, k: number): Vec3 {
  return [a[0] * k, a[1] * k, a[2] * k];
}

export function cross(a: Vec3, b: Vec3): Vec3 {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}

export function length(a: Vec3): number {
  return Math.hypot(a[0], a[1], a[2]);
}

export function normalize(v: Vec3): Vec3 {
  const len = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / len, v[1] / len, v[2] / len];
}

function mulMat(m: number[], v: Vec3): Vec3 {
  return [
    m[0]! * v[0] + m[1]! * v[1] + m[2]! * v[2],
    m[3]! * v[0] + m[4]! * v[1] + m[5]! * v[2],
    m[6]! * v[0] + m[7]! * v[1] + m[8]! * v[2],
  ];
}
