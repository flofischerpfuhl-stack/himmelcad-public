/**
 * Pure 2D geometry for sketches: a small parametric curve model (segments,
 * circular arcs, elliptical arcs and Bézier chains), evaluation,
 * intersections, distances and signed areas. Used by region detection,
 * trimming, snapping and hit testing. No DOM, no kernel; unit tested under
 * `node:test`.
 */
import { bsplineToBeziers, fitSplineBeziers, type BezierSegment } from './spline.js';
import { parseOutline, placeContours } from './text/outline.js';
import {
  entityMap,
  pointPos,
  radiusOf,
  type SketchCurve,
  type SketchData,
  type SketchEntity,
  type SketchText,
  type Vec2,
} from './types.js';

/** Geometric tolerance for sketch coincidence tests, millimetres. */
export const EPS = 1e-6;

const TAU = Math.PI * 2;

/**
 * A parametric curve on `t ∈ [0, 1]`:
 * - a segment `a → b`;
 * - an arc around `c` with radius `r` starting at angle `a0` and sweeping
 *   `sweep` radians (positive = counter-clockwise; `±2π` = full circle);
 * - an elliptical arc: `c + R(rot)·(rx cos θ, ry sin θ)` for the parametric
 *   angle `θ = a0 + sweep·t`;
 * - a chain of Bézier segments (degree 1–3), `t` uniform per segment.
 */
export type Curve2 =
  | { kind: 'line'; a: Vec2; b: Vec2 }
  | { kind: 'arc'; c: Vec2; r: number; a0: number; sweep: number }
  | { kind: 'ellipse'; c: Vec2; rx: number; ry: number; rot: number; a0: number; sweep: number }
  | { kind: 'bezier'; segs: BezierSegment[] };

type Arc2 = Extract<Curve2, { kind: 'arc' }>;
type Ellipse2 = Extract<Curve2, { kind: 'ellipse' }>;
type Bezier2 = Extract<Curve2, { kind: 'bezier' }>;

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

export function rotate(a: Vec2, angle: number): Vec2 {
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  return [a[0] * c - a[1] * s, a[0] * s + a[1] * c];
}

/** Angle normalized to `[0, 2π)`. */
export function normAngle(a: number): number {
  const r = a % TAU;
  return r < 0 ? r + TAU : r;
}

// ---- Bézier helpers -----------------------------------------------------------------

/** Point of a Bézier segment at `s ∈ [0, 1]` (de Casteljau). */
export function bezierPoint(seg: readonly Vec2[], s: number): Vec2 {
  let pts = seg.map((p) => [p[0], p[1]] as Vec2);
  while (pts.length > 1) {
    const next: Vec2[] = [];
    for (let i = 0; i + 1 < pts.length; i += 1) {
      next.push([
        pts[i]![0] + (pts[i + 1]![0] - pts[i]![0]) * s,
        pts[i]![1] + (pts[i + 1]![1] - pts[i]![1]) * s,
      ]);
    }
    pts = next;
  }
  return pts[0]!;
}

/** First derivative of a Bézier segment with respect to its own parameter. */
function bezierDeriv(seg: readonly Vec2[], s: number): Vec2 {
  const n = seg.length - 1;
  if (n < 1) return [0, 0];
  const diffs: Vec2[] = [];
  for (let i = 0; i < n; i += 1) diffs.push(scale(sub(seg[i + 1]!, seg[i]!), n));
  return diffs.length === 1 ? diffs[0]! : bezierPoint(diffs, s);
}

function bezierSecond(seg: readonly Vec2[], s: number): Vec2 {
  const n = seg.length - 1;
  if (n < 2) return [0, 0];
  const diffs: Vec2[] = [];
  for (let i = 0; i < n; i += 1) diffs.push(scale(sub(seg[i + 1]!, seg[i]!), n));
  return bezierDeriv(diffs, s);
}

/** Splits a Bézier segment at `s` into its two halves. */
export function splitBezier(seg: readonly Vec2[], s: number): [Vec2[], Vec2[]] {
  const left: Vec2[] = [];
  const right: Vec2[] = [];
  let pts = seg.map((p) => [p[0], p[1]] as Vec2);
  while (pts.length > 0) {
    left.push(pts[0]!);
    right.unshift(pts[pts.length - 1]!);
    const next: Vec2[] = [];
    for (let i = 0; i + 1 < pts.length; i += 1) {
      next.push([
        pts[i]![0] + (pts[i + 1]![0] - pts[i]![0]) * s,
        pts[i]![1] + (pts[i + 1]![1] - pts[i]![1]) * s,
      ]);
    }
    pts = next;
  }
  return [left, right];
}

/** The part of a Bézier segment between `s0 < s1`. */
function bezierRange(seg: readonly Vec2[], s0: number, s1: number): Vec2[] {
  if (s0 <= 0 && s1 >= 1) return seg.map((p) => [p[0], p[1]] as Vec2);
  const [left] = s1 >= 1 ? [seg.map((p) => [p[0], p[1]] as Vec2)] : splitBezier(seg, s1);
  if (s0 <= 0) return left;
  return splitBezier(left, s0 / s1)[1];
}

/** Segment index and local parameter of a chain parameter. */
function locate(curve: Bezier2, t: number): { i: number; s: number } {
  const n = curve.segs.length;
  if (t >= 1) return { i: n - 1, s: 1 };
  if (t <= 0) return { i: 0, s: 0 };
  const i = Math.min(n - 1, Math.floor(t * n));
  return { i, s: t * n - i };
}

// ---- evaluation -----------------------------------------------------------------------

function ellipsePoint(e: Ellipse2, theta: number): Vec2 {
  const local: Vec2 = [e.rx * Math.cos(theta), e.ry * Math.sin(theta)];
  return add(e.c, rotate(local, e.rot));
}

export function pointAt(curve: Curve2, t: number): Vec2 {
  switch (curve.kind) {
    case 'line':
      return [
        curve.a[0] + (curve.b[0] - curve.a[0]) * t,
        curve.a[1] + (curve.b[1] - curve.a[1]) * t,
      ];
    case 'arc': {
      const angle = curve.a0 + curve.sweep * t;
      return [curve.c[0] + curve.r * Math.cos(angle), curve.c[1] + curve.r * Math.sin(angle)];
    }
    case 'ellipse':
      return ellipsePoint(curve, curve.a0 + curve.sweep * t);
    case 'bezier': {
      if (curve.segs.length === 0) return [0, 0];
      const { i, s } = locate(curve, t);
      return bezierPoint(curve.segs[i]!, s);
    }
  }
}

/** Derivative `dP/dt` (not normalized). */
export function derivAt(curve: Curve2, t: number): Vec2 {
  switch (curve.kind) {
    case 'line':
      return sub(curve.b, curve.a);
    case 'arc': {
      const angle = curve.a0 + curve.sweep * t;
      return [-Math.sin(angle) * curve.r * curve.sweep, Math.cos(angle) * curve.r * curve.sweep];
    }
    case 'ellipse': {
      const theta = curve.a0 + curve.sweep * t;
      const local: Vec2 = [-curve.rx * Math.sin(theta), curve.ry * Math.cos(theta)];
      return scale(rotate(local, curve.rot), curve.sweep);
    }
    case 'bezier': {
      if (curve.segs.length === 0) return [0, 0];
      const { i, s } = locate(curve, t);
      return scale(bezierDeriv(curve.segs[i]!, s), curve.segs.length);
    }
  }
}

function secondAt(curve: Curve2, t: number): Vec2 {
  switch (curve.kind) {
    case 'line':
      return [0, 0];
    case 'arc': {
      const angle = curve.a0 + curve.sweep * t;
      const k = curve.r * curve.sweep * curve.sweep;
      return [-Math.cos(angle) * k, -Math.sin(angle) * k];
    }
    case 'ellipse': {
      const theta = curve.a0 + curve.sweep * t;
      const local: Vec2 = [-curve.rx * Math.cos(theta), -curve.ry * Math.sin(theta)];
      return scale(rotate(local, curve.rot), curve.sweep * curve.sweep);
    }
    case 'bezier': {
      if (curve.segs.length === 0) return [0, 0];
      const { i, s } = locate(curve, t);
      const n = curve.segs.length;
      return scale(bezierSecond(curve.segs[i]!, s), n * n);
    }
  }
}

/** Unit tangent in the direction of increasing `t`. */
export function tangentAt(curve: Curve2, t: number): Vec2 {
  if (curve.kind === 'line') return normalize(sub(curve.b, curve.a));
  if (curve.kind === 'arc') {
    const angle = curve.a0 + curve.sweep * t;
    const s = Math.sign(curve.sweep) || 1;
    return [-Math.sin(angle) * s, Math.cos(angle) * s];
  }
  const d = derivAt(curve, t);
  if (len(d) > 1e-12) return normalize(d);
  // Degenerate derivative (coincident Bézier control points): look a little further along.
  const h = 1e-6;
  const a = pointAt(curve, Math.max(0, t - h));
  const b = pointAt(curve, Math.min(1, t + h));
  if (dist(a, b) > 0) return normalize(sub(b, a));
  const s2 = secondAt(curve, t);
  return len(s2) > 0 ? normalize(t >= 1 ? scale(s2, -1) : s2) : [1, 0];
}

/** Signed curvature at `t` in the direction of increasing `t` (left turn positive). */
export function curvatureAt(curve: Curve2, t: number): number {
  if (curve.kind === 'line') return 0;
  if (curve.kind === 'arc') return (Math.sign(curve.sweep) || 1) / curve.r;
  let d = derivAt(curve, t);
  let s2 = secondAt(curve, t);
  if (len(d) < 1e-9) {
    const tt = t >= 1 ? t - 1e-4 : t + 1e-4;
    d = derivAt(curve, tt);
    s2 = secondAt(curve, tt);
  }
  const l = len(d);
  return l > 1e-12 ? cross(d, s2) / (l * l * l) : 0;
}

/** Signed curvature at the start (kept for callers comparing curves at a shared vertex). */
export function curvatureOf(curve: Curve2): number {
  return curvatureAt(curve, 0);
}

export function curveLength(curve: Curve2): number {
  if (curve.kind === 'line') return dist(curve.a, curve.b);
  if (curve.kind === 'arc') return Math.abs(curve.sweep) * curve.r;
  const pts = sampleCurve(curve);
  let total = 0;
  for (let i = 0; i + 1 < pts.length; i += 1) total += dist(pts[i]!, pts[i + 1]!);
  return total;
}

export function isFullCircle(curve: Curve2): boolean {
  return curve.kind === 'arc' && Math.abs(Math.abs(curve.sweep) - TAU) < 1e-12;
}

/** A closed curve without end points (full circle, full ellipse, closed Bézier chain). */
export function isClosedCurve(curve: Curve2): boolean {
  if (curve.kind === 'arc' || curve.kind === 'ellipse') {
    return Math.abs(Math.abs(curve.sweep) - TAU) < 1e-12;
  }
  if (curve.kind === 'bezier') {
    if (curve.segs.length === 0) return false;
    const first = curve.segs[0]![0]!;
    const lastSeg = curve.segs[curve.segs.length - 1]!;
    const last = lastSeg[lastSeg.length - 1]!;
    const box = curveBox(curve);
    return dist(first, last) <= 1e-9 * Math.max(1, box[2] - box[0], box[3] - box[1]);
  }
  return false;
}

/** The part of `curve` between parameters `t0` and `t1` (reparametrized to [0, 1]). */
export function subCurve(curve: Curve2, t0: number, t1: number): Curve2 {
  switch (curve.kind) {
    case 'line':
      return { kind: 'line', a: pointAt(curve, t0), b: pointAt(curve, t1) };
    case 'arc':
    case 'ellipse':
      return { ...curve, a0: curve.a0 + curve.sweep * t0, sweep: curve.sweep * (t1 - t0) };
    case 'bezier': {
      if (t1 > 1 + 1e-12 && isClosedCurve(curve)) {
        const head = subCurve(curve, t0, 1) as Bezier2;
        const tail = subCurve(curve, 0, t1 - 1) as Bezier2;
        return { kind: 'bezier', segs: [...head.segs, ...tail.segs] };
      }
      const n = curve.segs.length;
      const a = Math.max(0, Math.min(1, t0)) * n;
      const b = Math.max(0, Math.min(1, t1)) * n;
      const segs: BezierSegment[] = [];
      for (let i = Math.floor(a); i < Math.min(n, Math.ceil(b)); i += 1) {
        const s0 = Math.max(0, a - i);
        const s1 = Math.min(1, b - i);
        if (s1 - s0 <= 1e-12) continue;
        segs.push(bezierRange(curve.segs[i]!, s0, s1));
      }
      if (segs.length === 0) {
        const p = pointAt(curve, t0);
        segs.push([p, p]);
      }
      return { kind: 'bezier', segs };
    }
  }
}

export function reverseCurve(curve: Curve2): Curve2 {
  switch (curve.kind) {
    case 'line':
      return { kind: 'line', a: curve.b, b: curve.a };
    case 'arc':
    case 'ellipse':
      return { ...curve, a0: curve.a0 + curve.sweep, sweep: -curve.sweep };
    case 'bezier':
      return { kind: 'bezier', segs: [...curve.segs].reverse().map((s) => [...s].reverse()) };
  }
}

/** Parametric angle of a point on (the carrier of) an ellipse. */
export function ellipseAngle(e: { c: Vec2; rx: number; ry: number; rot: number }, p: Vec2): number {
  const local = rotate(sub(p, e.c), -e.rot);
  return Math.atan2(local[1] / (e.ry || 1), local[0] / (e.rx || 1));
}

function angularParam(curve: Arc2 | Ellipse2, angle: number): number {
  const s = Math.sign(curve.sweep) || 1;
  const along = normAngle((angle - curve.a0) * s);
  const t = along / Math.abs(curve.sweep);
  if (Math.abs(Math.abs(curve.sweep) - TAU) < 1e-12) return t >= 1 - 1e-12 ? 0 : t;
  // Points slightly before the start come out near 2π: map them to small negatives.
  const beyond = (TAU - along) / Math.abs(curve.sweep);
  return t > 1 && beyond < t - 1 ? -beyond : t;
}

/**
 * Parameter of a point assumed to lie on (the carrier of) `curve`: projected
 * onto the segment line, the angle along the (elliptical) arc, or the
 * closest parameter of a Bézier chain. For a full circle the result is in
 * `[0, 1)`; for a partial arc it may be outside `[0, 1]` when the point is
 * off the arc.
 */
export function paramOf(curve: Curve2, p: Vec2): number {
  switch (curve.kind) {
    case 'line': {
      const d = sub(curve.b, curve.a);
      const l2 = dot(d, d);
      return l2 === 0 ? 0 : dot(sub(p, curve.a), d) / l2;
    }
    case 'arc':
      return angularParam(curve, Math.atan2(p[1] - curve.c[1], p[0] - curve.c[0]));
    case 'ellipse':
      return angularParam(curve, ellipseAngle(curve, p));
    case 'bezier':
      return closestParamNumeric(curve, p);
  }
}

/** Parameter samples of a curve (for numeric closest point / intersections). */
function paramSamples(curve: Curve2): number[] {
  const n =
    curve.kind === 'bezier'
      ? curve.segs.reduce((sum, s) => sum + (s.length <= 2 ? 1 : 16), 0)
      : curve.kind === 'ellipse'
        ? Math.max(8, Math.ceil((Math.abs(curve.sweep) / TAU) * 96))
        : curve.kind === 'arc'
          ? Math.max(4, Math.ceil((Math.abs(curve.sweep) / TAU) * 64))
          : 1;
  if (curve.kind !== 'bezier') return Array.from({ length: n + 1 }, (_, i) => i / n);
  const out: number[] = [];
  const count = curve.segs.length;
  curve.segs.forEach((seg, i) => {
    const k = seg.length <= 2 ? 1 : 16;
    for (let j = 0; j < k; j += 1) out.push((i + j / k) / count);
  });
  out.push(1);
  return out;
}

/** Closest parameter on a curve by sampling and Newton refinement (clamped to [0, 1]). */
function closestParamNumeric(curve: Curve2, p: Vec2): number {
  const ts = paramSamples(curve);
  let best = 0;
  let bestD = Infinity;
  for (const t of ts) {
    const d = dist(pointAt(curve, t), p);
    if (d < bestD) {
      bestD = d;
      best = t;
    }
  }
  let t = best;
  const step = 1 / Math.max(1, ts.length - 1);
  for (let k = 0; k < 30; k += 1) {
    const q = pointAt(curve, t);
    const d1 = derivAt(curve, t);
    const d2 = secondAt(curve, t);
    const r = sub(q, p);
    const f = dot(r, d1);
    const fp = dot(d1, d1) + dot(r, d2);
    if (Math.abs(fp) < 1e-18) break;
    let next = t - f / fp;
    if (next < best - step) next = best - step;
    if (next > best + step) next = best + step;
    next = Math.min(1, Math.max(0, next));
    if (Math.abs(next - t) < 1e-14) {
      t = next;
      break;
    }
    t = next;
  }
  return dist(pointAt(curve, t), p) <= bestD ? t : best;
}

/** Closest point on the curve (clamped to its extent) and its parameter. */
export function closestOnCurve(
  curve: Curve2,
  p: Vec2,
): { t: number; point: Vec2; distance: number } {
  let t: number;
  if (curve.kind === 'line') {
    t = Math.min(1, Math.max(0, paramOf(curve, p)));
  } else if (curve.kind === 'arc') {
    if (isFullCircle(curve)) {
      t = paramOf(curve, p);
    } else {
      const raw = paramOf(curve, p);
      if (raw >= 0 && raw <= 1) t = raw;
      else t = dist(pointAt(curve, 0), p) < dist(pointAt(curve, 1), p) ? 0 : 1;
    }
  } else {
    t = closestParamNumeric(curve, p);
  }
  const point = pointAt(curve, t);
  return { t, point, distance: dist(point, p) };
}

/** Axis-aligned bounding box `[minX, minY, maxX, maxY]` (conservative for curves). */
export function curveBox(curve: Curve2): [number, number, number, number] {
  let pts: Vec2[];
  if (curve.kind === 'line') pts = [curve.a, curve.b];
  else if (curve.kind === 'arc') {
    pts = [
      [curve.c[0] - curve.r, curve.c[1] - curve.r],
      [curve.c[0] + curve.r, curve.c[1] + curve.r],
    ];
  } else if (curve.kind === 'ellipse') {
    const r = Math.max(curve.rx, curve.ry);
    pts = [
      [curve.c[0] - r, curve.c[1] - r],
      [curve.c[0] + r, curve.c[1] + r],
    ];
  } else pts = curve.segs.flat();
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const p of pts) {
    x0 = Math.min(x0, p[0]);
    y0 = Math.min(y0, p[1]);
    x1 = Math.max(x1, p[0]);
    y1 = Math.max(y1, p[1]);
  }
  return [x0, y0, x1, y1];
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
 * the overlap so both can be split there. Elliptical arcs and Bézier chains
 * are intersected numerically (polyline candidates refined by Newton).
 */
export function intersectCurves(c1: Curve2, c2: Curve2, eps = EPS): Intersection[] {
  if (c1.kind === 'line' && c2.kind === 'line') return intersectLines(c1, c2, eps);
  if (c1.kind === 'line' && c2.kind === 'arc') return intersectLineArc(c1, c2, eps);
  if (c1.kind === 'arc' && c2.kind === 'line') {
    return intersectLineArc(c2, c1, eps).map((i) => ({ t1: i.t2, t2: i.t1, point: i.point }));
  }
  if (c1.kind === 'arc' && c2.kind === 'arc') return intersectArcs(c1, c2, eps);
  return intersectNumeric(c1, c2, eps);
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

function arcParamIfOn(arc: Arc2, p: Vec2, eps: number): number | null {
  const t = paramOf(arc, p);
  const tolT = eps / Math.max(eps, arc.r * Math.abs(arc.sweep));
  if (isFullCircle(arc)) return t;
  return inRange(t, tolT) ? clamp01(t) : null;
}

function intersectLineArc(
  line: Extract<Curve2, { kind: 'line' }>,
  arc: Arc2,
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

function intersectArcs(a1: Arc2, a2: Arc2, eps: number): Intersection[] {
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

function boxesOverlap(
  a: readonly [number, number, number, number],
  b: readonly [number, number, number, number],
  pad: number,
): boolean {
  return a[0] <= b[2] + pad && b[0] <= a[2] + pad && a[1] <= b[3] + pad && b[1] <= a[3] + pad;
}

/** Wraps a parameter of a closed curve into [0, 1); clamps an open one. */
function normalizeParam(curve: Curve2, t: number): number {
  if (isClosedCurve(curve)) {
    const r = t - Math.floor(t);
    return r >= 1 - 1e-12 ? 0 : r;
  }
  return t;
}

/** Newton refinement of an intersection candidate `(t1, t2)`. */
function refineIntersection(c1: Curve2, c2: Curve2, t1: number, t2: number): [number, number] {
  for (let k = 0; k < 25; k += 1) {
    const f = sub(pointAt(c1, t1), pointAt(c2, t2));
    if (len(f) < 1e-13) break;
    const d1 = derivAt(c1, t1);
    const d2 = derivAt(c2, t2);
    // Solve [d1, -d2] · [dt1, dt2]ᵀ = -f.
    const det = -d1[0] * d2[1] + d2[0] * d1[1];
    if (Math.abs(det) < 1e-18) break;
    const dt1 = (-f[0] * -d2[1] - -d2[0] * -f[1]) / det;
    const dt2 = (d1[0] * -f[1] - d1[1] * -f[0]) / det;
    t1 = normalizeParam(c1, t1 + dt1);
    t2 = normalizeParam(c2, t2 + dt2);
    if (!isClosedCurve(c1)) t1 = Math.min(1.05, Math.max(-0.05, t1));
    if (!isClosedCurve(c2)) t2 = Math.min(1.05, Math.max(-0.05, t2));
    if (Math.abs(dt1) + Math.abs(dt2) < 1e-15) break;
  }
  return [t1, t2];
}

function intersectNumeric(c1: Curve2, c2: Curve2, eps: number): Intersection[] {
  const b1 = curveBox(c1);
  const b2 = curveBox(c2);
  if (!boxesOverlap(b1, b2, eps)) return [];
  const out: Intersection[] = [];
  const accept = (t1: number, t2: number) => {
    const closed1 = isClosedCurve(c1);
    const closed2 = isClosedCurve(c2);
    const tol1 = eps / Math.max(eps, curveLength(c1));
    const tol2 = eps / Math.max(eps, curveLength(c2));
    if (!closed1 && !inRange(t1, tol1)) return;
    if (!closed2 && !inRange(t2, tol2)) return;
    const u1 = closed1 ? normalizeParam(c1, t1) : clamp01(t1);
    const u2 = closed2 ? normalizeParam(c2, t2) : clamp01(t2);
    const p1 = pointAt(c1, u1);
    if (dist(p1, pointAt(c2, u2)) > eps * 10) return;
    if (out.some((o) => dist(o.point, p1) < eps * 10)) return;
    out.push({ t1: u1, t2: u2, point: p1 });
  };
  // End points lying on the other curve (T-junctions, shared vertices).
  const ends = (c: Curve2): number[] => (isClosedCurve(c) ? [] : [0, 1]);
  for (const t of ends(c1)) {
    const p = pointAt(c1, t);
    const hit = closestOnCurve(c2, p);
    if (hit.distance < eps) accept(t, hit.t);
  }
  for (const t of ends(c2)) {
    const p = pointAt(c2, t);
    const hit = closestOnCurve(c1, p);
    if (hit.distance < eps) accept(hit.t, t);
  }
  // Crossings of the polyline approximations, refined on the curves.
  const s1 = paramSamples(c1);
  const s2 = paramSamples(c2);
  const p1 = s1.map((t) => pointAt(c1, t));
  const p2 = s2.map((t) => pointAt(c2, t));
  const pad = Math.max(
    eps,
    1e-3 * Math.max(b1[2] - b1[0], b1[3] - b1[1], b2[2] - b2[0], b2[3] - b2[1]),
  );
  for (let i = 0; i + 1 < p1.length; i += 1) {
    const a0 = p1[i]!;
    const a1 = p1[i + 1]!;
    const boxA: [number, number, number, number] = [
      Math.min(a0[0], a1[0]),
      Math.min(a0[1], a1[1]),
      Math.max(a0[0], a1[0]),
      Math.max(a0[1], a1[1]),
    ];
    if (!boxesOverlap(boxA, b2, pad)) continue;
    for (let j = 0; j + 1 < p2.length; j += 1) {
      const q0 = p2[j]!;
      const q1 = p2[j + 1]!;
      const boxB: [number, number, number, number] = [
        Math.min(q0[0], q1[0]),
        Math.min(q0[1], q1[1]),
        Math.max(q0[0], q1[0]),
        Math.max(q0[1], q1[1]),
      ];
      if (!boxesOverlap(boxA, boxB, pad)) continue;
      const da = sub(a1, a0);
      const db = sub(q1, q0);
      const denom = cross(da, db);
      if (Math.abs(denom) < 1e-18) continue;
      const w = sub(q0, a0);
      const u = cross(w, db) / denom;
      const v = cross(w, da) / denom;
      if (u < -0.05 || u > 1.05 || v < -0.05 || v > 1.05) continue;
      const t1 = s1[i]! + (s1[i + 1]! - s1[i]!) * clamp01(u);
      const t2 = s2[j]! + (s2[j + 1]! - s2[j]!) * clamp01(v);
      const [r1, r2] = refineIntersection(c1, c2, t1, t2);
      accept(r1, r2);
    }
  }
  return out;
}

/** 4-point Gauss–Legendre nodes/weights on [0, 1]. */
const GL: readonly (readonly [number, number])[] = [
  [0.5 - 0.5 * 0.8611363115940526, 0.5 * 0.3478548451374538],
  [0.5 - 0.5 * 0.3399810435848563, 0.5 * 0.6521451548625461],
  [0.5 + 0.5 * 0.3399810435848563, 0.5 * 0.6521451548625461],
  [0.5 + 0.5 * 0.8611363115940526, 0.5 * 0.3478548451374538],
];

/**
 * Signed area contribution `½∮(x dy − y dx)` of a curve traversed with
 * increasing `t`; summing over a closed loop gives its signed area
 * (counter-clockwise positive). Exact for every curve kind.
 */
export function areaTerm(curve: Curve2): number {
  switch (curve.kind) {
    case 'line':
      return 0.5 * (curve.a[0] * curve.b[1] - curve.b[0] * curve.a[1]);
    case 'arc': {
      const { c, r, a0, sweep } = curve;
      const a1 = a0 + sweep;
      return (
        0.5 *
        (r * c[0] * (Math.sin(a1) - Math.sin(a0)) -
          r * c[1] * (Math.cos(a1) - Math.cos(a0)) +
          r * r * sweep)
      );
    }
    case 'ellipse': {
      const p0 = sub(pointAt(curve, 0), curve.c);
      const p1 = sub(pointAt(curve, 1), curve.c);
      return (
        0.5 *
        (curve.c[0] * (p1[1] - p0[1]) -
          curve.c[1] * (p1[0] - p0[0]) +
          curve.rx * curve.ry * curve.sweep)
      );
    }
    case 'bezier': {
      // x·y' − y·x' is a polynomial of degree ≤ 5 per cubic segment: 4-point Gauss is exact.
      let sum = 0;
      for (const seg of curve.segs) {
        for (const [s, w] of GL) {
          const p = bezierPoint(seg, s);
          const d = bezierDeriv(seg, s);
          sum += w * (p[0] * d[1] - p[1] * d[0]);
        }
      }
      return 0.5 * sum;
    }
  }
}

/** Polyline approximation of a curve (first and last point included). */
export function sampleCurve(curve: Curve2, maxAngleStep = Math.PI / 48): Vec2[] {
  switch (curve.kind) {
    case 'line':
      return [curve.a, curve.b];
    case 'arc':
    case 'ellipse': {
      const n = Math.max(2, Math.ceil(Math.abs(curve.sweep) / maxAngleStep));
      const out: Vec2[] = [];
      for (let i = 0; i <= n; i += 1) out.push(pointAt(curve, i / n));
      return out;
    }
    case 'bezier': {
      const out: Vec2[] = [];
      curve.segs.forEach((seg, i) => {
        const k = seg.length <= 2 ? 1 : 16;
        for (let j = i === 0 ? 0 : 1; j <= k; j += 1) out.push(bezierPoint(seg, j / k));
      });
      return out;
    }
  }
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

/** Ellipse parameters (centre, radii along the major/minor points, rotation) of ellipse points. */
export function ellipseOf(
  c: Vec2,
  major: Vec2,
  minor: Vec2,
): { c: Vec2; rx: number; ry: number; rot: number } {
  const d = sub(major, c);
  return { c, rx: len(d), ry: len(sub(minor, c)), rot: Math.atan2(d[1], d[0]) };
}

/** Bézier segments of a spline entity (empty when its points are missing). */
export function splineSegments(
  map: ReadonlyMap<string, SketchEntity>,
  entity: Extract<SketchCurve, { kind: 'spline' }>,
): BezierSegment[] {
  const pts: Vec2[] = [];
  for (const id of entity.points) {
    const p = pointPos(map, id);
    if (!p) return [];
    pts.push(p);
  }
  if (pts.length < 2) return [];
  if (entity.mode === 'control') return bsplineToBeziers(pts, entity.degree ?? 3, entity.knots);
  const handle = (id: string | null | undefined): Vec2 | null => (id ? pointPos(map, id) : null);
  return fitSplineBeziers(pts, [handle(entity.handles?.[0]), handle(entity.handles?.[1])]);
}

/** Closed glyph contours of a text entity in sketch coordinates. */
export function textContours(
  map: ReadonlyMap<string, SketchEntity>,
  entity: SketchText,
): BezierSegment[][] {
  const anchor = pointPos(map, entity.anchor);
  if (!anchor) return [];
  return placeContours(parseOutline(entity.outline), anchor, entity.height, entity.angle);
}

/**
 * The curve of a single-curve sketch entity (line, circle, arc, ellipse,
 * elliptical arc, spline; arcs counter-clockwise start → end). Text yields
 * several curves: see {@link entityCurves}.
 */
export function entityCurve(
  map: ReadonlyMap<string, SketchEntity>,
  entity: SketchCurve,
): Curve2 | null {
  switch (entity.kind) {
    case 'line': {
      const a = pointPos(map, entity.a);
      const b = pointPos(map, entity.b);
      return a && b ? { kind: 'line', a, b } : null;
    }
    case 'circle': {
      const c = pointPos(map, entity.center);
      return c ? { kind: 'arc', c, r: entity.radius, a0: 0, sweep: TAU } : null;
    }
    case 'arc': {
      const c = pointPos(map, entity.center);
      const s = pointPos(map, entity.start);
      const e = pointPos(map, entity.end);
      if (!c || !s || !e) return null;
      const a0 = Math.atan2(s[1] - c[1], s[0] - c[0]);
      const a1 = Math.atan2(e[1] - c[1], e[0] - c[0]);
      let sweep = normAngle(a1 - a0);
      if (sweep < 1e-12) sweep = TAU;
      return { kind: 'arc', c, r: radiusOf(map, entity), a0, sweep };
    }
    case 'ellipse':
    case 'ellipticArc': {
      const c = pointPos(map, entity.center);
      const major = pointPos(map, entity.major);
      const minor = pointPos(map, entity.minor);
      if (!c || !major || !minor) return null;
      const e = ellipseOf(c, major, minor);
      if (!(e.rx > 0) || !(e.ry > 0)) return null;
      if (entity.kind === 'ellipse') return { kind: 'ellipse', ...e, a0: 0, sweep: TAU };
      const s = pointPos(map, entity.start);
      const t = pointPos(map, entity.end);
      if (!s || !t) return null;
      const a0 = ellipseAngle(e, s);
      let sweep = normAngle(ellipseAngle(e, t) - a0);
      if (sweep < 1e-12) sweep = TAU;
      return { kind: 'ellipse', ...e, a0, sweep };
    }
    case 'spline': {
      const segs = splineSegments(map, entity);
      return segs.length > 0 ? { kind: 'bezier', segs } : null;
    }
    case 'text':
      return null;
  }
}

/**
 * Every curve of an entity with its curve id: the entity id itself, or
 * `<textId>.<n>` for the n-th glyph contour of a text.
 */
export function entityCurves(
  map: ReadonlyMap<string, SketchEntity>,
  entity: SketchCurve,
): { id: string; curve: Curve2 }[] {
  if (entity.kind === 'text') {
    return textContours(map, entity).map((segs, n) => ({
      id: `${entity.id}.${n}`,
      curve: { kind: 'bezier', segs },
    }));
  }
  const curve = entityCurve(map, entity);
  return curve ? [{ id: entity.id, curve }] : [];
}

/** Entity id of a curve id (`t1.3` → `t1`). */
export function entityIdOfCurve(curveId: string): string {
  const dot = curveId.indexOf('.');
  return dot < 0 ? curveId : curveId.slice(0, dot);
}

/**
 * All curves of a sketch (construction included unless excluded). `id` is
 * the curve id (region keys, face names), `entityId` the entity it belongs
 * to (selection) — equal except for text glyph contours.
 */
export function sketchCurves(
  sketch: Pick<SketchData, 'entities'>,
  options: { includeConstruction?: boolean; includeText?: boolean } = {},
): { id: string; entityId: string; entity: SketchCurve; curve: Curve2 }[] {
  const map = entityMap(sketch);
  const out: { id: string; entityId: string; entity: SketchCurve; curve: Curve2 }[] = [];
  for (const entity of sketch.entities) {
    if (entity.kind === 'point') continue;
    if (entity.construction && !options.includeConstruction) continue;
    if (entity.kind === 'text' && options.includeText === false) continue;
    for (const { id, curve } of entityCurves(map, entity)) {
      out.push({ id, entityId: entity.id, entity, curve });
    }
  }
  return out;
}
