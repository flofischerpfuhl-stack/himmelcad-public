/**
 * Applies `rigid.ts` motions to OCCT shapes (`gp_Trsf` + `BRepBuilderAPI_Transform`),
 * and scaling (uniform: `gp_Trsf::SetScale`; per axis: `BRepBuilderAPI_GTransform`
 * of the HimmelCAD build).
 */
import '../occtArena.js';
import * as R from 'replicad';

import type { Vec3 } from '../../document/document.js';
import { gTransformClass } from '../occtExtras.js';
import type { RawShape } from '../occt.js';
import type { OpenCascade, Shape3D } from './kit.js';
import { normalize, type RigidOp } from './rigid.js';

/** Why a per-axis scale cannot run on this kernel build (`null`: it can). */
export function nonUniformScaleUnsupported(oc: OpenCascade): string | null {
  return gTransformClass(oc)
    ? null
    : 'Scaling by different factors per axis needs the HimmelCAD OCCT build (8.0.1-hc.3 or newer); scale uniformly instead';
}

/**
 * A scaled copy of `shape` (the input is never modified): `x -> c + f (x - c)`
 * per world axis. Uniform factors keep exact analytic surfaces; per-axis
 * factors convert them to NURBS where a similarity cannot carry them.
 * Throws when the build cannot scale per axis.
 */
export function scaleShape(oc: OpenCascade, shape: Shape3D, center: Vec3, factors: Vec3): Shape3D {
  const uniform = factors[0] === factors[1] && factors[1] === factors[2];
  if (uniform) {
    const trsf = new oc.gp_Trsf();
    const p = new oc.gp_Pnt(center[0], center[1], center[2]);
    trsf.SetScale(p, factors[0]);
    p.delete();
    // Copy the geometry: a scale must not live in a shape location (OCCT rejects scaled locations).
    const builder = new oc.BRepBuilderAPI_Transform(shape.wrapped, trsf, true, false);
    try {
      const raw = builder.Shape();
      try {
        return R.cast(raw) as Shape3D;
      } finally {
        raw.delete();
      }
    } finally {
      builder.delete();
      trsf.delete();
    }
  }
  const GTransform = gTransformClass(oc);
  if (!GTransform) throw new Error(nonUniformScaleUnsupported(oc) ?? 'No GTransform');
  const gtrsf = new oc.gp_GTrsf();
  for (let i = 0; i < 3; i += 1) {
    for (let j = 0; j < 3; j += 1) gtrsf.SetValue(i + 1, j + 1, i === j ? factors[i]! : 0);
    // Fixed point `center`: translation part c - F c.
    gtrsf.SetValue(i + 1, 4, center[i]! * (1 - factors[i]!));
  }
  gtrsf.SetForm();
  const builder = new GTransform(shape.wrapped as RawShape, gtrsf, true);
  try {
    if (!builder.IsDone()) throw new Error('OCCT could not scale the body');
    const raw = builder.Shape();
    try {
      return R.cast(raw as never) as Shape3D;
    } finally {
      raw.delete();
    }
  } finally {
    builder.delete();
    gtrsf.delete();
  }
}

/** OCCT transformation of `ops` (applied in order). */
function toTrsf(oc: OpenCascade, ops: readonly RigidOp[]) {
  const total = new oc.gp_Trsf();
  for (const op of ops) {
    const step = new oc.gp_Trsf();
    if (op.kind === 'translate') {
      const v = new oc.gp_Vec(op.vector[0], op.vector[1], op.vector[2]);
      step.SetTranslation(v);
      v.delete();
    } else if (op.kind === 'rotate') {
      const p = new oc.gp_Pnt(op.point[0], op.point[1], op.point[2]);
      const n = normalize(op.axis);
      const d = new oc.gp_Dir(n[0], n[1], n[2]);
      const ax = new oc.gp_Ax1(p, d);
      step.SetRotation(ax, op.angle);
      for (const o of [ax, d, p]) o.delete();
    } else {
      const p = new oc.gp_Pnt(op.point[0], op.point[1], op.point[2]);
      const n = normalize(op.normal);
      const d = new oc.gp_Dir(n[0], n[1], n[2]);
      const ax = new oc.gp_Ax2(p, d);
      step.SetMirror(ax);
      for (const o of [ax, d, p]) o.delete();
    }
    total.PreMultiply(step);
    step.delete();
  }
  return total;
}

/**
 * A transformed copy of `shape` (the input is never modified). Rotations
 * and translations only set a new location on the same B-rep (no geometry
 * copy — pattern instances share surfaces and face triangulations with
 * their source); a mirror duplicates the geometry.
 */
export function transformShape(oc: OpenCascade, shape: Shape3D, ops: readonly RigidOp[]): Shape3D {
  const trsf = toTrsf(oc, ops);
  const copyGeometry = ops.some((op) => op.kind === 'mirror');
  const builder = new oc.BRepBuilderAPI_Transform(shape.wrapped, trsf, copyGeometry, false);
  try {
    const raw = builder.Shape();
    try {
      return R.cast(raw) as Shape3D;
    } finally {
      raw.delete();
    }
  } finally {
    builder.delete();
    trsf.delete();
  }
}
