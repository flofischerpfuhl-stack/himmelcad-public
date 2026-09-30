/**
 * Composite shapes the drawing tools create, as pure builder steps on a
 * {@link SketchBuilder}: straight and arc slots, ellipses and elliptical
 * arcs, splines, and regular polygons inscribed in / circumscribed about a
 * construction circle — each with the Shapr3D-style constraints that keep
 * it a slot / polygon when dimensions change. No solving here.
 */
import type { SketchBuilder, SnapTarget } from '../../foundation/sketch-solver/edits.js';
import {
  add,
  dist,
  ellipseAngle,
  normalize,
  rotate,
  scale,
  sub,
} from '../../foundation/sketch-solver/geometry.js';
import { naturalHandles } from '../../foundation/sketch-solver/spline.js';
import {
  nextDimensionName,
  type SketchDimensionKind,
  type Vec2,
} from '../../foundation/sketch-solver/types.js';

function dimension(
  b: SketchBuilder,
  kind: SketchDimensionKind,
  refs: string[],
  value: number,
): string {
  const id = b.id('m');
  b.dimensions.push({ id, name: nextDimensionName(b.data), kind, refs, value });
  return id;
}

// ---- slots -----------------------------------------------------------------------------

/**
 * Straight slot: centre-to-centre construction line, two end arcs of equal
 * radius and two side lines tangent to both. Optional dimensions: the
 * centre distance (`length`) and the width (a diameter of an end arc).
 */
export function buildSlot(
  b: SketchBuilder,
  first: SnapTarget,
  second: SnapTarget,
  halfWidth: number,
  options: { construction: boolean; length?: number | null; width?: number | null },
): string[] {
  const c1 = first.pos;
  const c2 = second.pos;
  const d = normalize(sub(c2, c1));
  const n: Vec2 = [-d[1], d[0]];
  const id1 = b.pointFor(first);
  const id2 = b.pointFor(second);
  const axis = b.addLine(id1, id2, true);
  // Corner points: left/right of each centre.
  const l1 = b.addPoint(add(c1, scale(n, halfWidth)));
  const r1 = b.addPoint(add(c1, scale(n, -halfWidth)));
  const l2 = b.addPoint(add(c2, scale(n, halfWidth)));
  const r2 = b.addPoint(add(c2, scale(n, -halfWidth)));
  const side1 = b.addLine(r1, r2, options.construction);
  const side2 = b.addLine(l2, l1, options.construction);
  // End arcs counter-clockwise: at c2 from right to left, at c1 from left to right.
  const arc2 = b.addArc(id2, r2, l2, options.construction);
  const arc1 = b.addArc(id1, l1, r1, options.construction);
  b.constrain('tangent', [side1, arc1]);
  b.constrain('tangent', [side1, arc2]);
  b.constrain('tangent', [side2, arc1]);
  b.constrain('tangent', [side2, arc2]);
  b.constrain('equal', [arc1, arc2]);
  if (options.length) dimension(b, 'distance', [axis], options.length);
  if (options.width) dimension(b, 'diameter', [arc1], options.width);
  return [side1, arc2, side2, arc1];
}

/**
 * Arc slot: a construction centre arc (centre, start, end), concentric
 * outer/inner arcs and two end caps tangent to both (so of equal radius).
 */
export function buildArcSlot(
  b: SketchBuilder,
  center: SnapTarget,
  start: SnapTarget,
  endPos: Vec2,
  halfWidth: number,
  ccw: boolean,
  options: { construction: boolean; width?: number | null },
): string[] {
  const c = center.pos;
  const r = dist(c, start.pos);
  const a1 = Math.atan2(endPos[1] - c[1], endPos[0] - c[0]);
  const e: Vec2 = [c[0] + r * Math.cos(a1), c[1] + r * Math.sin(a1)];
  const cId = b.pointFor(center);
  const sId = b.pointFor(start);
  const eId = b.addPoint(e);
  // Centre arc (construction), counter-clockwise from its start.
  const [from, to, fromPos, toPos] = ccw ? [sId, eId, start.pos, e] : [eId, sId, e, start.pos];
  b.addArc(cId, from, to, true);
  const fromDir = normalize(sub(fromPos, c));
  const toDir = normalize(sub(toPos, c));
  const oFrom = b.addPoint(add(fromPos, scale(fromDir, halfWidth)));
  const oTo = b.addPoint(add(toPos, scale(toDir, halfWidth)));
  const iFrom = b.addPoint(add(fromPos, scale(fromDir, -halfWidth)));
  const iTo = b.addPoint(add(toPos, scale(toDir, -halfWidth)));
  const outer = b.addArc(cId, oFrom, oTo, options.construction);
  const inner = b.addArc(cId, iFrom, iTo, options.construction);
  // Caps: at the arc's end (to) counter-clockwise from outer to inner; at its start from inner to outer.
  const capTo = b.addArc(to, oTo, iTo, options.construction);
  const capFrom = b.addArc(from, iFrom, oFrom, options.construction);
  b.constrain('tangent', [capTo, outer]);
  b.constrain('tangent', [capTo, inner]);
  b.constrain('tangent', [capFrom, outer]);
  b.constrain('tangent', [capFrom, inner]);
  // Both caps touching both concentric arcs already makes them equal (no Equal: it would be redundant).
  if (options.width) dimension(b, 'diameter', [capFrom], options.width);
  return [outer, capTo, inner, capFrom];
}

// ---- ellipses --------------------------------------------------------------------------

/** Minor radius for a cursor: its distance from the major axis line. */
export function ellipseMinor(center: Vec2, major: Vec2, cursor: Vec2): number {
  const d = normalize(sub(major, center));
  const rel = sub(cursor, center);
  return Math.abs(-d[1] * rel[0] + d[0] * rel[1]);
}

/**
 * Ellipse (or elliptical arc from parametric angle `arc[0]` to `arc[1]`,
 * counter-clockwise). The major point is the snapped click; the minor
 * point is perpendicular at `minor` from the centre. Optional dimensions:
 * the two axis radii.
 */
export function buildEllipse(
  b: SketchBuilder,
  center: SnapTarget,
  major: SnapTarget,
  minor: number,
  options: {
    construction: boolean;
    arc?: [number, number] | null;
    majorValue?: number | null;
    minorValue?: number | null;
  },
): string {
  const c = center.pos;
  const d = normalize(sub(major.pos, c));
  const n: Vec2 = [-d[1], d[0]];
  const cId = b.pointFor(center);
  const mId = b.pointFor(major);
  const nId = b.addPoint(add(c, scale(n, minor)));
  let id: string;
  if (options.arc) {
    const rx = dist(c, major.pos);
    const at = (theta: number): Vec2 =>
      add(c, add(scale(d, rx * Math.cos(theta)), scale(n, minor * Math.sin(theta))));
    const s = b.addPoint(at(options.arc[0]));
    const e = b.addPoint(at(options.arc[1]));
    id = b.id('ea');
    b.entities.push({
      id,
      kind: 'ellipticArc',
      center: cId,
      major: mId,
      minor: nId,
      start: s,
      end: e,
      ...(options.construction ? { construction: true } : {}),
    });
  } else {
    id = b.id('e');
    b.entities.push({
      id,
      kind: 'ellipse',
      center: cId,
      major: mId,
      minor: nId,
      ...(options.construction ? { construction: true } : {}),
    });
  }
  if (options.majorValue) dimension(b, 'distance', [cId, mId], options.majorValue);
  if (options.minorValue) dimension(b, 'distance', [cId, nId], options.minorValue);
  return id;
}

/** Parametric angle of a cursor on the ellipse given by centre, major point and minor radius. */
export function ellipseParam(center: Vec2, major: Vec2, minor: number, cursor: Vec2): number {
  const d = sub(major, center);
  return ellipseAngle(
    { c: center, rx: Math.hypot(d[0], d[1]), ry: minor, rot: Math.atan2(d[1], d[0]) },
    cursor,
  );
}

/** Sampled ellipse (or arc between parametric angles) for previews. */
export function ellipseOutline(
  center: Vec2,
  major: Vec2,
  minor: number,
  arc: [number, number] | null = null,
): Vec2[] {
  const d = normalize(sub(major, center));
  const n: Vec2 = [-d[1], d[0]];
  const rx = dist(center, major);
  let a0 = 0;
  let a1 = Math.PI * 2;
  if (arc) {
    a0 = arc[0];
    a1 = arc[1];
    while (a1 <= a0) a1 += Math.PI * 2;
  }
  const out: Vec2[] = [];
  const steps = 96;
  for (let i = 0; i <= steps; i += 1) {
    const t = a0 + ((a1 - a0) * i) / steps;
    out.push(add(center, add(scale(d, rx * Math.cos(t)), scale(n, minor * Math.sin(t)))));
  }
  return out;
}

// ---- splines ---------------------------------------------------------------------------

/** Adds a spline through / with the snapped points (closed when the last snaps to the first point). */
export function buildSpline(
  b: SketchBuilder,
  points: readonly SnapTarget[],
  mode: 'fit' | 'control',
  construction: boolean,
): string {
  const ids = points.map((p) => b.pointFor(p));
  // Clicking the first point again closes the spline on that point.
  const positions = points.map((p) => p.pos);
  let handles: [string | null, string | null] | undefined;
  if (mode === 'fit') {
    const natural = naturalHandles(positions);
    if (natural) handles = [b.addPoint(natural[0]), b.addPoint(natural[1])];
  }
  const id = b.id('s');
  b.entities.push({
    id,
    kind: 'spline',
    mode,
    points: ids,
    ...(mode === 'control' ? { degree: 3 } : {}),
    ...(handles ? { handles } : {}),
    ...(construction ? { construction: true } : {}),
  });
  return id;
}

// ---- polygons --------------------------------------------------------------------------

/**
 * Vertex positions of a regular polygon. Inscribed: `cursor` is a vertex.
 * Circumscribed: `cursor` is the midpoint of an edge (the construction
 * circle touches the edges).
 */
export function regularPolygon(
  center: Vec2,
  cursor: Vec2,
  sides: number,
  inscribed: boolean,
): Vec2[] {
  const r = dist(center, cursor);
  const a0 = Math.atan2(cursor[1] - center[1], cursor[0] - center[0]);
  const step = (2 * Math.PI) / sides;
  const vr = inscribed ? r : r / Math.cos(step / 2);
  const start = inscribed ? a0 : a0 - step / 2;
  return Array.from({ length: sides }, (_, i) => {
    const a = start + i * step;
    return [center[0] + vr * Math.cos(a), center[1] + vr * Math.sin(a)] as Vec2;
  });
}

/** Rotates a point about a centre (degrees). */
export function rotateAbout(p: Vec2, center: Vec2, degrees: number): Vec2 {
  return add(center, rotate(sub(p, center), (degrees * Math.PI) / 180));
}
