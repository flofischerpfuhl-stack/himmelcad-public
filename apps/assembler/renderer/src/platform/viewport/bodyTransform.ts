/**
 * Client-side rigid motion of an evaluated body (mesh, normals, edge
 * polylines, face centroids/normals, box) for the Move/Rotate gizmo's
 * instant preview; the committed result is always re-evaluated by the kernel.
 */
import type { Body } from '../../foundation/geometry-kernel/types.js';
import {
  applyDir,
  applyPoint,
  type Affine,
} from '../../foundation/geometry-kernel/features/rigid.js';
import type { Vec3 } from '../../foundation/document/document.js';

function mapPoints(src: Float32Array, a: Affine): Float32Array {
  const out = new Float32Array(src.length);
  const { m, t } = a;
  for (let i = 0; i < src.length; i += 3) {
    const x = src[i]!;
    const y = src[i + 1]!;
    const z = src[i + 2]!;
    out[i] = m[0]! * x + m[1]! * y + m[2]! * z + t[0];
    out[i + 1] = m[3]! * x + m[4]! * y + m[5]! * z + t[1];
    out[i + 2] = m[6]! * x + m[7]! * y + m[8]! * z + t[2];
  }
  return out;
}

function mapDirections(src: Float32Array, a: Affine): Float32Array {
  return mapPoints(src, { m: a.m, t: [0, 0, 0] });
}

/** `body` moved by `a`, optionally under another id (a copy preview). */
export function transformBody(body: Body, a: Affine, id = body.id): Body {
  const positions = mapPoints(body.mesh.positions, a);
  const min: Vec3 = [Infinity, Infinity, Infinity];
  const max: Vec3 = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < positions.length; i += 3) {
    for (let k = 0; k < 3; k += 1) {
      min[k] = Math.min(min[k]!, positions[i + k]!);
      max[k] = Math.max(max[k]!, positions[i + k]!);
    }
  }
  return {
    ...body,
    id,
    min,
    max,
    mesh: {
      ...body.mesh,
      positions,
      normals: mapDirections(body.mesh.normals, a),
    },
    faces: body.faces.map((f) => ({
      ...f,
      centroid: applyPoint(a, f.centroid),
      normal: f.normal ? applyDir(a, f.normal) : null,
    })),
    edges: body.edges.map((e) => ({
      ...e,
      midpoint: applyPoint(a, e.midpoint),
      direction: e.direction ? applyDir(a, e.direction) : null,
      segments: mapPoints(e.segments, a),
    })),
  };
}
