/**
 * Primitive solids of the "Add" menu (`PrimitiveFeature`): box, cylinder,
 * cone, sphere and torus standing on a plane, with Extrude's New/Join/Cut.
 * Exact analytic surfaces (a box and a cylinder are prisms, a cone and a
 * torus revolutions of their meridian section, a sphere OCCT's own).
 *
 * Faces are named by role so later steps keep their references when the
 * sizes change: `<id>:bottom`, `<id>:top`, `<id>:side:<n>` (box sides +u,
 * +v, −u, −v), `<id>:side` (a cylinder's or cone's mantle), `<id>:surface`
 * (sphere, torus).
 */
import '../../../foundation/geometry-kernel/occtArena.js';
import * as R from '../../../foundation/geometry-kernel/features/occtApi.js';

import {
  MIN_FEATURE_SIZE_MM,
  frameForFace,
  type SketchFrame,
  type Vec3,
} from '../../../foundation/document/document.js';
import { assignFaceKeys } from '../../../foundation/geometry-kernel/naming.js';
import type {
  FeatureKit,
  ReplayContextLike,
  Shape3D,
} from '../../../foundation/geometry-kernel/features/kit.js';
import { resolvePlane } from '../../../foundation/geometry-kernel/features/refs.js';
import { add, dot, scale, sub } from '../../../foundation/geometry-kernel/features/rigid.js';
import { PRIMITIVE_LABEL, PRIMITIVE_SIZE_FIELDS, type PrimitiveFeature } from '../features.js';
import { finishProfileSolid } from './profileSolids.js';

/** Largest primitive size, mm (a sanity bound, like the extrude limits). */
const MAX_PRIMITIVE_SIZE_MM = 100_000;

export function applyPrimitive(
  feature: PrimitiveFeature,
  ctx: ReplayContextLike,
  kit: FeatureKit,
): void {
  const label = PRIMITIVE_LABEL[feature.shape];
  if (!label) kit.fail(`Unknown primitive "${String(feature.shape)}"`);
  for (const field of PRIMITIVE_SIZE_FIELDS[feature.shape]) {
    const value = feature[field];
    const zeroAllowed = field === 'radius2' && feature.shape === 'cone';
    if (
      value === undefined ||
      !Number.isFinite(value) ||
      value > MAX_PRIMITIVE_SIZE_MM ||
      (zeroAllowed ? value < 0 : value < MIN_FEATURE_SIZE_MM)
    ) {
      kit.fail(
        `${label} ${sizeLabel(feature.shape, field)} must be ${zeroAllowed ? 'zero or ' : ''}at least ${MIN_FEATURE_SIZE_MM} mm`,
      );
    }
  }
  if (!feature.center.every(Number.isFinite)) kit.fail(`${label} needs a centre point`);
  const plane = resolvePlane(kit, ctx, feature.plane);
  const frame = frameForFace(plane.normal, plane.point);
  // The base centre: the given point dropped onto the plane.
  const base = sub(
    feature.center,
    scale(frame.normal, dot(sub(feature.center, plane.point), frame.normal)),
  );
  let shape: Shape3D;
  try {
    shape = buildPrimitive(kit, feature, frame, base);
  } catch (error) {
    if (kit.isFailure(error)) throw error;
    kit.fail(`${label} failed: ${kit.describeError(error)}`);
  }
  if (!(R.measureVolume(shape) > 0)) kit.fail(`${label} failed: the result is not a closed solid`);
  const geoms = kit.describeShape(shape);
  const n = frame.normal;
  const sides: [Vec3, string][] = [
    [frame.u, 'side:0'],
    [frame.v, 'side:1'],
    [scale(frame.u, -1), 'side:2'],
    [scale(frame.v, -1), 'side:3'],
  ];
  const role = (index: number): string => {
    const g = geoms[index]!;
    if (feature.shape === 'sphere' || feature.shape === 'torus') return 'surface';
    if (g.normal && g.surface === 'plane') {
      const along = dot(g.normal, n);
      if (along < -1 + 1e-6) return 'bottom';
      if (along > 1 - 1e-6) return 'top';
      if (feature.shape === 'box') {
        const side = sides.find(([dir]) => dot(g.normal!, dir) > 1 - 1e-6);
        if (side) return side[1];
      }
    }
    return 'side';
  };
  const keys = assignFaceKeys(geoms, [], new Map(), (i) => `${feature.id}:${role(i)}`);
  finishProfileSolid(kit, ctx, feature, { shape, faces: kit.withKeys(geoms, keys) }, label);
}

function sizeLabel(shape: PrimitiveFeature['shape'], field: string): string {
  if (field === 'radius2') return shape === 'cone' ? 'top radius' : 'tube radius';
  if (field === 'radius' && shape === 'torus') return 'ring radius';
  return field;
}

function buildPrimitive(
  kit: FeatureKit,
  feature: PrimitiveFeature,
  frame: SketchFrame,
  base: Vec3,
): Shape3D {
  const { u, v, normal: n } = frame;
  switch (feature.shape) {
    case 'box': {
      const w = feature.width! / 2;
      const d = feature.depth! / 2;
      const corners = [
        [-w, -d],
        [w, -d],
        [w, d],
        [-w, d],
      ].map(([a, b]) => add(add(base, scale(u, a!)), scale(v, b!)));
      const face = R.makePolygon(corners);
      const vector = new R.Vector(scale(n, feature.height!));
      try {
        return R.basicFaceExtrusion(face, vector);
      } finally {
        vector.delete();
      }
    }
    case 'cylinder':
      return R.makeCylinder(feature.radius!, feature.height!, base, n);
    case 'sphere': {
      const r = feature.radius!;
      return R.makeSphere(r).translate(add(base, scale(n, r))) as Shape3D;
    }
    case 'cone': {
      const r1 = feature.radius!;
      const r2 = feature.radius2 ?? 0;
      const h = feature.height!;
      if (Math.abs(r1 - r2) < 1e-9) kit.fail('Cone radii are equal; add a cylinder instead');
      const top = add(base, scale(n, h));
      // The meridian section in the (u, n) half plane, revolved about the axis.
      const section = [base, add(base, scale(u, r1))];
      if (r2 > 0) section.push(add(top, scale(u, r2)));
      section.push(top);
      return revolveFull(kit, R.makePolygon(section), base, n);
    }
    case 'torus': {
      const ring = feature.radius!;
      const tube = feature.radius2!;
      if (!(tube < ring)) kit.fail('The tube radius must be smaller than the ring radius');
      const centre = add(add(base, scale(u, ring)), scale(n, tube));
      const circle = R.makeFace(R.assembleWire([R.makeCircle(tube, centre, v)]));
      return revolveFull(kit, circle, add(base, scale(n, tube)), n);
    }
  }
}

/** A full revolution of `face` about the axis through `point` along `dir`. */
function revolveFull(kit: FeatureKit, face: R.Face, point: Vec3, dir: Vec3): Shape3D {
  const oc = kit.oc;
  const p = new oc.gp_Pnt(point[0], point[1], point[2]);
  const d = new oc.gp_Dir(dir[0], dir[1], dir[2]);
  const ax = new oc.gp_Ax1(p, d);
  const builder = new oc.BRepPrimAPI_MakeRevol(face.wrapped, ax, false);
  try {
    const raw = builder.Shape();
    try {
      return R.cast(raw) as Shape3D;
    } finally {
      raw.delete();
    }
  } finally {
    builder.delete();
    for (const o of [ax, d, p]) o.delete();
  }
}
