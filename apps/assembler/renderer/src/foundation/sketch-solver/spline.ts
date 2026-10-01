/**
 * Spline math for sketches (pure, no DOM, no kernel): clamped B-splines of
 * degree ≤ 3 given by their control polygon, C2 cubic interpolation through
 * fit points with optional end tangent handles, and the conversion of both
 * into a chain of Bézier segments — the one curve form the rest of the
 * sketch code (regions, trimming, hit testing) and the kernel (OCCT Bézier
 * edges) work with, so both see exactly the same geometry.
 *
 * References: Piegl & Tiller, "The NURBS Book" (knot insertion, A5.1);
 * the C2 cubic interpolation is the classic tridiagonal tangent system with
 * chord-length parameters.
 */
import type { Vec2 } from './types.js';

/** A Bézier segment: 2 (line), 3 (quadratic) or 4 (cubic) control points. */
export type BezierSegment = Vec2[];

/** Degree actually used for a control-point spline with `poles` control points. */
export function splineDegree(poles: number, requested = 3): number {
  return Math.max(1, Math.min(requested, poles - 1));
}

/** Clamped uniform knot vector for `n` poles of `degree`. */
export function uniformKnots(n: number, degree: number): number[] {
  const inner = n - degree - 1;
  const knots: number[] = [];
  for (let i = 0; i <= degree; i += 1) knots.push(0);
  for (let i = 1; i <= inner; i += 1) knots.push(i / (inner + 1));
  for (let i = 0; i <= degree; i += 1) knots.push(1);
  return knots;
}

/** `true` if `knots` is a valid clamped, non-decreasing knot vector for `n` poles of `degree`. */
export function validKnots(knots: readonly number[], n: number, degree: number): boolean {
  if (knots.length !== n + degree + 1) return false;
  for (let i = 1; i < knots.length; i += 1) {
    if (!(knots[i]! >= knots[i - 1]!) || !Number.isFinite(knots[i]!)) return false;
  }
  for (let i = 1; i <= degree; i += 1) {
    if (knots[i] !== knots[0] || knots[knots.length - 1 - i] !== knots[knots.length - 1]) {
      return false;
    }
  }
  return knots[knots.length - 1]! > knots[0]!;
}

/**
 * Boehm knot insertion (The NURBS Book A5.1, one insertion): inserts `u`
 * once into a clamped B-spline, returning the new poles and knots.
 */
function insertKnot(
  poles: readonly Vec2[],
  knots: readonly number[],
  degree: number,
  u: number,
): { poles: Vec2[]; knots: number[] } {
  let k = degree;
  while (k + 1 < knots.length - degree - 1 && knots[k + 1]! <= u) k += 1;
  const next: Vec2[] = [];
  for (let i = 0; i <= k - degree; i += 1) next.push(poles[i]!);
  for (let i = k - degree + 1; i <= k; i += 1) {
    const denom = knots[i + degree]! - knots[i]!;
    const a = denom === 0 ? 0 : (u - knots[i]!) / denom;
    const p = poles[i - 1]!;
    const q = poles[i]!;
    next.push([(1 - a) * p[0] + a * q[0], (1 - a) * p[1] + a * q[1]]);
  }
  for (let i = k; i < poles.length; i += 1) next.push(poles[i]!);
  return { poles: next, knots: [...knots.slice(0, k + 1), u, ...knots.slice(k + 1)] };
}

/**
 * Bézier decomposition of a clamped B-spline: every interior knot is
 * raised to multiplicity `degree`, then each span's `degree + 1` poles are
 * one Bézier segment.
 */
export function bsplineToBeziers(
  poles: readonly Vec2[],
  degree: number,
  knots?: readonly number[],
): BezierSegment[] {
  if (poles.length < 2) return [];
  const p = splineDegree(poles.length, degree);
  let kv = knots && validKnots(knots, poles.length, p) ? [...knots] : uniformKnots(poles.length, p);
  let ps: Vec2[] = poles.map((q) => [q[0], q[1]]);
  const first = kv[0]!;
  const last = kv[kv.length - 1]!;
  const interior = [...new Set(kv.filter((u) => u > first && u < last))];
  for (const u of interior) {
    let multiplicity = kv.filter((k) => k === u).length;
    while (multiplicity < p) {
      ({ poles: ps, knots: kv } = insertKnot(ps, kv, p, u));
      multiplicity += 1;
    }
  }
  const segments: BezierSegment[] = [];
  for (let i = 0; i + p < ps.length; i += p) segments.push(ps.slice(i, i + p + 1));
  // Drop zero-length spans (repeated knots at the ends of a split spline).
  return segments.filter((seg) => seg.some((q) => q[0] !== seg[0]![0] || q[1] !== seg[0]![1]));
}

/** Solves a tridiagonal system (Thomas algorithm) for two right-hand sides at once. */
function solveTridiagonal(
  lower: number[],
  diag: number[],
  upper: number[],
  rhs: Vec2[],
): Vec2[] | null {
  const n = diag.length;
  const c = new Array<number>(n).fill(0);
  const d: Vec2[] = rhs.map((r) => [r[0], r[1]]);
  let b = diag[0]!;
  if (Math.abs(b) < 1e-300) return null;
  c[0] = upper[0]! / b;
  d[0] = [d[0]![0] / b, d[0]![1] / b];
  for (let i = 1; i < n; i += 1) {
    b = diag[i]! - lower[i]! * c[i - 1]!;
    if (Math.abs(b) < 1e-300) return null;
    c[i] = (upper[i] ?? 0) / b;
    d[i] = [(d[i]![0] - lower[i]! * d[i - 1]![0]) / b, (d[i]![1] - lower[i]! * d[i - 1]![1]) / b];
  }
  for (let i = n - 2; i >= 0; i -= 1) {
    d[i] = [d[i]![0] - c[i]! * d[i + 1]![0], d[i]![1] - c[i]! * d[i + 1]![1]];
  }
  return d;
}

/**
 * C2 cubic interpolation through `points` (chord-length parameters) as
 * Bézier segments. `handles[0]` / `handles[1]` clamp the start/end: the
 * first segment's second control point / the last segment's third one;
 * `null` is a natural end (zero curvature). Coincident consecutive points
 * are skipped.
 */
export function fitSplineBeziers(
  points: readonly Vec2[],
  handles: readonly [Vec2 | null, Vec2 | null] = [null, null],
): BezierSegment[] {
  const pts: Vec2[] = [];
  for (const p of points) {
    const prev = pts[pts.length - 1];
    if (!prev || Math.hypot(p[0] - prev[0], p[1] - prev[1]) > 1e-9) pts.push([p[0], p[1]]);
  }
  const n = pts.length - 1;
  if (n < 1) return [];
  const h: number[] = [];
  for (let i = 0; i < n; i += 1)
    h.push(Math.hypot(pts[i + 1]![0] - pts[i]![0], pts[i + 1]![1] - pts[i]![1]));
  const sub = (a: Vec2, b: Vec2): Vec2 => [a[0] - b[0], a[1] - b[1]];
  const lower = new Array<number>(n + 1).fill(0);
  const diag = new Array<number>(n + 1).fill(0);
  const upper = new Array<number>(n + 1).fill(0);
  const rhs: Vec2[] = Array.from({ length: n + 1 }, () => [0, 0] as Vec2);
  const [h0, h1] = handles;
  // Start condition.
  if (h0) {
    diag[0] = 1;
    const t = sub(h0, pts[0]!);
    rhs[0] = [(3 * t[0]) / h[0]!, (3 * t[1]) / h[0]!];
  } else {
    diag[0] = 2;
    upper[0] = 1;
    const d = sub(pts[1]!, pts[0]!);
    rhs[0] = [(3 * d[0]) / h[0]!, (3 * d[1]) / h[0]!];
  }
  // Interior C2 conditions.
  for (let i = 1; i < n; i += 1) {
    const hp = h[i - 1]!;
    const hn = h[i]!;
    lower[i] = hn;
    diag[i] = 2 * (hp + hn);
    upper[i] = hp;
    const a = sub(pts[i + 1]!, pts[i]!);
    const b = sub(pts[i]!, pts[i - 1]!);
    rhs[i] = [3 * ((hp / hn) * a[0] + (hn / hp) * b[0]), 3 * ((hp / hn) * a[1] + (hn / hp) * b[1])];
  }
  // End condition.
  if (h1) {
    diag[n] = 1;
    lower[n] = 0;
    const t = sub(pts[n]!, h1);
    rhs[n] = [(3 * t[0]) / h[n - 1]!, (3 * t[1]) / h[n - 1]!];
  } else {
    lower[n] = 1;
    diag[n] = 2;
    const d = sub(pts[n]!, pts[n - 1]!);
    rhs[n] = [(3 * d[0]) / h[n - 1]!, (3 * d[1]) / h[n - 1]!];
  }
  if (n === 1 && !h0 && !h1) {
    // Two points, natural ends: a straight segment.
    return [[pts[0]!, pts[1]!]];
  }
  const tangents = solveTridiagonal(lower, diag, upper, rhs);
  if (!tangents) return [];
  const segments: BezierSegment[] = [];
  for (let i = 0; i < n; i += 1) {
    const p0 = pts[i]!;
    const p1 = pts[i + 1]!;
    const d0 = tangents[i]!;
    const d1 = tangents[i + 1]!;
    const k = h[i]! / 3;
    segments.push([
      p0,
      [p0[0] + d0[0] * k, p0[1] + d0[1] * k],
      [p1[0] - d1[0] * k, p1[1] - d1[1] * k],
      p1,
    ]);
  }
  return segments;
}

/**
 * Default tangent handles for a new fit spline: one third of the chord to
 * the neighbouring fit point along the natural end tangent, so adding the
 * handles leaves the curve's shape as drawn.
 */
export function naturalHandles(points: readonly Vec2[]): [Vec2, Vec2] | null {
  const segs = fitSplineBeziers(points);
  if (segs.length === 0) return null;
  const first = segs[0]!;
  const last = segs[segs.length - 1]!;
  if (first.length !== 4 || last.length !== 4) {
    const a = points[0]!;
    const b = points[points.length - 1]!;
    return [
      [a[0] + (b[0] - a[0]) / 3, a[1] + (b[1] - a[1]) / 3],
      [b[0] - (b[0] - a[0]) / 3, b[1] - (b[1] - a[1]) / 3],
    ];
  }
  return [first[1]!, last[2]!];
}

/**
 * Control polygon + knots (degree 3, interior knots of multiplicity 3) of
 * a Bézier chain — exact, used when a spline is split (trim) and becomes a
 * control-point spline.
 */
export function beziersToBspline(segments: readonly BezierSegment[]): {
  poles: Vec2[];
  knots: number[];
  degree: number;
} {
  const cubic = segments.map(elevateToCubic);
  const poles: Vec2[] = [];
  cubic.forEach((seg, i) => {
    if (i === 0) poles.push(seg[0]!);
    poles.push(seg[1]!, seg[2]!, seg[3]!);
  });
  const n = cubic.length;
  const knots = [0, 0, 0, 0];
  for (let i = 1; i < n; i += 1) knots.push(i / n, i / n, i / n);
  knots.push(1, 1, 1, 1);
  return { poles, knots, degree: 3 };
}

/** Degree elevation of a line/quadratic Bézier to a cubic (exact). */
export function elevateToCubic(seg: BezierSegment): BezierSegment {
  if (seg.length === 4) return seg;
  if (seg.length === 2) {
    const [a, b] = seg as [Vec2, Vec2];
    return [
      a,
      [a[0] + (b[0] - a[0]) / 3, a[1] + (b[1] - a[1]) / 3],
      [a[0] + ((b[0] - a[0]) * 2) / 3, a[1] + ((b[1] - a[1]) * 2) / 3],
      b,
    ];
  }
  const [a, c, b] = seg as [Vec2, Vec2, Vec2];
  return [
    a,
    [a[0] + (2 / 3) * (c[0] - a[0]), a[1] + (2 / 3) * (c[1] - a[1])],
    [b[0] + (2 / 3) * (c[0] - b[0]), b[1] + (2 / 3) * (c[1] - b[1])],
    b,
  ];
}
