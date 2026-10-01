/**
 * Points picked in the viewport for point-based tools (Translate's start
 * and end point, the Scale centre, where a primitive stands): a click on a
 * face or an edge snaps to the nearest point of interest of that geometry —
 * a vertex (edge end), an edge midpoint, a circle's centre, the face's
 * centre — when it is near, else it keeps the clicked point (Shapr3D's
 * snapping on geometry, interaction research §5). Pure; no store, no DOM.
 */
import type { Vec3 } from '../../foundation/document/document.js';
import type { DraftPick } from '../../foundation/commands/draftTools.js';
import type { Body, EdgeInfo, EvaluationResult } from '../../foundation/geometry-kernel/types.js';

/** A snapped point and what it snapped to (for the pill: "vertex", "midpoint", …). */
export interface SnappedPoint {
  point: Vec3;
  snap: 'vertex' | 'midpoint' | 'center' | 'face center' | 'on face' | 'on edge';
}

/** Snap radius relative to the picked geometry's size. */
const SNAP_FRACTION = 0.2;
/** At least this snap radius, mm. */
const MIN_SNAP_MM = 1;

function points(edge: EdgeInfo): Vec3[] {
  const s = edge.segments;
  const out: Vec3[] = [];
  for (let i = 0; i + 2 < s.length; i += 3) out.push([s[i]!, s[i + 1]!, s[i + 2]!]);
  return out;
}

function distance(a: Vec3, b: Vec3): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}

function circleCenter(a: Vec3, b: Vec3, c: Vec3): Vec3 | null {
  const ab: Vec3 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
  const ac: Vec3 = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
  const n = cross(ab, ac);
  const nn = dot(n, n);
  if (nn < 1e-12) return null;
  const t1 = cross(n, ab);
  const t2 = cross(ac, n);
  const k = 1 / (2 * nn);
  const dab = dot(ab, ab);
  const dac = dot(ac, ac);
  return [
    a[0] + (t1[0] * dac + t2[0] * dab) * k,
    a[1] + (t1[1] * dac + t2[1] * dab) * k,
    a[2] + (t1[2] * dac + t2[2] * dab) * k,
  ];
}

/** The points of interest of an edge: its ends, its midpoint, a circle's centre. */
function edgeCandidates(edge: EdgeInfo): SnappedPoint[] {
  const pts = points(edge);
  const out: SnappedPoint[] = [];
  const first = pts[0];
  const last = pts[pts.length - 1];
  const closed = first && last && distance(first, last) < 1e-6;
  if (first) out.push({ point: first, snap: 'vertex' });
  if (last && !closed) out.push({ point: last, snap: 'vertex' });
  if (!closed) out.push({ point: edge.midpoint, snap: 'midpoint' });
  if (edge.curve === 'circle' && pts.length >= 6) {
    const n = pts.length;
    const centre = circleCenter(pts[0]!, pts[Math.floor(n / 3)]!, pts[Math.floor((2 * n) / 3)]!);
    if (centre) out.push({ point: centre, snap: 'center' });
  }
  return out;
}

function nearest(candidates: SnappedPoint[], at: Vec3, radius: number): SnappedPoint | null {
  let best: SnappedPoint | null = null;
  let bestDistance = radius;
  for (const c of candidates) {
    const d = distance(c.point, at);
    if (d <= bestDistance) {
      bestDistance = d;
      best = c;
    }
  }
  return best;
}

/** Closest point of an edge's polyline to a ray. */
function closestOnEdgeToRay(edge: EdgeInfo, ray: { origin: Vec3; direction: Vec3 }): Vec3 | null {
  const pts = points(edge);
  let best: Vec3 | null = null;
  let bestD = Infinity;
  for (let i = 0; i + 1 < pts.length; i += 1) {
    const p = segmentClosestToRay(pts[i]!, pts[i + 1]!, ray);
    const d = rayDistance(p, ray);
    if (d < bestD) {
      bestD = d;
      best = p;
    }
  }
  return best;
}

function segmentClosestToRay(a: Vec3, b: Vec3, ray: { origin: Vec3; direction: Vec3 }): Vec3 {
  const u = sub(b, a);
  const v = normalize(ray.direction);
  const w = sub(a, ray.origin);
  const uu = dot(u, u);
  const uv = dot(u, v);
  const uw = dot(u, w);
  const vw = dot(v, w);
  const denom = uu - uv * uv;
  let s = denom > 1e-12 ? (uv * vw - uw) / denom : 0;
  s = Math.max(0, Math.min(1, s));
  return [a[0] + u[0] * s, a[1] + u[1] * s, a[2] + u[2] * s];
}

function rayDistance(p: Vec3, ray: { origin: Vec3; direction: Vec3 }): number {
  const d = normalize(ray.direction);
  const w = sub(p, ray.origin);
  const along = dot(w, d);
  return Math.hypot(...sub(w, [d[0] * along, d[1] * along, d[2] * along]));
}

function faceSize(body: Body, faceIndex: number): number {
  const face = body.faces[faceIndex]!;
  const pts = face.edgeIndices.flatMap((e) => (body.edges[e] ? points(body.edges[e]) : []));
  if (pts.length === 0) return Math.sqrt(face.area);
  const min: Vec3 = [Infinity, Infinity, Infinity];
  const max: Vec3 = [-Infinity, -Infinity, -Infinity];
  for (const p of pts) {
    for (let i = 0; i < 3; i += 1) {
      min[i] = Math.min(min[i]!, p[i]!);
      max[i] = Math.max(max[i]!, p[i]!);
    }
  }
  return distance(min, max);
}

/**
 * The point a viewport click stands for: on a face, the clicked point
 * snapped to the face's vertices, edge midpoints, circle centres or its
 * centre; on an edge, the point under the pointer snapped to its ends,
 * midpoint or centre. `null` when the click carries no point.
 */
export function snapPickPoint(evaluation: EvaluationResult, pick: DraftPick): SnappedPoint | null {
  if (pick.kind !== 'face' && pick.kind !== 'edge') return null;
  const body = evaluation.bodies.find((b) => b.id === pick.bodyId);
  if (!body) return null;
  if (pick.kind === 'face') {
    const index = body.faces.findIndex((f) => f.key === pick.faceKey);
    const face = body.faces[index];
    if (!face) return null;
    const at = pick.point;
    const candidates: SnappedPoint[] = [
      { point: face.centroid, snap: 'face center' },
      ...face.edgeIndices.flatMap((e) => (body.edges[e] ? edgeCandidates(body.edges[e]) : [])),
    ];
    if (!at) return candidates[0]!;
    const radius = Math.max(MIN_SNAP_MM, faceSize(body, index) * SNAP_FRACTION);
    return nearest(candidates, at, radius) ?? { point: at, snap: 'on face' };
  }
  const edge = body.edges.find((e) => e.key === pick.edgeKey);
  if (!edge) return null;
  const candidates = edgeCandidates(edge);
  const at = pick.ray ? closestOnEdgeToRay(edge, pick.ray) : null;
  if (!at) return candidates.find((c) => c.snap === 'center') ?? candidates[0] ?? null;
  const radius = Math.max(MIN_SNAP_MM, edge.length * SNAP_FRACTION);
  return nearest(candidates, at, radius) ?? { point: at, snap: 'on edge' };
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

function normalize(v: Vec3): Vec3 {
  const len = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / len, v[1] / len, v[2] / len];
}
