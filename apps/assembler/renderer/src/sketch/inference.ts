/**
 * Shapr3D-style snapping and auto-constraint inference while drawing, and
 * hit testing of sketch geometry. Pure: works in sketch (u, v) millimetres
 * with the current screen scale (`mmPerPx`) so thresholds are in pixels.
 *
 * Priority: existing points (end/centre/origin) → line midpoints →
 * horizontal/vertical (or perpendicular/parallel to the previous segment)
 * relative to the segment start → alignment guides with other points →
 * on-curve → grid.
 */
import { closestOnCurve, dist, dot, normalize, sketchCurves, sub } from './geometry.js';
import type { SnapTarget } from './edits.js';
import { entityMap, isCurve, ORIGIN_ID, type SketchData, type Vec2 } from './types.js';

export type InferenceHint =
  | 'endpoint'
  | 'center'
  | 'origin'
  | 'midpoint'
  | 'on'
  | 'horizontal'
  | 'vertical'
  | 'perpendicular'
  | 'parallel'
  | 'grid';

export interface Inference extends SnapTarget {
  /** What the cursor snapped to, for the small hint glyphs. */
  hints: InferenceHint[];
  /** Dashed guide lines (alignment with other points, H/V from the segment start). */
  guides: [Vec2, Vec2][];
  /** Auto-constraints for the segment ending here. */
  horizontal?: boolean;
  vertical?: boolean;
  perpendicularTo?: string;
  parallelTo?: string;
}

export interface InferContext {
  /** Millimetres per screen pixel at the cursor. */
  mmPerPx: number;
  /** Start of the segment being drawn (and the previous line of a chain). */
  from?: { pos: Vec2; pointId?: string; lineId?: string };
  /** Grid snapping step, mm (`null`/absent = off). */
  gridStep?: number | null;
  /** Point ids never snapped to (e.g. the points being dragged). */
  exclude?: ReadonlySet<string>;
}

const POINT_PX = 10;
const MIDPOINT_PX = 8;
const CURVE_PX = 6;
const ALIGN_PX = 6;
const ANGLE_TOL = (3 * Math.PI) / 180;

function roleOf(sketch: SketchData, pointId: string): InferenceHint {
  if (pointId === ORIGIN_ID) return 'origin';
  return sketch.entities.some(
    (e) =>
      (e.kind === 'circle' ||
        e.kind === 'arc' ||
        e.kind === 'ellipse' ||
        e.kind === 'ellipticArc') &&
      e.center === pointId,
  )
    ? 'center'
    : 'endpoint';
}

function segmentAngles(from: Vec2, to: Vec2): { horizontal: boolean; vertical: boolean } {
  const d = sub(to, from);
  if (Math.hypot(d[0], d[1]) < 1e-9) return { horizontal: false, vertical: false };
  const a = Math.atan2(d[1], d[0]);
  const off = (target: number) => Math.abs(Math.atan2(Math.sin(a - target), Math.cos(a - target)));
  return {
    horizontal: Math.min(off(0), off(Math.PI)) < ANGLE_TOL,
    vertical: Math.min(off(Math.PI / 2), off(-Math.PI / 2)) < ANGLE_TOL,
  };
}

/** Snaps a raw cursor position and infers auto-constraints. */
export function infer(sketch: SketchData, raw: Vec2, ctx: InferContext): Inference {
  const map = entityMap(sketch);
  const exclude = ctx.exclude ?? new Set<string>();
  const px = ctx.mmPerPx;
  const from = ctx.from;

  const withSegment = (base: Inference): Inference => {
    if (!from || dist(from.pos, base.pos) < 1e-9) return base;
    const { horizontal, vertical } = segmentAngles(from.pos, base.pos);
    const out = { ...base };
    if (horizontal) out.horizontal = true;
    if (vertical) out.vertical = true;
    return out;
  };

  // 1. Existing points (and the origin).
  let bestPoint: { id: string; pos: Vec2; d: number } | null = null;
  const consider = (id: string, pos: Vec2) => {
    if (exclude.has(id) || id === from?.pointId) return;
    const d = dist(pos, raw);
    if (d <= POINT_PX * px && (!bestPoint || d < bestPoint.d)) bestPoint = { id, pos, d };
  };
  // Sketch points first: at equal distance a real point wins over the origin.
  for (const e of sketch.entities) if (e.kind === 'point') consider(e.id, [e.x, e.y]);
  consider(ORIGIN_ID, [0, 0]);
  if (bestPoint) {
    const p = bestPoint as { id: string; pos: Vec2 };
    return withSegment({ pos: p.pos, pointId: p.id, hints: [roleOf(sketch, p.id)], guides: [] });
  }

  // 2. Line midpoints. (Text glyphs are no snap/constraint targets.)
  const curves = sketchCurves(sketch, { includeConstruction: true, includeText: false });
  for (const { id, entity, curve } of curves) {
    if (curve.kind !== 'line' || entity.kind !== 'line') continue;
    if (exclude.has(entity.a) || exclude.has(entity.b)) continue;
    const mid: Vec2 = [(curve.a[0] + curve.b[0]) / 2, (curve.a[1] + curve.b[1]) / 2];
    if (dist(mid, raw) <= MIDPOINT_PX * px) {
      return withSegment({ pos: mid, midpointOf: id, hints: ['midpoint'], guides: [] });
    }
  }

  const hints: InferenceHint[] = [];
  const guides: [Vec2, Vec2][] = [];
  let pos: Vec2 = [raw[0], raw[1]];
  let lockX = false;
  let lockY = false;
  const result: Inference = { pos, hints, guides };

  // 3. Direction relative to the segment start.
  if (from && dist(from.pos, raw) > 4 * px) {
    const { horizontal, vertical } = segmentAngles(from.pos, raw);
    if (horizontal) {
      pos = [raw[0], from.pos[1]];
      lockY = true;
      result.horizontal = true;
      hints.push('horizontal');
    } else if (vertical) {
      pos = [from.pos[0], raw[1]];
      lockX = true;
      result.vertical = true;
      hints.push('vertical');
    } else if (from.lineId) {
      const prev = map.get(from.lineId);
      if (prev?.kind === 'line') {
        const a = map.get(prev.a);
        const b = map.get(prev.b);
        if (a?.kind === 'point' && b?.kind === 'point') {
          const dPrev = normalize([b.x - a.x, b.y - a.y]);
          const dNew = normalize(sub(raw, from.pos));
          const cos = dot(dPrev, dNew);
          const length = dist(from.pos, raw);
          if (Math.abs(cos) < Math.sin(ANGLE_TOL)) {
            const n: Vec2 = [-dPrev[1], dPrev[0]];
            const s = dot(sub(raw, from.pos), n) >= 0 ? 1 : -1;
            pos = [from.pos[0] + n[0] * length * s, from.pos[1] + n[1] * length * s];
            lockX = lockY = true;
            result.perpendicularTo = from.lineId;
            hints.push('perpendicular');
          } else if (Math.abs(cos) > Math.cos(ANGLE_TOL)) {
            const s = cos >= 0 ? 1 : -1;
            pos = [from.pos[0] + dPrev[0] * length * s, from.pos[1] + dPrev[1] * length * s];
            lockX = lockY = true;
            result.parallelTo = from.lineId;
            hints.push('parallel');
          }
        }
      }
    }
  }

  // 4. Alignment guides with other points (no constraint, like Shapr3D's guidelines).
  if (!lockX || !lockY) {
    let bestX: { pos: Vec2; d: number } | null = null;
    let bestY: { pos: Vec2; d: number } | null = null;
    const points: [string, Vec2][] = [[ORIGIN_ID, [0, 0]]];
    for (const e of sketch.entities) if (e.kind === 'point') points.push([e.id, [e.x, e.y]]);
    for (const [id, p] of points) {
      if (exclude.has(id) || id === from?.pointId) continue;
      const dx = Math.abs(p[0] - pos[0]);
      const dy = Math.abs(p[1] - pos[1]);
      if (!lockX && dx <= ALIGN_PX * px && (!bestX || dx < bestX.d)) bestX = { pos: p, d: dx };
      if (!lockY && dy <= ALIGN_PX * px && (!bestY || dy < bestY.d)) bestY = { pos: p, d: dy };
    }
    if (bestX) {
      const bx = bestX as { pos: Vec2 };
      pos = [bx.pos[0], pos[1]];
      lockX = true;
    }
    if (bestY) {
      const by = bestY as { pos: Vec2 };
      pos = [pos[0], by.pos[1]];
      lockY = true;
    }
    if (bestX) guides.push([(bestX as { pos: Vec2 }).pos, pos]);
    if (bestY) guides.push([(bestY as { pos: Vec2 }).pos, pos]);
  }
  if (from && (result.horizontal || result.vertical)) guides.push([from.pos, pos]);

  // 5. On a curve (only when the position is not otherwise locked).
  if (!lockX && !lockY) {
    let best: { id: string; point: Vec2; d: number } | null = null;
    for (const { id, entity, curve } of curves) {
      // Splines take no point-on-curve constraint (their end points snap as points).
      if (!isCurve(entity) || entity.kind === 'spline') continue;
      const hit = closestOnCurve(curve, raw);
      if (hit.distance <= CURVE_PX * px && (!best || hit.distance < best.d)) {
        best = { id, point: hit.point, d: hit.distance };
      }
    }
    if (best) {
      const b = best as { id: string; point: Vec2 };
      result.pos = b.point;
      result.curveId = b.id;
      hints.push('on');
      return withSegment(result);
    }
  }

  // 6. Grid.
  const step = ctx.gridStep;
  if (step && step > 0 && (!lockX || !lockY)) {
    pos = [
      lockX ? pos[0] : Math.round(pos[0] / step) * step,
      lockY ? pos[1] : Math.round(pos[1] / step) * step,
    ];
    if (!hints.length) hints.push('grid');
  }
  result.pos = pos;
  return result;
}

export type SketchHit = { kind: 'point'; id: string } | { kind: 'curve'; id: string };

/** The point (preferred) or curve under the cursor, or `null`. */
export function hitTest(
  sketch: SketchData,
  raw: Vec2,
  mmPerPx: number,
  options: { points?: boolean } = {},
): SketchHit | null {
  if (options.points !== false) {
    let best: { id: string; d: number } | null = null;
    for (const e of sketch.entities) {
      if (e.kind !== 'point') continue;
      const d = dist([e.x, e.y], raw);
      if (d <= 8 * mmPerPx && (!best || d < best.d)) best = { id: e.id, d };
    }
    if (best) return { kind: 'point', id: (best as { id: string }).id };
  }
  let bestCurve: { id: string; d: number } | null = null;
  for (const { entityId, curve } of sketchCurves(sketch, { includeConstruction: true })) {
    const d = closestOnCurve(curve, raw).distance;
    if (d <= 6 * mmPerPx && (!bestCurve || d < bestCurve.d)) bestCurve = { id: entityId, d };
  }
  return bestCurve ? { kind: 'curve', id: (bestCurve as { id: string }).id } : null;
}
