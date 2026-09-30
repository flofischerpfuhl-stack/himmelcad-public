/**
 * Agent-API side of constrained sketches (`sketch/`): the convenience
 * shapes (rectangle, circle — fully dimensioned like a migrated v1 file,
 * polyline, arc), constraint/dimension edits, the solve step every sketch
 * write goes through, and the read model of `sketches.list`.
 *
 * Every write re-solves the whole sketch with the same planeGCS solver the
 * UI uses (`sketch/solverProvider.ts`), so a stored sketch always holds its
 * last solved positions; a conflicting, redundant or collapsing edit is
 * rejected with the solver's diagnosis (`sketchConflict`) and nothing
 * changes.
 */
import type { EvaluatedSketch } from '../foundation/geometry-kernel/types.js';

import type { SketchFeature } from '../foundation/sketch-solver/sketchFeature.js';
import {
  addCircle,
  addPolyline,
  addRectangle,
  withConstraints,
} from '../foundation/sketch-solver/builders.js';
import { deleteItems } from '../foundation/sketch-solver/edits.js';
import { isPlainNumber } from '../foundation/document/expressions.js';
import { adoptProjectedEntities } from '../foundation/sketch-solver/projection.js';
import { detectRegions } from '../foundation/sketch-solver/regions.js';
import { describeProblem } from '../sketch/session.js';
import { getSketchSolver } from '../foundation/sketch-solver/solverProvider.js';
import {
  idAllocator,
  nextDimensionName,
  sketchDataOf as sketchDataOfFeature,
  type SketchConstraintKind,
  type SketchData,
  type SketchDimension,
  type SketchDimensionKind,
  type SketchEntity,
  type Vec2,
} from '../foundation/sketch-solver/types.js';
import { validateSketchData } from '../foundation/sketch-solver/validation.js';
import { ApiError } from '../foundation/commands/api/errors.js';

type Json = Record<string, unknown>;

/** A convenience shape (the former v1 profile shapes). */
export type SketchShape =
  | { kind: 'rectangle'; x: number; y: number; width: number; height: number }
  | { kind: 'circle'; cx: number; cy: number; radius: number };

/** What adding a shape created: its entity ids and the names of its driving dimensions by role. */
export interface ShapeResult {
  kind: SketchShape['kind'];
  entityIds: string[];
  /** Rectangle: `x`, `y` (corner from the origin), `width`, `height`; circle: `cx`, `cy`, `diameter`. */
  dimensions: Record<string, string>;
}

export function sketchDataOf(feature: SketchFeature): SketchData {
  return sketchDataOfFeature(feature);
}

const RECTANGLE_ROLES = ['x', 'y', 'width', 'height'];
const CIRCLE_ROLES = ['cx', 'cy', 'diameter'];

/** Adds one fully dimensioned rectangle/circle (position from the origin + size). */
export function addShape(
  sketch: SketchData,
  shape: SketchShape,
): { sketch: SketchData; added: ShapeResult } {
  const before = new Set(sketch.dimensions.map((d) => d.id));
  if (shape.kind === 'rectangle') {
    const x0 = Math.min(shape.x, shape.x + shape.width);
    const y0 = Math.min(shape.y, shape.y + shape.height);
    const built = addRectangle(
      sketch,
      [x0, y0],
      [x0 + Math.abs(shape.width), y0 + Math.abs(shape.height)],
      { position: true, size: true },
    );
    const dims = built.sketch.dimensions.filter((d) => !before.has(d.id));
    return {
      sketch: built.sketch,
      added: {
        kind: 'rectangle',
        entityIds: [...built.pointIds, ...built.lineIds],
        dimensions: Object.fromEntries(dims.map((d, i) => [RECTANGLE_ROLES[i]!, d.name])),
      },
    };
  }
  const built = addCircle(sketch, [shape.cx, shape.cy], shape.radius, {
    position: true,
    size: true,
  });
  const dims = built.sketch.dimensions.filter((d) => !before.has(d.id));
  return {
    sketch: built.sketch,
    added: {
      kind: 'circle',
      entityIds: [built.centerId, built.circleId],
      dimensions: Object.fromEntries(dims.map((d, i) => [CIRCLE_ROLES[i]!, d.name])),
    },
  };
}

/**
 * Adds a polyline (consecutive lines share their points). With
 * `autoConstrain` (default) axis-aligned segments get horizontal/vertical
 * constraints — what the UI's line tool infers.
 */
export function addPolylineShape(
  sketch: SketchData,
  points: readonly Vec2[],
  options: { closed?: boolean; construction?: boolean; autoConstrain?: boolean },
): { sketch: SketchData; pointIds: string[]; lineIds: string[] } {
  if (points.length < 2)
    throw new ApiError('invalidParams', 'A polyline needs at least two points');
  const closed = options.closed === true && points.length >= 3;
  const built = addPolyline(sketch, points, {
    closed,
    ...(options.construction ? { construction: true } : {}),
  });
  if (options.autoConstrain === false) return built;
  const constraints: { kind: SketchConstraintKind; refs: string[] }[] = [];
  built.lineIds.forEach((lineId, i) => {
    const a = points[i]!;
    const b = points[(i + 1) % points.length]!;
    const tol = 1e-9 * Math.max(1, Math.abs(a[0]), Math.abs(a[1]), Math.abs(b[0]), Math.abs(b[1]));
    if (Math.abs(a[1] - b[1]) <= tol) constraints.push({ kind: 'horizontal', refs: [lineId] });
    else if (Math.abs(a[0] - b[0]) <= tol) constraints.push({ kind: 'vertical', refs: [lineId] });
  });
  return { ...built, sketch: withConstraints(built.sketch, constraints) };
}

/** Adds a counter-clockwise arc from `start` to `end` around `center` (the end is kept on the radius by the solver). */
export function addArcShape(
  sketch: SketchData,
  center: Vec2,
  start: Vec2,
  end: Vec2,
  construction: boolean,
): { sketch: SketchData; entityIds: string[] } {
  const alloc = idAllocator(sketch);
  const [c, s, e, a] = [alloc('p'), alloc('p'), alloc('p'), alloc('a')];
  const entities: SketchEntity[] = [
    { id: c, kind: 'point', x: center[0], y: center[1] },
    { id: s, kind: 'point', x: start[0], y: start[1] },
    { id: e, kind: 'point', x: end[0], y: end[1] },
    { id: a, kind: 'arc', center: c, start: s, end: e, ...(construction ? { construction } : {}) },
  ];
  return {
    sketch: { ...sketch, entities: [...sketch.entities, ...entities] },
    entityIds: [c, s, e, a],
  };
}

export function addConstraint(
  sketch: SketchData,
  kind: SketchConstraintKind,
  refs: string[],
): { sketch: SketchData; constraintId: string } {
  const next = withConstraints(sketch, [{ kind, refs }]);
  return { sketch: next, constraintId: next.constraints[next.constraints.length - 1]!.id };
}

/** Adds a driving dimension (`value`, or an `expression` over other dimension names). */
export function addDimension(
  sketch: SketchData,
  kind: SketchDimensionKind,
  refs: string[],
  input: { value?: number; expression?: string; name?: string },
): { sketch: SketchData; dimension: SketchDimension } {
  const alloc = idAllocator(sketch);
  const name = input.name ?? nextDimensionName(sketch);
  if (sketch.dimensions.some((d) => d.name === name)) {
    throw new ApiError('invalidParams', `Dimension name "${name}" is already used in this sketch`);
  }
  const dimension: SketchDimension = {
    id: alloc('m'),
    name,
    kind,
    refs,
    value: Math.abs(input.value ?? 0),
    ...(input.expression !== undefined && !isPlainNumber(input.expression)
      ? { expression: input.expression }
      : {}),
  };
  if (input.expression !== undefined && isPlainNumber(input.expression)) {
    dimension.value = Math.abs(Number(input.expression.replace(',', '.')));
  }
  return { sketch: { ...sketch, dimensions: [...sketch.dimensions, dimension] }, dimension };
}

/** Finds a dimension by id or name. */
export function findDimension(sketch: SketchData, idOrName: string): SketchDimension {
  const dimension = sketch.dimensions.find((d) => d.id === idOrName || d.name === idOrName);
  if (!dimension) {
    throw new ApiError('notFound', `No dimension "${idOrName}" in this sketch`, {
      hint: 'sketches.list returns every dimension with id, name, kind and value.',
      details: {
        candidates: sketch.dimensions.map((d) => ({
          id: d.id,
          name: d.name,
          kind: d.kind,
          value: d.value,
        })),
      },
    });
  }
  return dimension;
}

/** Sets a dimension's value or expression. */
export function setDimension(
  sketch: SketchData,
  idOrName: string,
  input: { value?: number; expression?: string },
): SketchData {
  const dimension = findDimension(sketch, idOrName);
  const { expression: _previous, ...rest } = dimension;
  let next: SketchDimension;
  if (input.expression !== undefined && !isPlainNumber(input.expression)) {
    next = { ...rest, expression: input.expression };
  } else {
    const raw =
      input.expression !== undefined ? Number(input.expression.replace(',', '.')) : input.value;
    if (raw === undefined || !Number.isFinite(raw)) {
      throw new ApiError('invalidParams', 'Give "value" (a number) or "expression"');
    }
    next = { ...rest, value: Math.abs(raw) };
  }
  return {
    ...sketch,
    dimensions: sketch.dimensions.map((d) => (d.id === dimension.id ? next : d)),
  };
}

export function deleteSketchItems(sketch: SketchData, ids: readonly string[]): SketchData {
  const known = new Set([
    ...sketch.entities.map((e) => e.id),
    ...sketch.constraints.map((c) => c.id),
    ...sketch.dimensions.map((d) => d.id),
  ]);
  const missing = ids.filter((id) => !known.has(id));
  if (missing.length > 0) {
    throw new ApiError('notFound', `No sketch item "${missing[0]}"`, {
      hint: 'sketches.list returns the ids of entities, constraints and dimensions.',
    });
  }
  return deleteItems(sketch, ids);
}

/**
 * Validates and solves a sketch. Resolves the solved data (last solved
 * positions, dimension values from their expressions) and its remaining
 * degrees of freedom; rejects with `sketchConflict` (over-constrained,
 * not solvable, collapsing geometry, invalid expression) or
 * `invalidParams` (structurally invalid data).
 */
export async function solveSketch(
  sketch: SketchData,
): Promise<{ sketch: SketchData; dof: number }> {
  const structural = validateSketchData(sketch as unknown as Json);
  if (structural) {
    throw new ApiError(
      'invalidParams',
      `Invalid sketch at ${structural.path}: ${structural.message}`,
      {
        hint: 'See $defs.SketchEntity / SketchConstraint / SketchDimension in api.describe.',
      },
    );
  }
  let solver;
  try {
    solver = getSketchSolver();
  } catch (error) {
    throw new ApiError('internal', error instanceof Error ? error.message : String(error));
  }
  const result = await solver.solve({ sketch });
  if (result.status !== 'ok') {
    const problem = describeProblem(result, sketch);
    throw new ApiError(
      'sketchConflict',
      problem.message.replace(' The last valid sketch is kept.', ''),
      {
        hint:
          result.status === 'overconstrained'
            ? 'Remove or change one of the listed constraints/dimensions (sketch.deleteItems / sketch.setDimension).'
            : 'Check the values: a dimension must not collapse geometry, and expressions may only use names of other dimensions.',
        details: {
          status: result.status,
          conflicting: result.conflicting,
          redundant: result.redundant,
          committed: false,
        },
      },
    );
  }
  return { sketch: result.sketch, dof: result.dof };
}

/** Regions (profiles) of a sketch as the API reports them. */
export function describeRegions(
  sketch: SketchData,
  evaluated: EvaluatedSketch | undefined,
): Json[] {
  // Projected geometry the kernel moved with its source counts as it was evaluated.
  const current = evaluated?.projectedEntities
    ? adoptProjectedEntities(sketch, evaluated.projectedEntities)
    : sketch;
  return detectRegions(current).map((region) => {
    const shown = evaluated?.profiles.find((p) => p.key === region.key);
    const boundary = [region.outer, ...region.holes].flatMap((loop) =>
      loop.pieces.map((piece) => piece.entityId),
    );
    return {
      key: region.key,
      area: Math.round(region.area * 1e6) / 1e6,
      sample: region.sample,
      center: shown?.center ?? null,
      holes: region.holes.length,
      entityIds: [...new Set(boundary)],
    };
  });
}
