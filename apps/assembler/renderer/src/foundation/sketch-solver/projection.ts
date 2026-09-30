/**
 * Project (Shapr3D "Project" into a sketch): body edges, or the boundary
 * of a face, projected along the sketch normal into the sketch plane as
 * reference geometry (construction by default, toggleable).
 *
 * Pure and shared by both ends so they agree:
 * - the app creates a projection from the evaluated bodies (edge
 *   polylines of the tessellation) — {@link addProjection};
 * - the kernel re-derives it on every evaluation from the exact B-rep
 *   through the naming v2 references and moves the projected geometry
 *   when the source moved (associative) — {@link refreshProjections}.
 *   A source that no longer resolves leaves the stored geometry as it was
 *   (frozen) and is reported, as is a source whose projection changed
 *   shape (another number/kind of curves: re-project it).
 *
 * Classification of a projected edge: a line stays a line (an edge along
 * the normal projects to a point and is skipped); a circle or arc in a
 * plane parallel to the sketch stays a circle/arc; anything else (tilted
 * circles, ellipses, splines) becomes a fit spline through points
 * resampled by arc length (a fixed count, so both ends produce the same
 * structure).
 */
import { framePoint, frameUv, type SketchFrame, type Vec3 } from '../document/document.js';
import { SketchBuilder, type EditResult } from './edits.js';
import { circleThrough, dist } from './geometry.js';
import { naturalHandles } from './spline.js';
import {
  entityMap,
  pointPos,
  type SketchData,
  type SketchEntity,
  type SketchProjection,
  type Vec2,
} from './types.js';

/** A sampled source edge: its curve class and a polyline along it (world, in edge order). */
export interface EdgeSample {
  curve: 'line' | 'circle' | 'ellipse' | 'other';
  points: Vec3[];
}

/** One projected curve in sketch coordinates. */
export type ProjectedCurve =
  | { kind: 'line'; a: Vec2; b: Vec2 }
  | { kind: 'circle'; c: Vec2; r: number }
  | { kind: 'arc'; c: Vec2; start: Vec2; end: Vec2 }
  | { kind: 'spline'; points: Vec2[]; closed: boolean };

const SPLINE_OPEN_POINTS = 12;
const SPLINE_CLOSED_POINTS = 16;

function polylineLength(pts: readonly Vec2[]): number {
  let l = 0;
  for (let i = 0; i + 1 < pts.length; i += 1) l += dist(pts[i]!, pts[i + 1]!);
  return l;
}

/** `count` points evenly spaced by arc length along a polyline (ends included). */
function resample(pts: readonly Vec2[], count: number): Vec2[] {
  const total = polylineLength(pts);
  if (total <= 0 || pts.length < 2) return [pts[0] ?? [0, 0]];
  const out: Vec2[] = [pts[0]!];
  let seg = 0;
  let segStart = 0;
  for (let k = 1; k < count - 1; k += 1) {
    const target = (total * k) / (count - 1);
    while (seg + 1 < pts.length - 1 && segStart + dist(pts[seg]!, pts[seg + 1]!) < target) {
      segStart += dist(pts[seg]!, pts[seg + 1]!);
      seg += 1;
    }
    const l = dist(pts[seg]!, pts[seg + 1]!) || 1;
    const t = Math.min(1, Math.max(0, (target - segStart) / l));
    out.push([
      pts[seg]![0] + (pts[seg + 1]![0] - pts[seg]![0]) * t,
      pts[seg]![1] + (pts[seg + 1]![1] - pts[seg]![1]) * t,
    ]);
  }
  out.push(pts[pts.length - 1]!);
  return out;
}

/** Projects one sampled edge into sketch coordinates (`null` when it projects to a point). */
export function projectEdge(sample: EdgeSample, frame: SketchFrame): ProjectedCurve | null {
  const uv = sample.points.map((p): Vec2 => {
    const q = frameUv(frame, p);
    return [q.u, q.v];
  });
  if (uv.length < 2) return null;
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const [x, y] of uv) {
    x0 = Math.min(x0, x);
    y0 = Math.min(y0, y);
    x1 = Math.max(x1, x);
    y1 = Math.max(y1, y);
  }
  const size = Math.max(x1 - x0, y1 - y0);
  const tol = Math.max(1e-6, size * 1e-3);
  if (size < 1e-6) return null;
  const first = uv[0]!;
  const last = uv[uv.length - 1]!;
  const closed = dist(first, last) <= tol;
  if (sample.curve === 'line') {
    return dist(first, last) > 1e-6 ? { kind: 'line', a: first, b: last } : null;
  }
  if (sample.curve === 'circle') {
    const n = uv.length;
    const circle = circleThrough(uv[0]!, uv[Math.floor(n / 3)]!, uv[Math.floor((2 * n) / 3)]!);
    if (circle && uv.every((p) => Math.abs(dist(p, circle.c) - circle.r) <= tol)) {
      if (closed) return { kind: 'circle', c: circle.c, r: circle.r };
      const mid = uv[Math.floor(n / 2)]!;
      const ccw =
        (first[0] - circle.c[0]) * (mid[1] - circle.c[1]) -
          (first[1] - circle.c[1]) * (mid[0] - circle.c[0]) >
        0;
      return ccw
        ? { kind: 'arc', c: circle.c, start: first, end: last }
        : { kind: 'arc', c: circle.c, start: last, end: first };
    }
  }
  const pts = closed ? uv.slice(0, -1).concat([first]) : uv;
  return {
    kind: 'spline',
    points: resample(pts, closed ? SPLINE_CLOSED_POINTS : SPLINE_OPEN_POINTS),
    closed,
  };
}

/** Projects every sampled edge of a source (a face gives its boundary edges). */
export function projectSource(
  samples: readonly EdgeSample[],
  frame: SketchFrame,
): ProjectedCurve[] {
  return samples.map((s) => projectEdge(s, frame)).filter((c): c is ProjectedCurve => c !== null);
}

/** Point positions defining a projected curve, in entity order (see {@link addProjection}). */
function curvePositions(curve: ProjectedCurve): Vec2[] {
  switch (curve.kind) {
    case 'line':
      return [curve.a, curve.b];
    case 'circle':
      return [curve.c];
    case 'arc':
      return [curve.c, curve.start, curve.end];
    case 'spline': {
      const handles = naturalHandles(curve.points) ?? [
        curve.points[0]!,
        curve.points[curve.points.length - 1]!,
      ];
      const pts = curve.closed ? curve.points.slice(0, -1) : curve.points;
      return [...pts, handles[0], handles[1]];
    }
  }
}

/**
 * Adds a projection: points (shared where curve ends meet), curves
 * (construction unless `construction === false`) and the
 * {@link SketchProjection} record. `null` when nothing projects.
 */
export function addProjection(
  sketch: SketchData,
  source: SketchProjection['source'],
  curves: readonly ProjectedCurve[],
  construction = true,
): EditResult | null {
  if (curves.length === 0) return null;
  const b = new SketchBuilder(sketch);
  const shared: { pos: Vec2; id: string }[] = [];
  const pointAt = (pos: Vec2, share: boolean): string => {
    if (share) {
      const found = shared.find((s) => dist(s.pos, pos) < 1e-6);
      if (found) return found.id;
    }
    const id = b.addPoint(pos);
    if (share) shared.push({ pos, id });
    return id;
  };
  const created: string[] = [];
  for (const curve of curves) {
    switch (curve.kind) {
      case 'line':
        created.push(b.addLine(pointAt(curve.a, true), pointAt(curve.b, true), construction));
        break;
      case 'circle':
        created.push(b.addCircle(pointAt(curve.c, false), curve.r, construction));
        break;
      case 'arc':
        created.push(
          b.addArc(
            pointAt(curve.c, false),
            pointAt(curve.start, true),
            pointAt(curve.end, true),
            construction,
          ),
        );
        break;
      case 'spline': {
        const positions = curvePositions(curve);
        const n = curve.closed ? curve.points.length - 1 : curve.points.length;
        const ids: string[] = [];
        for (let i = 0; i < n; i += 1) {
          const end = i === 0 || i === n - 1;
          ids.push(pointAt(positions[i]!, end && !curve.closed));
        }
        if (curve.closed) ids.push(ids[0]!);
        const handles: [string, string] = [
          pointAt(positions[n]!, false),
          pointAt(positions[n + 1]!, false),
        ];
        const id = b.id('s');
        b.entities.push({
          id,
          kind: 'spline',
          mode: 'fit',
          points: ids,
          handles,
          ...(construction ? { construction: true } : {}),
        });
        created.push(id);
        break;
      }
    }
  }
  const projection: SketchProjection = { id: b.id('j'), source, entities: created };
  const result = b.result(created);
  return {
    ...result,
    sketch: { ...result.sketch, projections: [...(sketch.projections ?? []), projection] },
  };
}

/** The projected curve an entity currently describes (for comparing with a new projection). */
function entityShape(e: SketchEntity): ProjectedCurve['kind'] | null {
  if (e.kind === 'line' || e.kind === 'circle' || e.kind === 'arc') return e.kind;
  if (e.kind === 'spline' && e.mode === 'fit') return 'spline';
  return null;
}

/** Point ids of a projected entity in the order of {@link curvePositions}. */
function entityPointIds(e: SketchEntity): string[] {
  switch (e.kind) {
    case 'line':
      return [e.a, e.b];
    case 'circle':
      return [e.center];
    case 'arc':
      return [e.center, e.start, e.end];
    case 'spline': {
      const closed = e.points.length > 1 && e.points[0] === e.points[e.points.length - 1];
      const pts = closed ? e.points.slice(0, -1) : e.points;
      const handles: string[] = [];
      for (const h of e.handles ?? []) if (h !== null) handles.push(h);
      return [...pts, ...handles];
    }
    default:
      return [];
  }
}

export interface ProjectionStatus {
  id: string;
  status: 'ok' | 'frozen' | 'changed';
  /** Why the projection is frozen / needs re-projecting. */
  message?: string;
}

/**
 * Re-derives the geometry of every projection from freshly sampled
 * sources: moves projected points (same structure), or keeps them frozen
 * when a source is missing (`samples` returns a message) or projects to a
 * different structure. Returns the updated sketch data (unchanged object
 * when nothing moved) and a status per projection.
 */
export function refreshProjections(
  sketch: SketchData,
  frame: SketchFrame,
  samples: (projection: SketchProjection) => EdgeSample[] | string,
): { sketch: SketchData; statuses: ProjectionStatus[]; moved: string[] } {
  const projections = sketch.projections ?? [];
  if (projections.length === 0) return { sketch, statuses: [], moved: [] };
  const map = entityMap(sketch);
  const positions = new Map<string, Vec2>();
  const radii = new Map<string, number>();
  const statuses: ProjectionStatus[] = [];
  const moved: string[] = [];
  for (const projection of projections) {
    const sampled = samples(projection);
    if (typeof sampled === 'string') {
      statuses.push({ id: projection.id, status: 'frozen', message: sampled });
      continue;
    }
    const curves = projectSource(sampled, frame);
    const entities = projection.entities.map((id) => map.get(id));
    const sameStructure =
      curves.length === entities.length &&
      curves.every((c, i) => {
        const e = entities[i];
        if (!e || entityShape(e) !== c.kind) return false;
        return entityPointIds(e).length === curvePositions(c).length;
      });
    if (!sameStructure) {
      statuses.push({
        id: projection.id,
        status: 'changed',
        message: 'The projected source changed shape; project it again',
      });
      continue;
    }
    let changed = false;
    curves.forEach((curve, i) => {
      const e = entities[i]!;
      const ids = entityPointIds(e);
      let pos = curvePositions(curve);
      // An edge may come back reversed: keep each end on the nearer point.
      if (curve.kind === 'line' || curve.kind === 'spline') {
        const cur = ids.map((id) => pointPos(map, id));
        const forward = dist(cur[0] ?? [0, 0], pos[0]!);
        const n = curve.kind === 'line' ? 2 : pos.length - 2;
        const reversed = dist(cur[0] ?? [0, 0], pos[n - 1]!);
        if (reversed + 1e-9 < forward) {
          const body = pos.slice(0, n).reverse();
          const handles = pos.slice(n).reverse();
          pos = [...body, ...handles];
        }
      }
      ids.forEach((id, k) => {
        const p = pos[k]!;
        const old = pointPos(map, id);
        if (!old || dist(old, p) > 1e-9) changed = true;
        positions.set(id, p);
      });
      if (curve.kind === 'circle' && e.kind === 'circle') {
        if (Math.abs(e.radius - curve.r) > 1e-9) changed = true;
        radii.set(e.id, curve.r);
      }
    });
    if (changed) moved.push(projection.id);
    statuses.push({ id: projection.id, status: 'ok' });
  }
  if (moved.length === 0) return { sketch, statuses, moved };
  return {
    sketch: {
      ...sketch,
      entities: sketch.entities.map((e) => {
        if (e.kind === 'point') {
          const p = positions.get(e.id);
          return p && (p[0] !== e.x || p[1] !== e.y) ? { ...e, x: p[0], y: p[1] } : e;
        }
        if (e.kind === 'circle') {
          const r = radii.get(e.id);
          return r !== undefined && r !== e.radius ? { ...e, radius: r } : e;
        }
        return e;
      }),
    },
    statuses,
    moved,
  };
}

/** Every entity (curves and their points) that belongs to a projection. */
export function projectedEntities(sketch: SketchData): SketchEntity[] {
  const ids = new Set<string>();
  const map = entityMap(sketch);
  for (const projection of sketch.projections ?? []) {
    for (const id of projection.entities) {
      const e = map.get(id);
      if (!e) continue;
      ids.add(id);
      for (const p of entityPointIds(e)) ids.add(p);
      if (e.kind === 'spline') for (const p of e.points) ids.add(p);
    }
  }
  return sketch.entities.filter((e) => ids.has(e.id));
}

/** Ids of every entity (curves and their points) that belongs to a projection. */
export function projectedIds(sketch: SketchData): Set<string> {
  return new Set(projectedEntities(sketch).map((e) => e.id));
}

/**
 * Adopts kernel-updated projected geometry (moved points / radii) into a
 * sketch, by id. Other entities are untouched; the caller re-solves.
 */
export function adoptProjectedEntities(
  sketch: SketchData,
  updated: readonly SketchEntity[],
): SketchData {
  const byId = new Map(updated.map((e) => [e.id, e]));
  let changed = false;
  const entities = sketch.entities.map((e) => {
    const u = byId.get(e.id);
    if (!u || u.kind !== e.kind) return e;
    if (e.kind === 'point' && u.kind === 'point' && (e.x !== u.x || e.y !== u.y)) {
      changed = true;
      return { ...e, x: u.x, y: u.y };
    }
    if (e.kind === 'circle' && u.kind === 'circle' && e.radius !== u.radius) {
      changed = true;
      return { ...e, radius: u.radius };
    }
    return e;
  });
  return changed ? { ...sketch, entities } : sketch;
}

/** World polyline of an evaluated edge from its tessellation segments (pairs of points). */
export function edgeSampleFromSegments(
  curve: EdgeSample['curve'],
  segments: ArrayLike<number>,
): EdgeSample {
  const points: Vec3[] = [];
  for (let i = 0; i + 5 < segments.length; i += 6) {
    const a: Vec3 = [segments[i]!, segments[i + 1]!, segments[i + 2]!];
    const b: Vec3 = [segments[i + 3]!, segments[i + 4]!, segments[i + 5]!];
    if (points.length === 0) points.push(a);
    points.push(b);
  }
  return { curve, points };
}

/** World position of sketch coordinates (re-export for the overlay's projection preview). */
export function toWorld(frame: SketchFrame, p: Vec2): Vec3 {
  return framePoint(frame, p[0], p[1]);
}
