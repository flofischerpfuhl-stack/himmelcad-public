/**
 * Sketch solver on FreeCAD's planeGCS (LGPL-2.0-or-later), compiled to
 * WebAssembly by `@salusoft89/planegcs`. This module only *uses* the
 * library through the handles passed to {@link createPlanegcsSolver}; it
 * never imports its runtime code, so the LGPL files stay a separately
 * loaded, replaceable unit (`solver.worker.ts` loads them at runtime; Node
 * tests load them directly). See `LICENSES/THIRD_PARTY.md`.
 *
 * Mapping (Assembler → planeGCS primitives):
 * points → `point`, lines → `line`, circles → `circle`, arcs → `arc` +
 * `arc_rules`; constraints and dimensions → one or more planeGCS
 * constraints whose ids are `<ownerId>` or `<ownerId>#<n>`, so conflict and
 * redundancy reports map back to the Assembler constraint/dimension.
 */
import type { GcsWrapper, ModuleStatic, SketchPrimitive } from '@salusoft89/planegcs';

import { resolveDimensionValues } from './expressions.js';
import { measure } from './measure.js';
import { splineTangentPoint } from './splineTangent.js';
import type { SketchSolver, SolveRequest, SolveResult } from './solverTypes.js';
import {
  curveEnds,
  curvePointIds,
  entityMap,
  isCurve,
  isElliptic,
  isRound,
  ORIGIN_ID,
  pointPos,
  radiusOf,
  type SketchConstraint,
  type SketchData,
  type SketchDimension,
  type SketchEntity,
  type Vec2,
} from './types.js';

/** The runtime pieces of `@salusoft89/planegcs` the solver needs. */
export interface PlanegcsLibrary {
  module: ModuleStatic;
  GcsWrapper: typeof GcsWrapper;
}

/** Above this many points the per-point "fully constrained" analysis is skipped. */
const MAX_ANALYZED_POINTS = 120;
/** Smallest line length / radius a solution may produce, mm. */
const MIN_SIZE = 1e-6;
const DOGLEG = 2;
const NO_DEBUG = 0;

type Primitive = SketchPrimitive & { id: string };
type PrimitiveBody = Record<string, unknown> & { type: string };

class MappingError extends Error {
  constructor(
    message: string,
    readonly ownerId: string,
  ) {
    super(message);
  }
}

function now(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}

/** Prefix of solver-internal primitives (helper points, fixes); never reported to callers. */
const HIDDEN = '__';

/** Points (and circles) of projected geometry: fixed for the solver. */
function projectedGeometry(sketch: SketchData): { points: Set<string>; circles: string[] } {
  const map = entityMap(sketch);
  const points = new Set<string>();
  const circles: string[] = [];
  for (const projection of sketch.projections ?? []) {
    for (const id of projection.entities) {
      const e = map.get(id);
      if (!isCurve(e)) continue;
      for (const p of curvePointIds(e)) points.add(p);
      if (e.kind === 'circle') circles.push(e.id);
    }
  }
  return { points, circles };
}

/** Ellipse parameters (major radius, minor radius, focus, parametric angles) for planeGCS. */
function ellipseSetup(
  map: ReadonlyMap<string, SketchEntity>,
  e: Extract<SketchEntity, { kind: 'ellipse' | 'ellipticArc' }>,
): {
  focus: Vec2;
  opposite: Vec2;
  oppositeMinor: Vec2;
  radmin: number;
  angle: (p: Vec2) => number;
} {
  const c = pointPos(map, e.center)!;
  const m = pointPos(map, e.major)!;
  const n = pointPos(map, e.minor)!;
  const a = Math.hypot(m[0] - c[0], m[1] - c[1]);
  const b = Math.hypot(n[0] - c[0], n[1] - c[1]);
  const ux = (m[0] - c[0]) / (a || 1);
  const uy = (m[1] - c[1]) / (a || 1);
  const f = Math.sqrt(Math.max(0, a * a - b * b));
  return {
    focus: [c[0] + ux * f, c[1] + uy * f],
    opposite: [2 * c[0] - m[0], 2 * c[1] - m[1]],
    oppositeMinor: [2 * c[0] - n[0], 2 * c[1] - n[1]],
    radmin: b,
    angle: (p) => {
      const dx = p[0] - c[0];
      const dy = p[1] - c[1];
      return Math.atan2((-uy * dx + ux * dy) / (b || 1), (ux * dx + uy * dy) / (a || 1));
    },
  };
}

/** Builds planeGCS primitives for a sketch; `values` are the resolved dimension values. */
function buildPrimitives(sketch: SketchData, values: ReadonlyMap<string, number>): Primitive[] {
  const map = entityMap(sketch);
  const prims: Primitive[] = [];
  const projected = projectedGeometry(sketch);
  const usesOrigin =
    sketch.constraints.some((c) => c.refs.includes(ORIGIN_ID)) ||
    sketch.dimensions.some((d) => !d.driven && d.refs.includes(ORIGIN_ID));
  if (usesOrigin)
    prims.push({ id: ORIGIN_ID, type: 'point', x: 0, y: 0, fixed: true } as Primitive);
  for (const e of sketch.entities) {
    if (e.kind === 'point') {
      prims.push({
        id: e.id,
        type: 'point',
        x: e.x,
        y: e.y,
        fixed: projected.points.has(e.id),
      } as Primitive);
    }
  }
  // Arcs whose three points are all fixed (projected geometry) are solved as fixed circles:
  // the arc rules would be redundant (four equations for three free arc parameters).
  const solverMap = new Map(map);
  const fixedRadii: { id: string; radius: number }[] = [];
  for (const id of projected.circles) {
    const e = map.get(id);
    if (e?.kind === 'circle') fixedRadii.push({ id, radius: e.radius });
  }
  for (const e of sketch.entities) {
    if (e.kind !== 'arc') continue;
    if (![e.center, e.start, e.end].every((p) => projected.points.has(p))) continue;
    const radius = radiusOf(map, e);
    solverMap.set(e.id, {
      id: e.id,
      kind: 'circle',
      center: e.center,
      radius,
      ...(e.construction ? { construction: true } : {}),
    });
    fixedRadii.push({ id: e.id, radius });
  }
  for (const e of sketch.entities) {
    if (e.kind === 'ellipse' || e.kind === 'ellipticArc') {
      requirePoints(
        map,
        e.id,
        e.kind === 'ellipse'
          ? [e.center, e.major, e.minor]
          : [e.center, e.major, e.minor, e.start, e.end],
      );
      const setup = ellipseSetup(map, e);
      const focus = `${HIDDEN}${e.id}:f`;
      const opposite = `${HIDDEN}${e.id}:o`;
      const oppositeMinor = `${HIDDEN}${e.id}:n`;
      const fixed = projected.points.has(e.center);
      prims.push(
        { id: focus, type: 'point', x: setup.focus[0], y: setup.focus[1], fixed } as Primitive,
        {
          id: opposite,
          type: 'point',
          x: setup.opposite[0],
          y: setup.opposite[1],
          fixed,
        } as Primitive,
        {
          id: oppositeMinor,
          type: 'point',
          x: setup.oppositeMinor[0],
          y: setup.oppositeMinor[1],
          fixed,
        } as Primitive,
      );
      if (e.kind === 'ellipse') {
        prims.push({
          id: e.id,
          type: 'ellipse',
          c_id: e.center,
          focus1_id: focus,
          radmin: setup.radmin,
        } as Primitive);
      } else {
        const s = setup.angle(pointPos(map, e.start)!);
        let t = setup.angle(pointPos(map, e.end)!);
        while (t <= s) t += Math.PI * 2;
        prims.push(
          {
            id: e.id,
            type: 'arc_of_ellipse',
            c_id: e.center,
            focus1_id: focus,
            radmin: setup.radmin,
            start_id: e.start,
            end_id: e.end,
            start_angle: s,
            end_angle: t,
          } as Primitive,
          { id: `${HIDDEN}${e.id}:rules`, type: 'arc_of_ellipse_rules', a_id: e.id } as Primitive,
        );
      }
      prims.push(
        {
          id: `${HIDDEN}${e.id}:major`,
          type: 'internal_alignment_ellipse_major_diameter',
          e_id: e.id,
          p1_id: e.major,
          p2_id: opposite,
        } as Primitive,
        {
          id: `${HIDDEN}${e.id}:minor`,
          type: 'internal_alignment_ellipse_minor_diameter',
          e_id: e.id,
          p1_id: e.minor,
          p2_id: oppositeMinor,
        } as Primitive,
      );
      continue;
    }
    if (e.kind === 'spline') {
      requirePoints(map, e.id, curvePointIds(e));
      continue;
    }
    if (e.kind === 'text') {
      requirePoints(map, e.id, [e.anchor]);
      continue;
    }
    if (e.kind === 'line') {
      requirePoints(map, e.id, [e.a, e.b]);
      prims.push({ id: e.id, type: 'line', p1_id: e.a, p2_id: e.b } as Primitive);
    } else if (e.kind === 'circle') {
      requirePoints(map, e.id, [e.center]);
      prims.push({ id: e.id, type: 'circle', c_id: e.center, radius: e.radius } as Primitive);
    } else if (e.kind === 'arc' && solverMap.get(e.id)?.kind === 'circle') {
      prims.push({
        id: e.id,
        type: 'circle',
        c_id: e.center,
        radius: radiusOf(map, e),
      } as Primitive);
    } else if (e.kind === 'arc') {
      requirePoints(map, e.id, [e.center, e.start, e.end]);
      const c = pointPos(map, e.center)!;
      const s = pointPos(map, e.start)!;
      const t = pointPos(map, e.end)!;
      const startAngle = Math.atan2(s[1] - c[1], s[0] - c[0]);
      let endAngle = Math.atan2(t[1] - c[1], t[0] - c[0]);
      while (endAngle <= startAngle) endAngle += Math.PI * 2;
      prims.push({
        id: e.id,
        type: 'arc',
        c_id: e.center,
        start_id: e.start,
        end_id: e.end,
        radius: radiusOf(map, e),
        start_angle: startAngle,
        end_angle: endAngle,
      } as Primitive);
      prims.push({ id: `${e.id}#rules`, type: 'arc_rules', a_id: e.id } as Primitive);
    }
  }
  for (const { id, radius } of fixedRadii) {
    prims.push({ id: `${HIDDEN}fix:${id}`, type: 'circle_radius', c_id: id, radius } as Primitive);
  }
  for (const c of sketch.constraints) {
    let n = 0;
    for (const body of constraintPrimitives(solverMap, c, map)) {
      // Helper geometry carries its own (hidden) id; constraints are `<id>` / `<id>#<n>`.
      if (typeof body.id === 'string') {
        prims.push(body as unknown as Primitive);
        continue;
      }
      prims.push({ ...body, id: n === 0 ? c.id : `${c.id}#${n}` } as Primitive);
      n += 1;
    }
  }
  for (const d of sketch.dimensions) {
    if (d.driven) continue;
    const value = values.get(d.id) ?? d.value;
    dimensionPrimitives(solverMap, d, value).forEach((body, i) =>
      prims.push({ ...body, id: i === 0 ? d.id : `${d.id}#${i}` } as Primitive),
    );
  }
  return prims;
}

function requirePoints(map: ReadonlyMap<string, SketchEntity>, owner: string, ids: string[]): void {
  for (const id of ids) {
    if (!pointPos(map, id)) throw new MappingError(`Missing point "${id}"`, owner);
  }
}

function kindOf(
  map: ReadonlyMap<string, SketchEntity>,
  id: string,
): SketchEntity['kind'] | 'origin' | null {
  if (id === ORIGIN_ID) return 'origin';
  return map.get(id)?.kind ?? null;
}

function isPointRef(map: ReadonlyMap<string, SketchEntity>, id: string): boolean {
  const k = kindOf(map, id);
  return k === 'point' || k === 'origin';
}

/** End point ids of an open curve (`null` for circles, ellipses, text). */
function endsOf(e: SketchEntity | undefined): string[] {
  const ends = curveEnds(e);
  return ends ? [...ends] : [];
}

function tangentPrimitives(
  map: ReadonlyMap<string, SketchEntity>,
  c: SketchConstraint,
  bad: () => never,
  original?: ReadonlyMap<string, SketchEntity>,
): PrimitiveBody[] {
  const [r0 = '', r1 = ''] = c.refs;
  const e0 = map.get(r0);
  const e1 = map.get(r1);
  const k0 = e0?.kind;
  const k1 = e1?.kind;
  // Tangent at a shared end point (a line running into an arc, arc into arc): the curve
  // distance form is degenerate there (first-order dependent on the arc rules), so use the
  // direction form FreeCAD uses for endpoint tangency — well conditioned and never redundant.
  // Fixed (projected) arcs are mapped as circles; their end points still count here.
  const o0 = original?.get(r0) ?? e0;
  const o1 = original?.get(r1) ?? e1;
  const shared = endsOf(o0).find((p) => endsOf(o1).includes(p));
  const ok0 = o0?.kind;
  const ok1 = o1?.kind;
  if (
    shared &&
    (ok0 === 'line' || ok0 === 'arc') &&
    (ok1 === 'line' || ok1 === 'arc') &&
    ok0 !== ok1
  ) {
    const line = (ok0 === 'line' ? o0 : o1) as Extract<SketchEntity, { kind: 'line' }>;
    const arc = (ok0 === 'arc' ? o0 : o1) as Extract<SketchEntity, { kind: 'arc' }>;
    const far = line.a === shared ? line.b : line.a;
    return [
      {
        type: 'perpendicular_pppp',
        l1p1_id: arc.center,
        l1p2_id: shared,
        l2p1_id: shared,
        l2p2_id: far,
      },
    ];
  }
  if (shared && ok0 === 'arc' && ok1 === 'arc') {
    const a0 = o0 as Extract<SketchEntity, { kind: 'arc' }>;
    const a1 = o1 as Extract<SketchEntity, { kind: 'arc' }>;
    return [{ type: 'point_on_line_ppp', p_id: shared, lp1_id: a0.center, lp2_id: a1.center }];
  }
  if (k0 === 'line' && k1 === 'circle') return [{ type: 'tangent_lc', l_id: r0, c_id: r1 }];
  if (k0 === 'circle' && k1 === 'line') return [{ type: 'tangent_lc', l_id: r1, c_id: r0 }];
  if (k0 === 'line' && k1 === 'arc') return [{ type: 'tangent_la', l_id: r0, a_id: r1 }];
  if (k0 === 'arc' && k1 === 'line') return [{ type: 'tangent_la', l_id: r1, a_id: r0 }];
  if (k0 === 'circle' && k1 === 'circle') return [{ type: 'tangent_cc', c1_id: r0, c2_id: r1 }];
  if (k0 === 'arc' && k1 === 'arc') return [{ type: 'tangent_aa', a1_id: r0, a2_id: r1 }];
  if (k0 === 'circle' && k1 === 'arc') return [{ type: 'tangent_ca', c_id: r0, a_id: r1 }];
  if (k0 === 'arc' && k1 === 'circle') return [{ type: 'tangent_ca', c_id: r1, a_id: r0 }];
  if (k0 === 'line' && k1 === 'ellipse') return [{ type: 'tangent_le', l_id: r0, e_id: r1 }];
  if (k0 === 'ellipse' && k1 === 'line') return [{ type: 'tangent_le', l_id: r1, e_id: r0 }];
  // Splines: tangent at a shared end point, through the tangent-carrying point.
  if (e0?.kind === 'spline' || e1?.kind === 'spline') {
    const [spline, other] = (e0?.kind === 'spline' ? [e0, e1] : [e1, e0]) as [
      Extract<SketchEntity, { kind: 'spline' }>,
      SketchEntity | undefined,
    ];
    const shared = endsOf(spline).find((p) => endsOf(other).includes(p));
    if (!shared) bad();
    const h = splineTangentPoint(spline, shared!);
    if (!h) bad();
    if (other?.kind === 'line') return [{ type: 'point_on_line_pl', p_id: h, l_id: other.id }];
    if (other?.kind === 'arc') {
      return [
        {
          type: 'perpendicular_pppp',
          l1p1_id: other.center,
          l1p2_id: shared,
          l2p1_id: shared,
          l2p2_id: h,
        },
      ];
    }
    if (other?.kind === 'spline') {
      const h2 = splineTangentPoint(other, shared!);
      if (!h2) bad();
      return [{ type: 'point_on_line_ppp', p_id: h2, lp1_id: h, lp2_id: shared }];
    }
  }
  return bad();
}

function constraintPrimitives(
  map: ReadonlyMap<string, SketchEntity>,
  c: SketchConstraint,
  original?: ReadonlyMap<string, SketchEntity>,
): (PrimitiveBody & { id?: string })[] {
  const [r0, r1, r2] = c.refs;
  const k0 = r0 !== undefined ? kindOf(map, r0) : null;
  const k1 = r1 !== undefined ? kindOf(map, r1) : null;
  const bad = (): never => {
    throw new MappingError(`Constraint ${c.kind} has invalid references`, c.id);
  };
  const round = (id: string): SketchEntity => {
    const e = map.get(id);
    if (!isRound(e)) bad();
    return e!;
  };
  switch (c.kind) {
    case 'translate': {
      const [p, q, a, b] = c.refs;
      if (!p || !q || !a || !b || ![p, q, a, b].every((id) => isPointRef(map, id))) return bad();
      // q − p = b − a. When p is b itself (a pattern's second copy of its base point),
      // b is simply the midpoint of a and q.
      if (p === b) return [{ type: 'p2p_symmetric_ppp', p1_id: q, p2_id: a, p_id: b }];
      const pp = pointPos(map, p)!;
      const pb = pointPos(map, b)!;
      const m = `${HIDDEN}${c.id}:m`;
      return [
        { id: m, type: 'point', x: (pp[0] + pb[0]) / 2, y: (pp[1] + pb[1]) / 2, fixed: false },
        { type: 'p2p_symmetric_ppp', p1_id: p, p2_id: b, p_id: m },
        { type: 'p2p_symmetric_ppp', p1_id: q, p2_id: a, p_id: m },
      ];
    }
    case 'rotate': {
      const [p, q, center] = c.refs;
      if (!p || !q || !center || ![p, q, center].every((id) => isPointRef(map, id))) return bad();
      if (!(typeof c.value === 'number' && Number.isFinite(c.value))) return bad();
      const l1 = `${HIDDEN}${c.id}:l1`;
      const l2 = `${HIDDEN}${c.id}:l2`;
      return [
        { id: l1, type: 'line', p1_id: center, p2_id: p },
        { id: l2, type: 'line', p1_id: center, p2_id: q },
        { type: 'equal_length', l1_id: l1, l2_id: l2 },
        { type: 'l2l_angle_ll', l1_id: l1, l2_id: l2, angle: (c.value * Math.PI) / 180 },
      ];
    }
    case 'coincident':
      if (!r0 || !r1 || !isPointRef(map, r0) || !isPointRef(map, r1)) bad();
      return [{ type: 'p2p_coincident', p1_id: r0, p2_id: r1 }];
    case 'horizontal':
    case 'vertical':
      if (k0 === 'line' && c.refs.length === 1) return [{ type: `${c.kind}_l`, l_id: r0 }];
      if (r0 && r1 && isPointRef(map, r0) && isPointRef(map, r1)) {
        return [{ type: `${c.kind}_pp`, p1_id: r0, p2_id: r1 }];
      }
      return bad();
    case 'parallel':
      if (k0 !== 'line' || k1 !== 'line') bad();
      return [{ type: 'parallel', l1_id: r0, l2_id: r1 }];
    case 'perpendicular':
      if (k0 !== 'line' || k1 !== 'line') bad();
      return [{ type: 'perpendicular_ll', l1_id: r0, l2_id: r1 }];
    case 'tangent':
      if (!r0 || !r1) return bad();
      return tangentPrimitives(map, c, bad, original);
    case 'equal': {
      if (!r0 || !r1) return bad();
      if (k0 === 'line' && k1 === 'line') return [{ type: 'equal_length', l1_id: r0, l2_id: r1 }];
      round(r0);
      round(r1);
      if (k0 === 'circle' && k1 === 'circle')
        return [{ type: 'equal_radius_cc', c1_id: r0, c2_id: r1 }];
      if (k0 === 'arc' && k1 === 'arc') return [{ type: 'equal_radius_aa', a1_id: r0, a2_id: r1 }];
      if (k0 === 'circle') return [{ type: 'equal_radius_ca', c1_id: r0, a2_id: r1 }];
      return [{ type: 'equal_radius_ca', c1_id: r1, a2_id: r0 }];
    }
    case 'fixed': {
      if (!r0) return bad();
      const e = map.get(r0);
      if (!e) return bad();
      const pointIds = e.kind === 'point' ? [e.id] : curvePointIds(e);
      const out: PrimitiveBody[] = [];
      for (const id of pointIds) {
        const p = pointPos(map, id)!;
        out.push(
          { type: 'coordinate_x', p_id: id, x: p[0] },
          { type: 'coordinate_y', p_id: id, y: p[1] },
        );
      }
      if (e.kind === 'circle') out.push({ type: 'circle_radius', c_id: e.id, radius: e.radius });
      return out;
    }
    case 'midpoint':
      if (!r0 || !isPointRef(map, r0) || k1 !== 'line') bad();
      return [
        { type: 'point_on_line_pl', p_id: r0, l_id: r1 },
        { type: 'point_on_perp_bisector_pl', p_id: r0, l_id: r1 },
      ];
    case 'symmetric': {
      if (!r0 || !r1 || !r2 || !isPointRef(map, r0) || !isPointRef(map, r1)) return bad();
      const k2 = kindOf(map, r2);
      if (k2 === 'line') return [{ type: 'p2p_symmetric_ppl', p1_id: r0, p2_id: r1, l_id: r2 }];
      if (isPointRef(map, r2))
        return [{ type: 'p2p_symmetric_ppp', p1_id: r0, p2_id: r1, p_id: r2 }];
      return bad();
    }
    case 'concentric': {
      if (!r0 || !r1) return bad();
      const a = map.get(r0);
      const b = map.get(r1);
      if (!(isRound(a) || isElliptic(a)) || !(isRound(b) || isElliptic(b))) return bad();
      return [{ type: 'p2p_coincident', p1_id: a.center, p2_id: b.center }];
    }
    case 'pointOnObject':
      if (!r0 || !isPointRef(map, r0)) return bad();
      if (k1 === 'line') return [{ type: 'point_on_line_pl', p_id: r0, l_id: r1 }];
      if (k1 === 'circle') return [{ type: 'point_on_circle', p_id: r0, c_id: r1 }];
      if (k1 === 'arc') return [{ type: 'point_on_arc', p_id: r0, a_id: r1 }];
      if (k1 === 'ellipse' || k1 === 'ellipticArc') {
        return [{ type: 'point_on_ellipse', p_id: r0, e_id: r1 }];
      }
      return bad();
  }
}

/** The two point ids a (horizontal/vertical) distance measures between. */
function distancePoints(
  map: ReadonlyMap<string, SketchEntity>,
  d: SketchDimension,
): [string, string] {
  if (d.refs.length === 1) {
    const e = map.get(d.refs[0]!);
    if (e?.kind === 'line') return [e.a, e.b];
  } else if (d.refs.length === 2 && isPointRef(map, d.refs[0]!) && isPointRef(map, d.refs[1]!)) {
    return [d.refs[0]!, d.refs[1]!];
  }
  throw new MappingError(`Dimension ${d.name} has invalid references`, d.id);
}

function dimensionPrimitives(
  map: ReadonlyMap<string, SketchEntity>,
  d: SketchDimension,
  value: number,
): PrimitiveBody[] {
  const bad = (): never => {
    throw new MappingError(`Dimension ${d.name} has invalid references`, d.id);
  };
  switch (d.kind) {
    case 'distance': {
      const [r0, r1] = d.refs;
      const k0 = r0 ? kindOf(map, r0) : null;
      const k1 = r1 ? kindOf(map, r1) : null;
      if (d.refs.length === 1 || (r0 && r1 && isPointRef(map, r0) && isPointRef(map, r1))) {
        const [a, b] = distancePoints(map, d);
        return [{ type: 'p2p_distance', p1_id: a, p2_id: b, distance: value }];
      }
      if (r0 && r1 && isPointRef(map, r0) && k1 === 'line') {
        return [{ type: 'p2l_distance', p_id: r0, l_id: r1, distance: value }];
      }
      if (r0 && r1 && k0 === 'line' && isPointRef(map, r1)) {
        return [{ type: 'p2l_distance', p_id: r1, l_id: r0, distance: value }];
      }
      if (r0 && r1 && k0 === 'line' && k1 === 'line') {
        const l0 = map.get(r0) as Extract<SketchEntity, { kind: 'line' }>;
        return [{ type: 'p2l_distance', p_id: l0.a, l_id: r1, distance: value }];
      }
      return bad();
    }
    case 'horizontalDistance':
    case 'verticalDistance': {
      const [a, b] = distancePoints(map, d);
      const prop = d.kind === 'horizontalDistance' ? 'x' : 'y';
      const axis = prop === 'x' ? 0 : 1;
      const pa = pointPos(map, a)!;
      const pb = pointPos(map, b)!;
      const sign = pb[axis] - pa[axis] < 0 ? -1 : 1;
      return [
        {
          type: 'difference',
          param1: { o_id: a, prop },
          param2: { o_id: b, prop },
          difference: sign * value,
        },
      ];
    }
    case 'radius':
    case 'diameter': {
      const e = map.get(d.refs[0] ?? '');
      if (e?.kind === 'circle') {
        return d.kind === 'radius'
          ? [{ type: 'circle_radius', c_id: e.id, radius: value }]
          : [{ type: 'circle_diameter', c_id: e.id, diameter: value }];
      }
      if (e?.kind === 'arc') {
        return d.kind === 'radius'
          ? [{ type: 'arc_radius', a_id: e.id, radius: value }]
          : [{ type: 'arc_diameter', a_id: e.id, diameter: value }];
      }
      return bad();
    }
    case 'angle': {
      const l1 = map.get(d.refs[0] ?? '');
      const l2 = map.get(d.refs[1] ?? '');
      if (l1?.kind !== 'line' || l2?.kind !== 'line') return bad();
      const a1 = pointPos(map, l1.a)!;
      const b1 = pointPos(map, l1.b)!;
      const a2 = pointPos(map, l2.a)!;
      const b2 = pointPos(map, l2.b)!;
      const d1 = [b1[0] - a1[0], b1[1] - a1[1]];
      const d2 = [b2[0] - a2[0], b2[1] - a2[1]];
      const current = Math.atan2(
        d1[0]! * d2[1]! - d1[1]! * d2[0]!,
        d1[0]! * d2[0]! + d1[1]! * d2[1]!,
      );
      const sign = current < 0 ? -1 : 1;
      return [
        { type: 'l2l_angle_ll', l1_id: l1.id, l2_id: l2.id, angle: (sign * value * Math.PI) / 180 },
      ];
    }
  }
}

function ownerOf(primitiveId: string): string {
  const hash = primitiveId.indexOf('#');
  return hash < 0 ? primitiveId : primitiveId.slice(0, hash);
}

function uniqueOwners(ids: readonly string[]): string[] {
  return [...new Set(ids.map(ownerOf))];
}

/** Line length / radius below {@link MIN_SIZE}: the solution collapsed an entity. */
function collapsedEntity(sketch: SketchData): string | null {
  const map = entityMap(sketch);
  for (const e of sketch.entities) {
    if (e.kind === 'line') {
      const a = pointPos(map, e.a)!;
      const b = pointPos(map, e.b)!;
      if (Math.hypot(a[0] - b[0], a[1] - b[1]) < MIN_SIZE) return e.id;
    } else if (e.kind === 'circle' || e.kind === 'arc') {
      if (!(radiusOf(map, e) >= MIN_SIZE)) return e.id;
    } else if (e.kind === 'ellipse' || e.kind === 'ellipticArc') {
      const c = pointPos(map, e.center)!;
      const m = pointPos(map, e.major)!;
      const n = pointPos(map, e.minor)!;
      if (!(Math.hypot(m[0] - c[0], m[1] - c[1]) >= MIN_SIZE)) return e.id;
      if (!(Math.hypot(n[0] - c[0], n[1] - c[1]) >= MIN_SIZE)) return e.id;
    }
  }
  return null;
}

/** Current values of the reference (driven) dimensions of a solved sketch. */
export function withDrivenValues(sketch: SketchData): SketchData {
  if (!sketch.dimensions.some((d) => d.driven)) return sketch;
  return {
    ...sketch,
    dimensions: sketch.dimensions.map((d) => {
      if (!d.driven) return d;
      const value = measure(sketch, d.kind, d.refs);
      return value !== null && value !== d.value ? { ...d, value } : d;
    }),
  };
}

/**
 * Creates a solver on an initialized planeGCS module. Every `solve` builds
 * a fresh system (sketches are small; this keeps no hidden state between
 * calls) and frees it before returning.
 */
export function createPlanegcsSolver(
  lib: PlanegcsLibrary,
): SketchSolver & { solveSync(request: SolveRequest): SolveResult } {
  const run = (prims: Primitive[]) => {
    const gcs = new lib.GcsWrapper(new lib.module.GcsSystem(), lib.module);
    try {
      gcs.gcs.set_debug_mode(NO_DEBUG);
      gcs.push_primitives_and_params(prims);
      const status = gcs.solve(DOGLEG);
      gcs.apply_solution();
      return {
        status,
        dof: gcs.gcs.dof(),
        conflicting: gcs.get_gcs_conflicting_constraints(),
        redundant: gcs.get_gcs_redundant_constraints(),
        primitives: gcs.sketch_index.get_primitives() as Primitive[],
      };
    } finally {
      gcs.destroy_gcs_module();
    }
  };

  const solveSync = (request: SolveRequest): SolveResult => {
    const start = now();
    const input = request.sketch;
    const fail = (
      status: SolveResult['status'],
      message: string,
      extra: Partial<SolveResult> = {},
    ): SolveResult => ({
      status,
      sketch: input,
      dof: 0,
      conflicting: [],
      redundant: [],
      message,
      determined: null,
      ms: now() - start,
      ...extra,
    });

    const drivenNames = new Set(input.dimensions.filter((d) => d.driven).map((d) => d.name));
    const usesDriven = input.dimensions.find(
      (d) =>
        !d.driven &&
        d.expression !== undefined &&
        [...drivenNames].some((name) => new RegExp(`\\b${name}\\b`).test(d.expression!)),
    );
    if (usesDriven) {
      return fail(
        'invalid',
        `Dimension ${usesDriven.name} uses a reference dimension; only driving dimensions can be used in expressions`,
        { conflicting: [usesDriven.id] },
      );
    }
    const values = resolveDimensionValues(input.dimensions.filter((d) => !d.driven));
    if (!values.ok) return fail('invalid', values.message, { conflicting: [values.dimensionId] });

    let prims: Primitive[];
    try {
      prims = buildPrimitives(input, values.values);
    } catch (error) {
      if (error instanceof MappingError) {
        return fail('invalid', error.message, { conflicting: [error.ownerId] });
      }
      throw error;
    }
    const drag = request.drag ?? [];
    for (const [i, d] of drag.entries()) {
      prims.push(
        {
          id: `__drag${i}x`,
          type: 'coordinate_x',
          p_id: d.pointId,
          x: d.target[0],
          temporary: true,
        } as Primitive,
        {
          id: `__drag${i}y`,
          type: 'coordinate_y',
          p_id: d.pointId,
          y: d.target[1],
          temporary: true,
        } as Primitive,
      );
    }

    let outcome: ReturnType<typeof run>;
    try {
      outcome = run(prims);
    } catch (error) {
      return fail(
        'failed',
        `The solver failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    const conflicting = uniqueOwners(outcome.conflicting).filter((id) => !id.startsWith('__'));
    const redundant = uniqueOwners(outcome.redundant).filter((id) => !id.startsWith('__'));
    if (conflicting.length > 0) {
      return fail('overconstrained', 'Conflicting constraints', {
        conflicting,
        redundant,
        dof: outcome.dof,
      });
    }
    if (redundant.length > 0) {
      return fail('overconstrained', 'Redundant constraints', {
        conflicting,
        redundant,
        dof: outcome.dof,
      });
    }
    if (outcome.status === 2 || outcome.status === 3) {
      return fail('failed', 'The sketch could not be solved with these values', {
        dof: outcome.dof,
      });
    }

    const solvedById = new Map(outcome.primitives.map((p) => [p.id, p]));
    const solvedSketch: SketchData = {
      ...input,
      dimensions: input.dimensions.map((d) => {
        const v = values.values.get(d.id);
        return v !== undefined && v !== d.value ? { ...d, value: v } : d;
      }),
      entities: input.entities.map((e) => {
        const solved = solvedById.get(e.id) as Record<string, unknown> | undefined;
        if (!solved) return e;
        if (e.kind === 'point') return { ...e, x: solved.x as number, y: solved.y as number };
        if (e.kind === 'circle') return { ...e, radius: solved.radius as number };
        return e;
      }),
    };
    const sketch = withDrivenValues(solvedSketch);
    const collapsed = collapsedEntity(sketch);
    if (collapsed) {
      return fail('failed', 'These constraints would collapse the geometry', {
        conflicting: [],
        dof: outcome.dof,
      });
    }

    let determined: string[] | null = null;
    if (request.analyze) determined = analyze(sketch, values.values, outcome.dof);

    return {
      status: 'ok',
      sketch,
      dof: outcome.dof,
      conflicting: [],
      redundant: [],
      message: null,
      determined,
      ms: now() - start,
    };
  };

  /** Probes each point coordinate / circle radius: a probe that is redundant is already determined. */
  const analyze = (
    sketch: SketchData,
    values: ReadonlyMap<string, number>,
    dof: number,
  ): string[] | null => {
    const points = sketch.entities.filter((e) => e.kind === 'point');
    const curves = sketch.entities.filter((e) => e.kind !== 'point');
    if (dof === 0) return sketch.entities.map((e) => e.id);
    if (points.length > MAX_ANALYZED_POINTS) return null;
    const base = buildPrimitives(sketch, values);
    const isDetermined = (probe: Primitive): boolean => {
      try {
        return run([...base, probe]).redundant.includes(probe.id);
      } catch {
        return false;
      }
    };
    const determinedPoints = new Set<string>();
    for (const p of points) {
      if (p.kind !== 'point') continue;
      const x = isDetermined({
        id: '__probe',
        type: 'coordinate_x',
        p_id: p.id,
        x: p.x,
      } as Primitive);
      if (!x) continue;
      const y = isDetermined({
        id: '__probe',
        type: 'coordinate_y',
        p_id: p.id,
        y: p.y,
      } as Primitive);
      if (y) determinedPoints.add(p.id);
    }
    const out = [...determinedPoints];
    for (const c of curves) {
      if (c.kind !== 'circle') {
        if (curvePointIds(c).every((id) => determinedPoints.has(id))) out.push(c.id);
      } else if (determinedPoints.has(c.center)) {
        const r = isDetermined({
          id: '__probe',
          type: 'circle_radius',
          c_id: c.id,
          radius: c.radius,
        } as Primitive);
        if (r) out.push(c.id);
      }
    }
    return out;
  };

  return {
    solveSync,
    solve: (request) => Promise.resolve(solveSync(request)),
  };
}
