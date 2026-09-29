/**
 * Pure 2D geometry for sketches: a small parametric curve model (segments
 * and circular arcs), evaluation, intersections, distances and signed
 * areas. Used by region detection, trimming, snapping and hit testing.
 * No DOM, no kernel; unit tested under `node:test`.
 */
import {
  entityMap,
  pointPos,
  radiusOf,
  type SketchCurve,
  type SketchData,
  type SketchEntity,
  type Vec2,
} from './types.js';

/** Geometric tolerance for sketch coincidence tests, millimetres. */
export const EPS = 1e-6;

const TAU = Math.PI * 2;

/**
 * A parametric curve on `t ∈ [0, 1]`: a segment `a → b`, or an arc around
 * `c` with radius `r` starting at angle `a0` and sweeping `sweep` radians
 * (positive = counter-clockwise; `±2π` = full circle starting at `a0`).
 */
export type Curve2 =
  | { kind: 'line'; a: Vec2; b: Vec2 }
  | { kind: 'arc'; c: Vec2; r: number; a0: number; sweep: number };

export function sub(a: Vec2, b: Vec2): Vec2 {
  return [a[0] - b[0], a[1] - b[1]];
}

export function add(a: Vec2, b: Vec2): Vec2 {
  return [a[0] + b[0], a[1] + b[1]];
}

export function scale(a: Vec2, k: number): Vec2 {
  return [a[0] * k, a[1] * k];
}

export function dot(a: Vec2, b: Vec2): number {
  return a[0] * b[0] + a[1] * b[1];
}

export function cross(a: Vec2, b: Vec2): number {
  return a[0] * b[1] - a[1] * b[0];
}

export function dist(a: Vec2, b: Vec2): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1]);
}

export function len(a: Vec2): number {
  return Math.hypot(a[0], a[1]);
}

export function normalize(a: Vec2): Vec2 {
  const l = len(a) || 1;
  return [a[0] / l, a[1] / l];
}

/** Angle normalized to `[0, 2π)`. */
export function normAngle(a: number): number {
  const r = a % TAU;
  return r < 0 ? r + TAU : r;
}

export function pointAt(curve: Curve2, t: number): Vec2 {
  if (curve.kind === 'line') {
    return [curve.a[0] + (curve.b[0] - curve.a[0]) * t, curve.a[1] + (curve.b[1] - curve.a[1]) * t];
  }
  const angle = curve.a0 + curve.sweep * t;
  return [curve.c[0] + curve.r * Math.cos(angle), curve.c[1] + curve.r * Math.sin(angle)];
}

/** Unit tangent in the direction of increasing `t`. */
export function tangentAt(curve: Curve2, t: number): Vec2 {
  if (curve.kind === 'line') return normalize(sub(curve.b, curve.a));
  const angle = curve.a0 + curve.sweep * t;
  const s = Math.sign(curve.sweep) || 1;
  return [-Math.sin(angle) * s, Math.cos(angle) * s];
}

/** Signed curvature in the direction of increasing `t` (left turn positive). */
export function curvatureOf(curve: Curve2): number {
  if (curve.kind === 'line') return 0;
  return (Math.sign(curve.sweep) || 1) / curve.r;
}

export function curveLength(curve: Curve2): number {
  if (curve.kind === 'line') return dist(curve.a, curve.b);
  return Math.abs(curve.sweep) * curve.r;
}

export function isFullCircle(curve: Curve2): boolean {
  return curve.kind === 'arc' && Math.abs(Math.abs(curve.sweep) - TAU) < 1e-12;
}

/** The part of `curve` between parameters `t0` and `t1` (reparametrized to [0, 1]). */
export function subCurve(curve: Curve2, t0: number, t1: number): Curve2 {
  if (curve.kind === 'line') return { kind: 'line', a: pointAt(curve, t0), b: pointAt(curve, t1) };
  return {
    kind: 'arc',
    c: curve.c,
    r: curve.r,
    a0: curve.a0 + curve.sweep * t0,
    sweep: curve.sweep * (t1 - t0),
  };
}

export function reverseCurve(curve: Curve2): Curve2 {
  if (curve.kind === 'line') return { kind: 'line', a: curve.b, b: curve.a };
  return { kind: 'arc', c: curve.c, r: curve.r, a0: curve.a0 + curve.sweep, sweep: -curve.sweep };
}

/**
 * Parameter of a point assumed to lie on (the carrier of) `curve`: projected
 * onto the segment line, or the angle along the arc. For a full circle the
 * result is in `[0, 1)`; for a partial arc it may be outside `[0, 1]` when
 * the point is off the arc.
 */
export function paramOf(curve: Curve2, p: Vec2): number {
  if (curve.kind === 'line') {
    const d = sub(curve.b, curve.a);
    const l2 = dot(d, d);
    return l2 === 0 ? 0 : dot(sub(p, curve.a), d) / l2;
  }
  const angle = Math.atan2(p[1] - curve.c[1], p[0] - curve.c[0]);
  const s = Math.sign(curve.sweep) || 1;
  const along = normAngle((angle - curve.a0) * s);
  const t = along / Math.abs(curve.sweep);
  if (isFullCircle(curve)) return t >= 1 - 1e-12 ? 0 : t;
  // Points slightly before the start come out near 2π: map them to small negatives.
  const beyond = (TAU - along) / Math.abs(curve.sweep);
  return t > 1 && beyond < t - 1 ? -beyond : t;
}

/** Closest point on the curve (clamped to its extent) and its parameter. */
export function closestOnCurve(
  curve: Curve2,
  p: Vec2,
): { t: number; point: Vec2; distance: number } {
  let t: number;
  if (curve.kind === 'line') {
    t = Math.min(1, Math.max(0, paramOf(curve, p)));
  } else if (isFullCircle(curve)) {
    t = paramOf(curve, p);
  } else {
    const raw = paramOf(curve, p);
    if (raw >= 0 && raw <= 1) t = raw;
    else t = dist(pointAt(curve, 0), p) < dist(pointAt(curve, 1), p) ? 0 : 1;
  }
  const point = pointAt(curve, t);
  return { t, point, distance: dist(point, p) };
}

/** One intersection of two curves with its parameters on both. */
export interface Intersection {
  t1: number;
  t2: number;
  point: Vec2;
}

function inRange(t: number, eps: number): boolean {
  return t >= -eps && t <= 1 + eps;
}

function clamp01(t: number): number {
  return Math.min(1, Math.max(0, t));
}

/**
 * Intersections of two curves within their extents (endpoints included).
 * Overlapping collinear segments / co-circular arcs report the endpoints of
 * the overlap so both can be split there.
 */
export function intersectCurves(c1: Curve2, c2: Curve2, eps = EPS): Intersection[] {
  if (c1.kind === 'line' && c2.kind === 'line') return intersectLines(c1, c2, eps);
  if (c1.kind === 'line' && c2.kind === 'arc') return intersectLineArc(c1, c2, eps);
  if (c1.kind === 'arc' && c2.kind === 'line') {
    return intersectLineArc(c2, c1, eps).map((i) => ({ t1: i.t2, t2: i.t1, point: i.point }));
  }
  return intersectArcs(
    c1 as Extract<Curve2, { kind: 'arc' }>,
    c2 as Extract<Curve2, { kind: 'arc' }>,
    eps,
  );
}

function intersectLines(
  l1: Extract<Curve2, { kind: 'line' }>,
  l2: Extract<Curve2, { kind: 'line' }>,
  eps: number,
): Intersection[] {
  const d1 = sub(l1.b, l1.a);
  const d2 = sub(l2.b, l2.a);
  const len1 = len(d1);
  const len2 = len(d2);
  if (len1 < eps || len2 < eps) return [];
  const denom = cross(d1, d2);
  const w = sub(l2.a, l1.a);
  if (Math.abs(denom) < 1e-12 * len1 * len2) {
    // Parallel: overlapping only if collinear.
    if (Math.abs(cross(w, d1)) / len1 > eps) return [];
    const out: Intersection[] = [];
    const push = (t1: number, t2: number) => {
      if (!inRange(t1, eps / len1) || !inRange(t2, eps / len2)) return;
      const tt1 = clamp01(t1);
      if (out.some((o) => Math.abs(o.t1 - tt1) * len1 < eps)) return;
      out.push({ t1: tt1, t2: clamp01(t2), point: pointAt(l1, tt1) });
    };
    push(paramOf(l1, l2.a), 0);
    push(paramOf(l1, l2.b), 1);
    push(0, paramOf(l2, l1.a));
    push(1, paramOf(l2, l1.b));
    return out;
  }
  const t1 = cross(w, d2) / denom;
  const t2 = cross(w, d1) / denom;
  if (!inRange(t1, eps / len1) || !inRange(t2, eps / len2)) return [];
  const tt1 = clamp01(t1);
  return [{ t1: tt1, t2: clamp01(t2), point: pointAt(l1, tt1) }];
}

function arcParamIfOn(arc: Extract<Curve2, { kind: 'arc' }>, p: Vec2, eps: number): number | null {
  const t = paramOf(arc, p);
  const tolT = eps / Math.max(eps, arc.r * Math.abs(arc.sweep));
  if (isFullCircle(arc)) return t;
  return inRange(t, tolT) ? clamp01(t) : null;
}

function intersectLineArc(
  line: Extract<Curve2, { kind: 'line' }>,
  arc: Extract<Curve2, { kind: 'arc' }>,
  eps: number,
): Intersection[] {
  const d = sub(line.b, line.a);
  const l = len(d);
  if (l < eps) return [];
  const u = scale(d, 1 / l);
  const f = sub(line.a, arc.c);
  // |f + s u|^2 = r^2, s = distance along the line from a.
  const b = dot(f, u);
  const c = dot(f, f) - arc.r * arc.r;
  let disc = b * b - c;
  // Tangency within tolerance: distance from the centre to the line equals r.
  const distToLine = Math.abs(cross(f, u));
  if (Math.abs(distToLine - arc.r) < eps) disc = Math.max(0, disc);
  if (disc < 0) return [];
  const root = Math.sqrt(disc);
  const ss = root < eps ? [-b] : [-b - root, -b + root];
  const out: Intersection[] = [];
  for (const s of ss) {
    const t1 = s / l;
    if (!inRange(t1, eps / l)) continue;
    const tt1 = clamp01(t1);
    const point = pointAt(line, tt1);
    const t2 = arcParamIfOn(arc, point, eps);
    if (t2 === null) continue;
    out.push({ t1: tt1, t2, point });
  }
  return out;
}

function intersectArcs(
  a1: Extract<Curve2, { kind: 'arc' }>,
  a2: Extract<Curve2, { kind: 'arc' }>,
  eps: number,
): Intersection[] {
  const d = dist(a1.c, a2.c);
  if (d < eps && Math.abs(a1.r - a2.r) < eps) {
    // Same circle: split at each other's endpoints.
    const out: Intersection[] = [];
    const candidates: Vec2[] = [];
    if (!isFullCircle(a2)) candidates.push(pointAt(a2, 0), pointAt(a2, 1));
    if (!isFullCircle(a1)) candidates.push(pointAt(a1, 0), pointAt(a1, 1));
    for (const p of candidates) {
      const t1 = arcParamIfOn(a1, p, eps);
      const t2 = arcParamIfOn(a2, p, eps);
      if (t1 === null || t2 === null) continue;
      if (out.some((o) => dist(o.point, p) < eps)) continue;
      out.push({ t1, t2, point: p });
    }
    return out;
  }
  if (d < eps) return [];
  if (d > a1.r + a2.r + eps || d < Math.abs(a1.r - a2.r) - eps) return [];
  const a = (a1.r * a1.r - a2.r * a2.r + d * d) / (2 * d);
  const h2 = a1.r * a1.r - a * a;
  const h = h2 > 0 ? Math.sqrt(h2) : 0;
  const ex = scale(sub(a2.c, a1.c), 1 / d);
  const base = add(a1.c, scale(ex, a));
  const points: Vec2[] =
    h < eps
      ? [base]
      : [
          [base[0] - ex[1] * h, base[1] + ex[0] * h],
          [base[0] + ex[1] * h, base[1] - ex[0] * h],
        ];
  const out: Intersection[] = [];
  for (const p of points) {
    const t1 = arcParamIfOn(a1, p, eps);
    const t2 = arcParamIfOn(a2, p, eps);
    if (t1 === null || t2 === null) continue;
    out.push({ t1, t2, point: p });
  }
  return out;
}

/**
 * Signed area contribution `½∮(x dy − y dx)` of a curve traversed with
 * increasing `t`; summing over a closed loop gives its signed area
 * (counter-clockwise positive).
 */
export function areaTerm(curve: Curve2): number {
  if (curve.kind === 'line') return 0.5 * (curve.a[0] * curve.b[1] - curve.b[0] * curve.a[1]);
  const { c, r, a0, sweep } = curve;
  const a1 = a0 + sweep;
  return (
    0.5 *
    (r * c[0] * (Math.sin(a1) - Math.sin(a0)) -
      r * c[1] * (Math.cos(a1) - Math.cos(a0)) +
      r * r * sweep)
  );
}

/** Polyline approximation of a curve (first and last point included). */
export function sampleCurve(curve: Curve2, maxAngleStep = Math.PI / 48): Vec2[] {
  if (curve.kind === 'line') return [curve.a, curve.b];
  const n = Math.max(2, Math.ceil(Math.abs(curve.sweep) / maxAngleStep));
  const out: Vec2[] = [];
  for (let i = 0; i <= n; i += 1) out.push(pointAt(curve, i / n));
  return out;
}

/** Even-odd point-in-polygon test. */
export function pointInPolygon(p: Vec2, polygon: readonly Vec2[]): boolean {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i, i += 1) {
    const a = polygon[i]!;
    const b = polygon[j]!;
    if (a[1] > p[1] !== b[1] > p[1]) {
      const x = ((b[0] - a[0]) * (p[1] - a[1])) / (b[1] - a[1]) + a[0];
      if (p[0] < x) inside = !inside;
    }
  }
  return inside;
}

/** Circle through three points, or `null` when they are (nearly) collinear. */
export function circleThrough(p1: Vec2, p2: Vec2, p3: Vec2): { c: Vec2; r: number } | null {
  const ax = p1[0];
  const ay = p1[1];
  const bx = p2[0];
  const by = p2[1];
  const cx = p3[0];
  const cy = p3[1];
  const d = 2 * (ax * (by - cy) + bx * (cy - ay) + cx * (ay - by));
  if (Math.abs(d) < 1e-12) return null;
  const a2 = ax * ax + ay * ay;
  const b2 = bx * bx + by * by;
  const c2 = cx * cx + cy * cy;
  const ux = (a2 * (by - cy) + b2 * (cy - ay) + c2 * (ay - by)) / d;
  const uy = (a2 * (cx - bx) + b2 * (ax - cx) + c2 * (bx - ax)) / d;
  return { c: [ux, uy], r: Math.hypot(ax - ux, ay - uy) };
}

// ---- sketch entities as curves ------------------------------------------------------

/** The curve of a sketch line/circle/arc entity (arcs counter-clockwise start → end). */
export function entityCurve(
  map: ReadonlyMap<string, SketchEntity>,
  entity: SketchCurve,
): Curve2 | null {
  if (entity.kind === 'line') {
    const a = pointPos(map, entity.a);
    const b = pointPos(map, entity.b);
    return a && b ? { kind: 'line', a, b } : null;
  }
  const c = pointPos(map, entity.center);
  if (!c) return null;
  if (entity.kind === 'circle') return { kind: 'arc', c, r: entity.radius, a0: 0, sweep: TAU };
  const s = pointPos(map, entity.start);
  const e = pointPos(map, entity.end);
  if (!s || !e) return null;
  const a0 = Math.atan2(s[1] - c[1], s[0] - c[0]);
  const a1 = Math.atan2(e[1] - c[1], e[0] - c[0]);
  let sweep = normAngle(a1 - a0);
  if (sweep < 1e-12) sweep = TAU;
  return { kind: 'arc', c, r: radiusOf(map, entity), a0, sweep };
}

/** All curves of a sketch by entity id (construction included unless excluded). */
export function sketchCurves(
  sketch: Pick<SketchData, 'entities'>,
  options: { includeConstruction?: boolean } = {},
): { id: string; entity: SketchCurve; curve: Curve2 }[] {
  const map = entityMap(sketch);
  const out: { id: string; entity: SketchCurve; curve: Curve2 }[] = [];
  for (const entity of sketch.entities) {
    if (entity.kind === 'point') continue;
    if (entity.construction && !options.includeConstruction) continue;
    const curve = entityCurve(map, entity);
    if (curve) out.push({ id: entity.id, entity, curve });
  }
  return out;
}
