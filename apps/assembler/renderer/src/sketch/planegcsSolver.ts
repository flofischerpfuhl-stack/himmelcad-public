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
import type { SketchSolver, SolveRequest, SolveResult } from './solverTypes.js';
import {
  entityMap,
  isRound,
  ORIGIN_ID,
  pointPos,
  radiusOf,
  type SketchConstraint,
  type SketchData,
  type SketchDimension,
  type SketchEntity,
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

/** Builds planeGCS primitives for a sketch; `values` are the resolved dimension values. */
function buildPrimitives(sketch: SketchData, values: ReadonlyMap<string, number>): Primitive[] {
  const map = entityMap(sketch);
  const prims: Primitive[] = [];
  const usesOrigin =
    sketch.constraints.some((c) => c.refs.includes(ORIGIN_ID)) ||
    sketch.dimensions.some((d) => d.refs.includes(ORIGIN_ID));
  if (usesOrigin)
    prims.push({ id: ORIGIN_ID, type: 'point', x: 0, y: 0, fixed: true } as Primitive);
  for (const e of sketch.entities) {
    if (e.kind === 'point')
      prims.push({ id: e.id, type: 'point', x: e.x, y: e.y, fixed: false } as Primitive);
  }
  for (const e of sketch.entities) {
    if (e.kind === 'line') {
      requirePoints(map, e.id, [e.a, e.b]);
      prims.push({ id: e.id, type: 'line', p1_id: e.a, p2_id: e.b } as Primitive);
    } else if (e.kind === 'circle') {
      requirePoints(map, e.id, [e.center]);
      prims.push({ id: e.id, type: 'circle', c_id: e.center, radius: e.radius } as Primitive);
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
  for (const c of sketch.constraints) {
    constraintPrimitives(map, c).forEach((body, i) =>
      prims.push({ ...body, id: i === 0 ? c.id : `${c.id}#${i}` } as Primitive),
    );
  }
  for (const d of sketch.dimensions) {
    const value = values.get(d.id) ?? d.value;
    dimensionPrimitives(map, d, value).forEach((body, i) =>
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

function constraintPrimitives(
  map: ReadonlyMap<string, SketchEntity>,
  c: SketchConstraint,
): PrimitiveBody[] {
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
    case 'tangent': {
      if (!r0 || !r1) return bad();
      if (k0 === 'line' && k1 === 'circle') return [{ type: 'tangent_lc', l_id: r0, c_id: r1 }];
      if (k0 === 'circle' && k1 === 'line') return [{ type: 'tangent_lc', l_id: r1, c_id: r0 }];
      if (k0 === 'line' && k1 === 'arc') return [{ type: 'tangent_la', l_id: r0, a_id: r1 }];
      if (k0 === 'arc' && k1 === 'line') return [{ type: 'tangent_la', l_id: r1, a_id: r0 }];
      if (k0 === 'circle' && k1 === 'circle') return [{ type: 'tangent_cc', c1_id: r0, c2_id: r1 }];
      if (k0 === 'arc' && k1 === 'arc') return [{ type: 'tangent_aa', a1_id: r0, a2_id: r1 }];
      if (k0 === 'circle' && k1 === 'arc') return [{ type: 'tangent_ca', c_id: r0, a_id: r1 }];
      if (k0 === 'arc' && k1 === 'circle') return [{ type: 'tangent_ca', c_id: r1, a_id: r0 }];
      return bad();
    }
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
      const pointIds =
        e.kind === 'point'
          ? [e.id]
          : e.kind === 'line'
            ? [e.a, e.b]
            : e.kind === 'circle'
              ? [e.center]
              : [e.center, e.start, e.end];
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
      const a = round(r0) as Extract<SketchEntity, { kind: 'circle' | 'arc' }>;
      const b = round(r1) as Extract<SketchEntity, { kind: 'circle' | 'arc' }>;
      return [{ type: 'p2p_coincident', p1_id: a.center, p2_id: b.center }];
    }
    case 'pointOnObject':
      if (!r0 || !isPointRef(map, r0)) return bad();
      if (k1 === 'line') return [{ type: 'point_on_line_pl', p_id: r0, l_id: r1 }];
      if (k1 === 'circle') return [{ type: 'point_on_circle', p_id: r0, c_id: r1 }];
      if (k1 === 'arc') return [{ type: 'point_on_arc', p_id: r0, a_id: r1 }];
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
    }
  }
  return null;
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

    const values = resolveDimensionValues(
      input.dimensions,
      request.paramValues ? new Map(request.paramValues) : undefined,
    );
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
    const sketch: SketchData = {
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
      if (c.kind === 'line') {
        if (determinedPoints.has(c.a) && determinedPoints.has(c.b)) out.push(c.id);
      } else if (c.kind === 'arc') {
        if ([c.center, c.start, c.end].every((id) => determinedPoints.has(id))) out.push(c.id);
      } else if (c.kind === 'circle' && determinedPoints.has(c.center)) {
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
