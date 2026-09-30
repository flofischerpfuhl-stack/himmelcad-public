/**
 * Move/Rotate gizmo math (Shapr3D gizmo, interaction research §4): an
 * oriented gizmo (auto-orientation to the geometry its centre is dropped
 * on), rotations about its own axes, and the conversion to the stored
 * `transform` feature (world rx/ry/rz Euler angles about the pivot), so an
 * oriented move is still one ordinary, editable History step.
 */
import type { Body } from '../kernel/types.js';
import { opAffine, opsAffine, type RigidOp } from '../kernel/features/rigid.js';
import { frameForFace, type Vec3 } from './document.js';

export const WORLD_AXES: [Vec3, Vec3, Vec3] = [
  [1, 0, 0],
  [0, 1, 0],
  [0, 0, 1],
];

export interface GizmoState {
  delta: { dx: number; dy: number; dz: number };
  rotation: { rx: number; ry: number; rz: number };
  pivot: Vec3;
  axes?: [Vec3, Vec3, Vec3] | undefined;
}

export function isWorldAxes(axes: readonly Vec3[] | undefined): boolean {
  if (!axes) return true;
  return axes.every((a, i) => a.every((v, j) => Math.abs(v - WORLD_AXES[i]![j]!) < 1e-12));
}

/** Rigid ops of the gizmo: rotations about its axes through the pivot, then the translation. */
export function gizmoOps(state: GizmoState): RigidOp[] {
  const axes = state.axes ?? WORLD_AXES;
  const angles = [state.rotation.rx, state.rotation.ry, state.rotation.rz];
  const ops: RigidOp[] = [];
  angles.forEach((degrees, i) => {
    if (degrees !== 0) {
      ops.push({
        kind: 'rotate',
        point: state.pivot,
        axis: axes[i]!,
        angle: (degrees * Math.PI) / 180,
      });
    }
  });
  const { dx, dy, dz } = state.delta;
  if (dx !== 0 || dy !== 0 || dz !== 0) ops.push({ kind: 'translate', vector: [dx, dy, dz] });
  return ops;
}

/**
 * World Euler angles (degrees) of a rotation matrix `m` (row-major), for
 * the order the `transform` feature applies them: about X, then Y, then Z
 * (`R = Rz · Ry · Rx`).
 */
export function eulerXYZ(m: readonly number[]): { rx: number; ry: number; rz: number } {
  const deg = (r: number) => Math.round(((r * 180) / Math.PI) * 1e9) / 1e9;
  const sy = -m[6]!;
  if (Math.abs(sy) > 1 - 1e-12) {
    // Gimbal lock: ±90° about Y; X and Z turn about the same line — put it all on Z.
    const ry = Math.sign(sy) * (Math.PI / 2);
    const rz = Math.atan2(-m[1]!, m[4]!);
    return { rx: 0, ry: deg(ry), rz: deg(rz) };
  }
  return {
    rx: deg(Math.atan2(m[7]!, m[8]!)),
    ry: deg(Math.asin(Math.max(-1, Math.min(1, sy)))),
    rz: deg(Math.atan2(m[3]!, m[0]!)),
  };
}

/** The `transform` feature fields of a gizmo state (rotations about oriented axes → world Euler). */
export function gizmoTransformFields(state: GizmoState): {
  dx: number;
  dy: number;
  dz: number;
  rx: number;
  ry: number;
  rz: number;
  pivot: Vec3;
} {
  if (isWorldAxes(state.axes)) {
    return { ...state.delta, ...state.rotation, pivot: state.pivot };
  }
  const rotations = gizmoOps({ ...state, delta: { dx: 0, dy: 0, dz: 0 } });
  const m = opsAffine(rotations).m;
  return { ...state.delta, ...eulerXYZ(m), pivot: state.pivot };
}

/** Component of the move along gizmo axis `i`. */
export function deltaAlong(state: GizmoState, i: 0 | 1 | 2): number {
  const a = (state.axes ?? WORLD_AXES)[i]!;
  return state.delta.dx * a[0] + state.delta.dy * a[1] + state.delta.dz * a[2];
}

/** The move with its component along gizmo axis `i` set to `value` (other components kept). */
export function withDeltaAlong(
  state: GizmoState,
  i: 0 | 1 | 2,
  value: number,
): { dx: number; dy: number; dz: number } {
  const a = (state.axes ?? WORLD_AXES)[i]!;
  const k = value - deltaAlong(state, i);
  return {
    dx: state.delta.dx + a[0] * k,
    dy: state.delta.dy + a[1] * k,
    dz: state.delta.dz + a[2] * k,
  };
}

/**
 * Gizmo axes for geometry the centre was dropped on (auto-orientation): a
 * planar face → its sketch-frame axes (normal = third axis), a straight
 * edge → its direction as the third axis, a circle → its axis. `null` for
 * anything else (keep the current orientation).
 */
export function axesForPick(
  pick: { kind: string; bodyId?: string; faceKey?: string; edgeKey?: string } | null,
  bodies: readonly Body[],
): [Vec3, Vec3, Vec3] | null {
  if (!pick?.bodyId) return null;
  const body = bodies.find((b) => b.id === pick.bodyId);
  if (!body) return null;
  if (pick.kind === 'face') {
    const face = body.faces.find((f) => f.key === pick.faceKey);
    if (!face?.normal) return null;
    const frame = frameForFace(face.normal, face.centroid);
    return [frame.u, frame.v, frame.normal];
  }
  if (pick.kind === 'edge') {
    const edge = body.edges.find((e) => e.key === pick.edgeKey);
    if (!edge) return null;
    let dir: Vec3 | null = edge.direction;
    if (!dir && edge.curve === 'circle' && edge.segments.length >= 18) {
      const s = edge.segments;
      const n = s.length / 3;
      const p = (i: number): Vec3 => [s[i * 3]!, s[i * 3 + 1]!, s[i * 3 + 2]!];
      const a = p(0);
      const b = p(Math.floor(n / 3));
      const c = p(Math.floor((2 * n) / 3));
      const u: Vec3 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
      const v: Vec3 = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
      const cr: Vec3 = [
        u[1] * v[2] - u[2] * v[1],
        u[2] * v[0] - u[0] * v[2],
        u[0] * v[1] - u[1] * v[0],
      ];
      const len = Math.hypot(...cr);
      if (len > 1e-12) dir = [cr[0] / len, cr[1] / len, cr[2] / len];
    }
    if (!dir) return null;
    const frame = frameForFace(dir, edge.midpoint);
    return [frame.u, frame.v, frame.normal];
  }
  return null;
}

/** A direction rotated by `op` (a rotate op's matrix only). */
export function rotateDir(op: RigidOp, d: Vec3): Vec3 {
  const m = opAffine(op).m;
  return [
    m[0]! * d[0] + m[1]! * d[1] + m[2]! * d[2],
    m[3]! * d[0] + m[4]! * d[1] + m[5]! * d[2],
    m[6]! * d[0] + m[7]! * d[1] + m[8]! * d[2],
  ];
}
