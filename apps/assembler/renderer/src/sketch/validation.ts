/**
 * Strict structural validation of stored sketch data (project loading and
 * the agent/automation path): known kinds, finite numbers, unique ids and
 * references that resolve. Geometric consistency (whether the constraints
 * can be satisfied) is the solver's job, not this validator's.
 */
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
    kinds.set(e.id, e.kind as string);
  }
  for (const [i, e] of (entities as Raw[]).entries()) {
    const refs: Record<string, string[]> = {
      point: [],
      line: ['a', 'b'],
      circle: ['center'],
      arc: ['center', 'start', 'end'],
    };
    for (const field of refs[e.kind as string] ?? []) {
      const ref = e[field];
      if (!isString(ref) || kinds.get(ref) !== 'point') {
        return { path: `entities[${i}].${field}`, message: 'expected the id of a point entity' };
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
  }
  return null;
}
