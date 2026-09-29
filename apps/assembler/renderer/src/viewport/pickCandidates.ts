/**
 * Overlapping-pick candidates, pure (unit tested): which faces, edges and
 * sketch profiles a click could mean, and whether that is ambiguous enough
 * to ask (Shapr3D's "select from overlapping items" pop-up) instead of
 * silently taking the top-most one.
 *
 * Inputs come from two sources: the picking id buffer (what is visible in a
 * small window around the pointer, nearest pixel first) and a CPU ray cast
 * against the body meshes (faces behind the first hit, edges near the
 * pointer at any depth). Without Select Through only visible geometry is a
 * candidate; with Select Through everything along the ray is.
 */
import type { Body, EdgeInfo, EvaluatedSketch, FaceInfo } from '../kernel/types.js';
import type { SelectionItem } from '../model/store.js';
import { targetKey, type Projector, type ScreenPoint } from './boxSelect.js';
import type { Vec3 } from './math.js';
import type { PickTarget } from './picking.js';

export type CandidateKind = 'face' | 'edge' | 'sketchProfile';

export interface PickCandidate {
  item: Extract<SelectionItem, { kind: CandidateKind }>;
  kind: CandidateKind;
  /** Short type + name line for the pop-up, e.g. "Edge · Line 80 mm". */
  label: string;
  /** Owning item (body or sketch name). */
  owner: string;
  /** `true` when the candidate is hidden behind other geometry at the pointer. */
  occluded: boolean;
}

export interface Ray {
  origin: Vec3;
  direction: Vec3;
}

/** Möller–Trumbore; returns the ray parameter or `null`. Both triangle sides count. */
export function rayTriangle(ray: Ray, a: Vec3, b: Vec3, c: Vec3): number | null {
  const e1: Vec3 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
  const e2: Vec3 = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
  const d = ray.direction;
  const p: Vec3 = [
    d[1] * e2[2] - d[2] * e2[1],
    d[2] * e2[0] - d[0] * e2[2],
    d[0] * e2[1] - d[1] * e2[0],
  ];
  const det = e1[0] * p[0] + e1[1] * p[1] + e1[2] * p[2];
  if (Math.abs(det) < 1e-12) return null;
  const inv = 1 / det;
  const s: Vec3 = [ray.origin[0] - a[0], ray.origin[1] - a[1], ray.origin[2] - a[2]];
  const u = (s[0] * p[0] + s[1] * p[1] + s[2] * p[2]) * inv;
  if (u < 0 || u > 1) return null;
  const q: Vec3 = [
    s[1] * e1[2] - s[2] * e1[1],
    s[2] * e1[0] - s[0] * e1[2],
    s[0] * e1[1] - s[1] * e1[0],
  ];
  const v = (d[0] * q[0] + d[1] * q[1] + d[2] * q[2]) * inv;
  if (v < 0 || u + v > 1) return null;
  const t = (e2[0] * q[0] + e2[1] * q[1] + e2[2] * q[2]) * inv;
  return t > 0 ? t : null;
}

export interface FaceHit {
  bodyId: string;
  faceKey: string;
  t: number;
}

/** Every face the ray passes through (nearest hit per face), nearest first. */
export function rayCastFaces(bodies: readonly Body[], ray: Ray): FaceHit[] {
  const hits: FaceHit[] = [];
  for (const body of bodies) {
    // Cheap reject: ray vs. the body's bounding box (slab test).
    let tMin = -Infinity;
    let tMax = Infinity;
    for (let axis = 0; axis < 3; axis += 1) {
      const o = ray.origin[axis]!;
      const d = ray.direction[axis]!;
      const lo = body.min[axis]! - 1e-6;
      const hi = body.max[axis]! + 1e-6;
      if (Math.abs(d) < 1e-12) {
        if (o < lo || o > hi) tMin = Infinity;
        continue;
      }
      const t1 = (lo - o) / d;
      const t2 = (hi - o) / d;
      tMin = Math.max(tMin, Math.min(t1, t2));
      tMax = Math.min(tMax, Math.max(t1, t2));
    }
    if (tMin > tMax || tMax < 0) continue;
    const { positions, indices, triangleFaces } = body.mesh;
    const nearest = new Map<number, number>();
    const vertex = (i: number): Vec3 => [
      positions[i * 3]!,
      positions[i * 3 + 1]!,
      positions[i * 3 + 2]!,
    ];
    for (let tri = 0; tri < indices.length / 3; tri += 1) {
      const t = rayTriangle(
        ray,
        vertex(indices[tri * 3]!),
        vertex(indices[tri * 3 + 1]!),
        vertex(indices[tri * 3 + 2]!),
      );
      if (t === null) continue;
      const face = triangleFaces[tri]!;
      const previous = nearest.get(face);
      if (previous === undefined || t < previous) nearest.set(face, t);
    }
    for (const [faceIndex, t] of nearest) {
      const face = body.faces[faceIndex];
      if (face) hits.push({ bodyId: body.id, faceKey: face.key, t });
    }
  }
  return hits.sort((a, b) => a.t - b.t);
}

function distanceToSegment(p: ScreenPoint, a: ScreenPoint, b: ScreenPoint): number {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const len2 = dx * dx + dy * dy;
  const t =
    len2 > 0 ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len2)) : 0;
  return Math.hypot(p[0] - (a[0] + dx * t), p[1] - (a[1] + dy * t));
}

export interface EdgeNear {
  bodyId: string;
  edgeKey: string;
  distancePx: number;
}

/** Edges whose projection passes within `tolerancePx` of `point` (any depth), nearest first. */
export function edgesNearPoint(
  bodies: readonly Body[],
  project: Projector,
  point: ScreenPoint,
  tolerancePx: number,
): EdgeNear[] {
  const out: EdgeNear[] = [];
  for (const body of bodies) {
    for (const edge of body.edges) {
      const s = edge.segments;
      let best = Infinity;
      for (let i = 0; i + 5 < s.length; i += 6) {
        const a = project([s[i]!, s[i + 1]!, s[i + 2]!]);
        const b = project([s[i + 3]!, s[i + 4]!, s[i + 5]!]);
        if (!a || !b) continue;
        best = Math.min(best, distanceToSegment(point, a, b));
      }
      if (best <= tolerancePx) out.push({ bodyId: body.id, edgeKey: edge.key, distancePx: best });
    }
  }
  return out.sort((a, b) => a.distancePx - b.distancePx);
}

function round(value: number): string {
  return String(Math.round(value * 100) / 100);
}

export function faceLabel(face: FaceInfo | undefined): string {
  if (!face) return 'Face';
  const kind =
    face.surface === 'plane'
      ? 'Planar'
      : face.surface === 'cylinder'
        ? 'Cylindrical'
        : face.surface === 'cone'
          ? 'Conical'
          : face.surface === 'sphere'
            ? 'Spherical'
            : face.surface === 'torus'
              ? 'Toroidal'
              : 'Curved';
  return `Face · ${kind}, ${round(face.area)} mm²`;
}

export function edgeLabel(edge: EdgeInfo | undefined): string {
  if (!edge) return 'Edge';
  if (edge.curve === 'circle' && edge.radius) {
    const full = Math.abs(edge.length - 2 * Math.PI * edge.radius) < 1e-6 * edge.length + 1e-6;
    return full ? `Edge · Circle Ø${round(edge.radius * 2)}` : `Edge · Arc R${round(edge.radius)}`;
  }
  if (edge.curve === 'line') return `Edge · Line ${round(edge.length)} mm`;
  return `Edge · ${edge.curve === 'ellipse' ? 'Ellipse' : 'Curve'} ${round(edge.length)} mm`;
}

export interface CandidateContext {
  bodies: readonly Body[];
  sketches: readonly EvaluatedSketch[];
  bodyName: (bodyId: string) => string;
  sketchName: (featureId: string) => string;
}

function toCandidate(
  target: PickTarget,
  occluded: boolean,
  ctx: CandidateContext,
): PickCandidate | null {
  if (target.kind === 'face') {
    const body = ctx.bodies.find((b) => b.id === target.bodyId);
    return {
      item: { kind: 'face', bodyId: target.bodyId, faceKey: target.faceKey },
      kind: 'face',
      label: faceLabel(body?.faces.find((f) => f.key === target.faceKey)),
      owner: ctx.bodyName(target.bodyId),
      occluded,
    };
  }
  if (target.kind === 'edge') {
    const body = ctx.bodies.find((b) => b.id === target.bodyId);
    return {
      item: { kind: 'edge', bodyId: target.bodyId, edgeKey: target.edgeKey },
      kind: 'edge',
      label: edgeLabel(body?.edges.find((e) => e.key === target.edgeKey)),
      owner: ctx.bodyName(target.bodyId),
      occluded,
    };
  }
  if (target.kind === 'sketchProfile') {
    return {
      item: {
        kind: 'sketchProfile',
        featureId: target.featureId,
        ...(target.regionKey !== undefined ? { regionKey: target.regionKey } : {}),
      },
      kind: 'sketchProfile',
      label: 'Sketch profile',
      owner: ctx.sketchName(target.featureId),
      occluded,
    };
  }
  return null;
}

export interface CandidateInput {
  /** Distinct pick targets visible around the pointer, nearest pixel first. */
  visible: readonly PickTarget[];
  /** Faces along the pointer ray, nearest first. */
  rayFaces: readonly FaceHit[];
  /** Edges near the pointer at any depth, nearest first. */
  nearEdges: readonly EdgeNear[];
  selectThrough: boolean;
}

/** Candidates at a click, visible ones first (in pointer-distance order), then occluded ones. */
export function collectCandidates(input: CandidateInput, ctx: CandidateContext): PickCandidate[] {
  const out: PickCandidate[] = [];
  const seen = new Set<string>();
  const push = (target: PickTarget, occluded: boolean) => {
    const key = targetKey(target);
    if (seen.has(key)) return;
    const candidate = toCandidate(target, occluded, ctx);
    if (!candidate) return;
    seen.add(key);
    out.push(candidate);
  };
  for (const target of input.visible) push(target, false);
  const hasProfile = out.some((c) => c.kind === 'sketchProfile');
  const hasFace = out.some((c) => c.kind === 'face');
  // A sketch profile lying on a face hides that face in the id buffer: the face below is
  // still a meaningful (coplanar) candidate.
  if (hasProfile && !hasFace && input.rayFaces[0]) {
    push(
      { kind: 'face', bodyId: input.rayFaces[0].bodyId, faceKey: input.rayFaces[0].faceKey },
      false,
    );
  }
  if (input.selectThrough) {
    for (const edge of input.nearEdges) {
      push({ kind: 'edge', bodyId: edge.bodyId, edgeKey: edge.edgeKey }, true);
    }
    for (const face of input.rayFaces) {
      push({ kind: 'face', bodyId: face.bodyId, faceKey: face.faceKey }, true);
    }
  }
  return out;
}

const PRIORITY: Record<CandidateKind, number> = { edge: 3, sketchProfile: 2, face: 1 };

/**
 * `true` when a click is ambiguous: two or more candidates of the kind that
 * would win (two edges within the tolerance, two overlapping profiles), a
 * sketch profile over a face, or any choice at all under Select Through.
 */
export function isAmbiguous(candidates: readonly PickCandidate[], selectThrough: boolean): boolean {
  if (candidates.length < 2) return false;
  if (selectThrough) return true;
  const top = Math.max(...candidates.map((c) => PRIORITY[c.kind]));
  if (candidates.filter((c) => PRIORITY[c.kind] === top).length > 1) return true;
  const kinds = new Set(candidates.map((c) => c.kind));
  return kinds.has('sketchProfile') && kinds.has('face');
}
