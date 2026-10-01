/**
 * Move/Rotate of a sketch profile (Shapr3D Move/Rotate 3D moves "sketch
 * regions", modelling research §4): the curves bounding a region (or every
 * curve of the sketch) translate in the sketch plane. Dimensions that
 * measure from geometry that stays put (the origin, other curves) take the
 * new values, so the sketch stays consistent with its solver; constraints
 * that tie the moved curves to geometry that stays put, fixed points and
 * formula-driven dimensions refuse the move with the reason.
 */
import { detectRegions } from './regions.js';
import { measure } from './measure.js';
import { ORIGIN_ID, type SketchData, type SketchEntity, type Vec2 } from './types.js';

/** Point ids an entity is built on. */
export function pointIdsOf(e: SketchEntity): string[] {
  switch (e.kind) {
    case 'point':
      return [e.id];
    case 'line':
      return [e.a, e.b];
    case 'circle':
      return [e.center];
    case 'arc':
      return [e.center, e.start, e.end];
    case 'ellipse':
      return [e.center, e.major, e.minor];
    case 'ellipticArc':
      return [e.center, e.major, e.minor, e.start, e.end];
    case 'spline': {
      const handles: string[] = [];
      for (const h of e.handles ?? []) if (h !== null) handles.push(h);
      return [...e.points, ...handles];
    }
    case 'text':
      return [e.anchor];
  }
}

/** Constraint kinds a rigid translation of some of their refs never breaks. */
const TRANSLATION_SAFE = new Set(['horizontal', 'vertical', 'parallel', 'perpendicular', 'equal']);

export type MoveRegionResult = { ok: true; sketch: SketchData } | { ok: false; reason: string };

/**
 * `sketch` with the curves of region `regionKey` (every curve when absent)
 * moved by (`du`, `dv`) in sketch coordinates.
 */
export function translateSketchRegion(
  sketch: SketchData,
  regionKey: string | undefined,
  du: number,
  dv: number,
): MoveRegionResult {
  if (!Number.isFinite(du) || !Number.isFinite(dv)) return { ok: false, reason: 'Invalid offset.' };
  let curveIds: Set<string>;
  if (regionKey === undefined) {
    curveIds = new Set(sketch.entities.filter((e) => e.kind !== 'point').map((e) => e.id));
  } else {
    const region = detectRegions(sketch).find((r) => r.key === regionKey);
    if (!region) return { ok: false, reason: 'That profile no longer exists.' };
    curveIds = new Set(
      [region.outer, ...region.holes].flatMap((loop) =>
        loop.pieces.map((p) => p.entityId.split('.')[0]!),
      ),
    );
  }
  const moved = new Set<string>();
  for (const e of sketch.entities) {
    if (curveIds.has(e.id)) for (const id of pointIdsOf(e)) moved.add(id);
  }
  if (moved.size === 0) return { ok: false, reason: 'Nothing to move.' };
  // Everything that moves: the points and the curves built only on them.
  const movedRefs = new Set<string>([...moved]);
  for (const e of sketch.entities) {
    if (e.kind !== 'point' && pointIdsOf(e).every((id) => moved.has(id))) movedRefs.add(e.id);
  }
  const touches = (refs: readonly string[]) => refs.some((r) => movedRefs.has(r) || moved.has(r));
  const staysPut = (refs: readonly string[]) =>
    refs.some((r) => r === ORIGIN_ID || (!movedRefs.has(r) && !moved.has(r)));
  for (const c of sketch.constraints) {
    if (!touches(c.refs)) continue;
    if (c.kind === 'fixed') {
      return { ok: false, reason: 'A locked point or curve is part of it; unlock it first.' };
    }
    if (!TRANSLATION_SAFE.has(c.kind) && staysPut(c.refs)) {
      return {
        ok: false,
        reason: `A ${c.kind === 'pointOnObject' ? 'point-on-curve' : c.kind} constraint ties it to geometry that stays; remove it or move the whole sketch.`,
      };
    }
  }
  const entities = sketch.entities.map((e) =>
    e.kind === 'point' && moved.has(e.id) ? { ...e, x: e.x + du, y: e.y + dv } : e,
  );
  let next: SketchData = { ...sketch, entities };
  const dimensions = sketch.dimensions.map((d) => {
    if (!touches(d.refs) || !staysPut(d.refs)) return d;
    const value = measure(next, d.kind, d.refs);
    return value === null ? d : { ...d, value };
  });
  const formula = sketch.dimensions.find(
    (d, i) => d.expression !== undefined && dimensions[i]!.value !== d.value,
  );
  if (formula) {
    return {
      ok: false,
      reason: `Dimension ${formula.name} (${formula.expression}) fixes its position; edit the formula instead.`,
    };
  }
  next = { ...next, dimensions };
  return { ok: true, sketch: next };
}

/** Centre of a region's sample point or of the sketch's points (the gizmo centre). */
export function regionCentre(sketch: SketchData, regionKey: string | undefined): Vec2 | null {
  if (regionKey !== undefined) {
    const region = detectRegions(sketch).find((r) => r.key === regionKey);
    return region ? region.sample : null;
  }
  const points = sketch.entities.filter((e) => e.kind === 'point');
  if (points.length === 0) return null;
  const sum = points.reduce<Vec2>((acc, p) => [acc[0] + p.x, acc[1] + p.y], [0, 0]);
  return [sum[0] / points.length, sum[1] / points.length];
}
