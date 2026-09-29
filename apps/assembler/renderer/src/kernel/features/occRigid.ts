/** Applies `rigid.ts` motions to OCCT shapes (`gp_Trsf` + `BRepBuilderAPI_Transform`). */
import * as R from 'replicad';

import type { OpenCascade, Shape3D } from './kit.js';
import { normalize, type RigidOp } from './rigid.js';

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

/** A transformed copy of `shape` (the input is never modified). */
export function transformShape(oc: OpenCascade, shape: Shape3D, ops: readonly RigidOp[]): Shape3D {
  const trsf = toTrsf(oc, ops);
  const builder = new oc.BRepBuilderAPI_Transform(shape.wrapped, trsf, true);
  const out = R.cast(builder.Shape());
  builder.delete();
  trsf.delete();
  return out as Shape3D;
}
