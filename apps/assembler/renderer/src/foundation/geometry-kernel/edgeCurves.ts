/**
 * Curve facts of an evaluated edge from its display polyline (pure, no
 * OCCT): the polyline points, the circle through three points and a
 * circular edge's centre and axis. Shared by the modules that read
 * evaluated geometry (direct edits, measuring).
 */
import type { Vec3 } from '../document/document.js';
import type { EdgeInfo } from './types.js';

/** The edge's polyline points (its segments joined). */
export function edgePoints(edge: EdgeInfo): Vec3[] {
  const s = edge.segments;
  const out: Vec3[] = [];
  for (let i = 0; i + 5 < s.length; i += 6) {
    if (out.length === 0) out.push([s[i]!, s[i + 1]!, s[i + 2]!]);
    out.push([s[i + 3]!, s[i + 4]!, s[i + 5]!]);
  }
  return out;
}

/** Circle through three points (centre, radius, unit normal), or `null` if collinear. */
export function circleThrough(
  a: Vec3,
  b: Vec3,
  c: Vec3,
): { center: Vec3; radius: number; normal: Vec3 } | null {
  const ab = sub(b, a);
  const ac = sub(c, a);
  const n = cross(ab, ac);
  const n2 = dot(n, n);
  if (n2 < 1e-18) return null;
  // centre = a + ((|ac|² (n × ab)) + (|ab|² (ac × n))) / (2 |n|²)
  const t1 = cross(n, ab);
  const t2 = cross(ac, n);
  const ab2 = dot(ab, ab);
  const ac2 = dot(ac, ac);
  const center: Vec3 = [
    a[0] + (ac2 * t1[0] + ab2 * t2[0]) / (2 * n2),
    a[1] + (ac2 * t1[1] + ab2 * t2[1]) / (2 * n2),
    a[2] + (ac2 * t1[2] + ab2 * t2[2]) / (2 * n2),
  ];
  const len = Math.hypot(...n);
  return {
    center,
    radius: Math.hypot(...sub(a, center)),
    normal: [n[0] / len, n[1] / len, n[2] / len],
  };
}

/** Centre and axis of a circular edge, from its polyline (three well-spread points). */
export function circleOfEdge(
  edge: EdgeInfo,
): { center: Vec3; radius: number; normal: Vec3 } | null {
  if (edge.curve !== 'circle') return null;
  const points = edgePoints(edge);
  if (points.length < 3) return null;
  const n = points.length;
  const closed = Math.hypot(...sub(points[0]!, points[n - 1]!)) < 1e-6;
  const last = closed ? n - 1 : n;
  return circleThrough(
    points[0]!,
    points[Math.floor(last / 3)]!,
    points[Math.floor((2 * last) / 3)]!,
  );
}

function sub(a: Vec3, b: Vec3): Vec3 {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}

function dot(a: Vec3, b: Vec3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

function cross(a: Vec3, b: Vec3): Vec3 {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}
