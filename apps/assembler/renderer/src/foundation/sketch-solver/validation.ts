/**
 * Strict structural validation of stored sketch data (project loading and
 * the agent/automation path): known kinds, finite numbers, unique ids and
 * references that resolve. Geometric consistency (whether the constraints
 * can be satisfied) is the solver's job, not this validator's.
 */
import { splineDegree, validKnots } from './spline.js';
import { ORIGIN_ID, type SketchConstraintKind, type SketchDimensionKind } from './types.js';

const CONSTRAINT_KINDS: readonly SketchConstraintKind[] = [
  'coincident',
  'horizontal',
  'vertical',
  'parallel',
  'perpendicular',
  'tangent',
  'equal',
  'fixed',
  'midpoint',
  'symmetric',
  'concentric',
  'pointOnObject',
  'translate',
  'rotate',
];

const DIMENSION_KINDS: readonly SketchDimensionKind[] = [
  'distance',
  'horizontalDistance',
  'verticalDistance',
  'radius',
  'diameter',
  'angle',
];

type Raw = Record<string, unknown>;

function isRecord(v: unknown): v is Raw {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function isNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

function isString(v: unknown): v is string {
  return typeof v === 'string';
}

export interface SketchValidationError {
  /** Path relative to the sketch object, e.g. `entities[3].b`. */
  path: string;
  message: string;
}

/** Validates `entities`, `constraints` and `dimensions` of a raw sketch object; `null` when valid. */
export function validateSketchData(raw: Raw): SketchValidationError | null {
  const { entities, constraints, dimensions } = raw;
  if (!Array.isArray(entities)) return { path: 'entities', message: 'expected an array' };
  if (!Array.isArray(constraints)) return { path: 'constraints', message: 'expected an array' };
  if (!Array.isArray(dimensions)) return { path: 'dimensions', message: 'expected an array' };

  const ids = new Set<string>();
  const kinds = new Map<string, string>();
  for (const [i, e] of entities.entries()) {
    const path = `entities[${i}]`;
    if (!isRecord(e)) return { path, message: 'expected an object' };
    if (!isString(e.id) || e.id === '' || e.id === ORIGIN_ID) {
      return { path: `${path}.id`, message: 'expected a non-empty, non-reserved string' };
    }
    if (ids.has(e.id)) return { path: `${path}.id`, message: `duplicate id "${e.id}"` };
    ids.add(e.id);
    if (e.construction !== undefined && typeof e.construction !== 'boolean') {
      return { path: `${path}.construction`, message: 'expected a boolean' };
    }
    const fields: Record<string, string[]> = {
      point: ['x', 'y'],
      line: [],
      circle: ['radius'],
      arc: [],
      ellipse: [],
      ellipticArc: [],
      spline: [],
      text: ['height', 'angle'],
    };
    const numeric = fields[e.kind as string];
    if (!numeric)
      return { path: `${path}.kind`, message: `unknown entity kind "${String(e.kind)}"` };
    for (const field of numeric) {
      if (!isNumber(e[field])) return { path: `${path}.${field}`, message: 'expected a number' };
    }
    if (e.kind === 'circle' && !((e.radius as number) > 0)) {
      return { path: `${path}.radius`, message: 'expected a positive number' };
    }
    if (e.kind === 'text') {
      if (!((e.height as number) > 0)) {
        return { path: `${path}.height`, message: 'expected a positive number' };
      }
      for (const field of ['text', 'font', 'outline']) {
        if (!isString(e[field])) return { path: `${path}.${field}`, message: 'expected a string' };
      }
      if (e.align !== undefined && e.align !== 'center' && e.align !== 'right') {
        return { path: `${path}.align`, message: 'expected "center" or "right"' };
      }
    }
    if (e.kind === 'spline') {
      if (e.mode !== 'control' && e.mode !== 'fit') {
        return { path: `${path}.mode`, message: 'expected "control" or "fit"' };
      }
      if (!Array.isArray(e.points) || e.points.length < 2) {
        return { path: `${path}.points`, message: 'expected at least two point ids' };
      }
      if (e.degree !== undefined && !(Number.isInteger(e.degree) && (e.degree as number) >= 1)) {
        return { path: `${path}.degree`, message: 'expected a positive integer' };
      }
      if (e.knots !== undefined) {
        const n = e.points.length;
        const p = splineDegree(n, (e.degree as number | undefined) ?? 3);
        if (!Array.isArray(e.knots) || !e.knots.every(isNumber) || !validKnots(e.knots, n, p)) {
          return { path: `${path}.knots`, message: 'expected a clamped knot vector' };
        }
      }
      if (
        e.handles !== undefined &&
        (!Array.isArray(e.handles) ||
          e.handles.length !== 2 ||
          !e.handles.every((h) => h === null || isString(h)))
      ) {
        return { path: `${path}.handles`, message: 'expected [point id | null, point id | null]' };
      }
    }
    kinds.set(e.id, e.kind as string);
  }
  for (const [i, e] of (entities as Raw[]).entries()) {
    const refs: Record<string, string[]> = {
      point: [],
      line: ['a', 'b'],
      circle: ['center'],
      arc: ['center', 'start', 'end'],
      ellipse: ['center', 'major', 'minor'],
      ellipticArc: ['center', 'major', 'minor', 'start', 'end'],
      spline: [],
      text: ['anchor'],
    };
    for (const field of refs[e.kind as string] ?? []) {
      const ref = e[field];
      if (!isString(ref) || kinds.get(ref) !== 'point') {
        return { path: `entities[${i}].${field}`, message: 'expected the id of a point entity' };
      }
    }
    if (e.kind === 'spline') {
      const ids = [...(e.points as unknown[]), ...((e.handles as unknown[] | undefined) ?? [])];
      for (const ref of ids) {
        if (ref === null) continue;
        if (!isString(ref) || kinds.get(ref) !== 'point') {
          return { path: `entities[${i}].points`, message: 'expected ids of point entities' };
        }
      }
    }
  }

  const refOk = (ref: unknown): boolean => isString(ref) && (ref === ORIGIN_ID || kinds.has(ref));
  for (const [i, c] of constraints.entries()) {
    const path = `constraints[${i}]`;
    if (!isRecord(c)) return { path, message: 'expected an object' };
    if (!isString(c.id) || c.id === '')
      return { path: `${path}.id`, message: 'expected a non-empty string' };
    if (ids.has(c.id)) return { path: `${path}.id`, message: `duplicate id "${c.id}"` };
    ids.add(c.id);
    if (!CONSTRAINT_KINDS.includes(c.kind as SketchConstraintKind)) {
      return { path: `${path}.kind`, message: `unknown constraint kind "${String(c.kind)}"` };
    }
    if (!Array.isArray(c.refs) || c.refs.length === 0 || !c.refs.every(refOk)) {
      return { path: `${path}.refs`, message: 'expected ids of entities of this sketch' };
    }
    if (c.value !== undefined && !isNumber(c.value)) {
      return { path: `${path}.value`, message: 'expected a number' };
    }
    if (c.kind === 'rotate' && !isNumber(c.value)) {
      return { path: `${path}.value`, message: 'expected the rotation angle in degrees' };
    }
  }
  const names = new Set<string>();
  for (const [i, d] of dimensions.entries()) {
    const path = `dimensions[${i}]`;
    if (!isRecord(d)) return { path, message: 'expected an object' };
    if (!isString(d.id) || d.id === '')
      return { path: `${path}.id`, message: 'expected a non-empty string' };
    if (ids.has(d.id)) return { path: `${path}.id`, message: `duplicate id "${d.id}"` };
    ids.add(d.id);
    if (!isString(d.name) || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(d.name)) {
      return { path: `${path}.name`, message: 'expected an identifier' };
    }
    if (names.has(d.name)) return { path: `${path}.name`, message: `duplicate name "${d.name}"` };
    names.add(d.name);
    if (!DIMENSION_KINDS.includes(d.kind as SketchDimensionKind)) {
      return { path: `${path}.kind`, message: `unknown dimension kind "${String(d.kind)}"` };
    }
    if (!Array.isArray(d.refs) || d.refs.length === 0 || !d.refs.every(refOk)) {
      return { path: `${path}.refs`, message: 'expected ids of entities of this sketch' };
    }
    if (!isNumber(d.value) || d.value < 0) {
      return { path: `${path}.value`, message: 'expected a non-negative number' };
    }
    if (d.expression !== undefined && !isString(d.expression)) {
      return { path: `${path}.expression`, message: 'expected a string' };
    }
    if (d.offset !== undefined && !isNumber(d.offset)) {
      return { path: `${path}.offset`, message: 'expected a number' };
    }
    if (d.along !== undefined && !isNumber(d.along)) {
      return { path: `${path}.along`, message: 'expected a number' };
    }
    if (d.driven !== undefined && typeof d.driven !== 'boolean') {
      return { path: `${path}.driven`, message: 'expected a boolean' };
    }
  }
  const projections = raw.projections;
  if (projections !== undefined) {
    if (!Array.isArray(projections)) return { path: 'projections', message: 'expected an array' };
    for (const [i, p] of projections.entries()) {
      const path = `projections[${i}]`;
      if (!isRecord(p)) return { path, message: 'expected an object' };
      if (!isString(p.id) || p.id === '') {
        return { path: `${path}.id`, message: 'expected a non-empty string' };
      }
      if (ids.has(p.id)) return { path: `${path}.id`, message: `duplicate id "${p.id}"` };
      ids.add(p.id);
      const source = p.source;
      if (
        !isRecord(source) ||
        (source.kind !== 'edge' && source.kind !== 'face') ||
        !isRecord(source.ref) ||
        !isString(source.ref.bodyId) ||
        !isString(source.ref.key) ||
        !isRecord(source.ref.signature)
      ) {
        return { path: `${path}.source`, message: 'expected an edge or face reference' };
      }
      if (
        !Array.isArray(p.entities) ||
        !p.entities.every((id) => isString(id) && kinds.has(id) && kinds.get(id) !== 'point')
      ) {
        return { path: `${path}.entities`, message: 'expected ids of curve entities' };
      }
    }
  }
  const patterns = raw.patterns;
  if (patterns !== undefined) {
    if (!Array.isArray(patterns)) return { path: 'patterns', message: 'expected an array' };
    const count = (v: unknown) => Number.isInteger(v) && (v as number) >= 2 && (v as number) <= 200;
    for (const [i, p] of patterns.entries()) {
      const path = `patterns[${i}]`;
      if (!isRecord(p)) return { path, message: 'expected an object' };
      if (!isString(p.id) || p.id === '') {
        return { path: `${path}.id`, message: 'expected a non-empty string' };
      }
      if (ids.has(p.id)) return { path: `${path}.id`, message: `duplicate id "${p.id}"` };
      ids.add(p.id);
      if (p.kind !== 'linear' && p.kind !== 'circular') {
        return { path: `${path}.kind`, message: 'expected "linear" or "circular"' };
      }
      if (!count(p.count)) return { path: `${path}.count`, message: 'expected an integer 2..200' };
      const entityIds = (v: unknown, min: number) =>
        Array.isArray(v) && v.length >= min && v.every((id) => isString(id) && kinds.has(id));
      if (!entityIds(p.sources, 1)) {
        return { path: `${path}.sources`, message: 'expected ids of entities of this sketch' };
      }
      if (!entityIds(p.created, 0)) {
        return { path: `${path}.created`, message: 'expected ids of entities of this sketch' };
      }
      if (p.kind === 'linear') {
        const lines = p.lines;
        if (
          !Array.isArray(lines) ||
          lines.length < 1 ||
          lines.length > 2 ||
          !lines.every((id) => isString(id) && kinds.get(id) === 'line')
        ) {
          return { path: `${path}.lines`, message: 'expected one or two line ids' };
        }
        if (
          (lines.length === 2) !== (p.count2 !== undefined) ||
          (p.count2 !== undefined && !count(p.count2))
        ) {
          return { path: `${path}.count2`, message: 'expected an integer 2..200 with two lines' };
        }
      } else {
        if (!isString(p.center) || !(p.center === ORIGIN_ID || kinds.get(p.center) === 'point')) {
          return { path: `${path}.center`, message: 'expected the id of a point entity' };
        }
        if (!isNumber(p.angle) || p.angle === 0 || Math.abs(p.angle) > 360) {
          return { path: `${path}.angle`, message: 'expected a non-zero angle within ±360' };
        }
      }
    }
  }
  const memory = raw.regionMemory;
  if (memory !== undefined) {
    if (!Array.isArray(memory)) return { path: 'regionMemory', message: 'expected an array' };
    for (const [i, m] of memory.entries()) {
      if (
        !isRecord(m) ||
        !isString(m.key) ||
        !isNumber(m.area) ||
        !Array.isArray(m.sample) ||
        m.sample.length !== 2 ||
        !m.sample.every(isNumber) ||
        !Array.isArray(m.box) ||
        m.box.length !== 4 ||
        !m.box.every(isNumber)
      ) {
        return { path: `regionMemory[${i}]`, message: 'expected { key, sample, area, box }' };
      }
    }
  }
  return null;
}
