/**
 * Document parameters ("variables"): named numeric values, usable from
 * expressions anywhere a numeric field accepts one — sketch dimensions
 * (`sketch/expressions.ts`, which falls back to these names once a sketch's
 * own dimension names are exhausted) and the size fields of extrude,
 * fillet, chamfer and shell features (`*Expression` fields in
 * `model/document.ts`, resolved by {@link resolveFeatureExpression}).
 *
 * Same small recursive-descent grammar as sketch dimension expressions
 * (`+ - * /`, parentheses, unary minus, decimal numbers, an optional
 * trailing unit) — reused directly, not reimplemented, so the two layers of
 * expressions can never drift apart.
 */
import { isPlainNumber, parseDimensionExpression } from './expressions.js';
import { expressionFieldsOf, isSignedExpressionField } from './featureKinds.js';

/** A parameter's display/storage unit. Purely a label: values are always stored resolved in millimetres/degrees. */
export type ParameterUnit = 'mm' | 'deg' | '';

/** One document-level named parameter ("variable"), schema v3. */
export interface Parameter {
  /** Stable, unique identifier. Never reused. */
  id: string;
  /** Unique, case-sensitive name; must be a valid expression identifier (`[A-Za-z_][A-Za-z0-9_]*`). */
  name: string;
  unit: ParameterUnit;
  /** Always the last successfully resolved value (mirrors `SketchDimension.value`). */
  value: number;
  /** Source formula, when the value is computed rather than typed directly. */
  expression?: string;
  /**
   * Allowed range (Block 9, optional and additive): the last resolved bounds.
   * A typed or computed value outside them is refused with a clear error
   * (never clamped); only the slider clamps, because it cannot leave them.
   */
  min?: number;
  max?: number;
  /** Slider increment (> 0). An input aid, not a constraint: typed values may lie between steps. */
  step?: number;
  /** Source formulas of the bounds/step (other parameters, units), like `expression`. */
  minExpression?: string;
  maxExpression?: string;
  stepExpression?: string;
}

/** The range fields of a parameter. */
export const PARAMETER_RANGE_FIELDS = ['min', 'max', 'step'] as const;
export type ParameterRangeField = (typeof PARAMETER_RANGE_FIELDS)[number];

/** A parameter's resolved range (each part optional). */
export interface ParameterRange {
  min?: number;
  max?: number;
  step?: number;
}

/** Whether `p` declares any range field. */
export function hasParameterRange(p: Parameter): boolean {
  return p.min !== undefined || p.max !== undefined || p.step !== undefined;
}

/** Tolerance of the range check (resolved formulas carry float noise). */
const RANGE_EPSILON = 1e-9;

/**
 * Resolves the range of every parameter against the resolved `values`: a
 * bound with a formula is evaluated (it may read other parameters, never
 * feeds back into values, so it cannot form a cycle), a plain bound is
 * kept. Fails on the first bound that does not resolve, on `min > max` and
 * on a step that is not positive.
 */
export function resolveParameterRanges(
  parameters: readonly Parameter[],
  values: ReadonlyMap<string, number>,
):
  | { ok: true; ranges: Map<string, ParameterRange> }
  | { ok: false; parameterId: string; message: string } {
  const ranges = new Map<string, ParameterRange>();
  for (const p of parameters) {
    const range: ParameterRange = {};
    for (const field of PARAMETER_RANGE_FIELDS) {
      const expression = p[`${field}Expression`];
      let value = p[field];
      if (expression !== undefined) {
        const resolved = resolveFeatureExpression(expression, values, { signed: true });
        if (!resolved.ok) {
          return {
            ok: false,
            parameterId: p.id,
            message: `${p.name}: ${field} "${expression}" ${resolved.message}`,
          };
        }
        value = resolved.value;
      }
      if (value !== undefined) range[field] = value;
    }
    if (
      range.min !== undefined &&
      range.max !== undefined &&
      range.min > range.max + RANGE_EPSILON
    ) {
      return {
        ok: false,
        parameterId: p.id,
        message: `${p.name}: min ${formatRangeValue(range.min, p.unit)} is greater than max ${formatRangeValue(range.max, p.unit)}`,
      };
    }
    if (range.step !== undefined && !(range.step > 0)) {
      return { ok: false, parameterId: p.id, message: `${p.name}: step must be positive` };
    }
    ranges.set(p.id, range);
  }
  return { ok: true, ranges };
}

/** `null` when `value` lies within `range`, else the reason (names the parameter and the range). */
export function parameterRangeViolation(
  p: Pick<Parameter, 'name' | 'unit'>,
  value: number,
  range: ParameterRange,
): string | null {
  const below = range.min !== undefined && value < range.min - RANGE_EPSILON;
  const above = range.max !== undefined && value > range.max + RANGE_EPSILON;
  if (!below && !above) return null;
  return `${p.name} = ${formatRangeValue(value, p.unit)} is outside its range ${describeParameterRange(range, p.unit)}`;
}

/** "2–10 mm", "≥ 2 mm", "≤ 10°" (an empty string without bounds). */
export function describeParameterRange(range: ParameterRange, unit: ParameterUnit): string {
  if (range.min !== undefined && range.max !== undefined) {
    return `${trimNumber(range.min)}–${formatRangeValue(range.max, unit)}`;
  }
  if (range.min !== undefined) return `≥ ${formatRangeValue(range.min, unit)}`;
  if (range.max !== undefined) return `≤ ${formatRangeValue(range.max, unit)}`;
  return '';
}

function trimNumber(value: number): string {
  return String(Math.round(value * 1e6) / 1e6);
}

function formatRangeValue(value: number, unit: ParameterUnit): string {
  const text = trimNumber(value);
  if (unit === 'mm') return `${text} mm`;
  if (unit === 'deg') return `${text}°`;
  return text;
}

const NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** `true` when `name` is syntactically usable as a parameter/expression identifier. */
export function isValidParameterName(name: string): boolean {
  return NAME_PATTERN.test(name);
}

export type ParameterValues =
  | { ok: true; values: Map<string, number> }
  | { ok: false; parameterId: string; message: string };

/**
 * Evaluates every parameter's expression in dependency order (topological,
 * cycle-checked). A parameter without an expression keeps its stored
 * `value`. Fails on a syntax error, an unknown name, a reference cycle or a
 * non-finite result — never partially resolves.
 */
export function resolveParameterValues(parameters: readonly Parameter[]): ParameterValues {
  const byName = new Map(parameters.map((p) => [p.name, p]));
  const values = new Map<string, number>();
  const state = new Map<string, 'visiting' | 'done'>();
  let failure: { parameterId: string; message: string } | null = null;

  const visit = (param: Parameter): number | null => {
    if (state.get(param.id) === 'done') return values.get(param.name) ?? null;
    if (state.get(param.id) === 'visiting') {
      failure ??= { parameterId: param.id, message: `Circular reference involving ${param.name}` };
      return null;
    }
    state.set(param.id, 'visiting');
    let value: number | null = param.value;
    if (param.expression !== undefined && !isPlainNumber(param.expression)) {
      const parsed = parseDimensionExpression(param.expression);
      if (!parsed) {
        failure ??= {
          parameterId: param.id,
          message: `${param.name}: invalid expression "${param.expression}"`,
        };
        return null;
      }
      value = parsed.evaluate((name) => {
        const other = byName.get(name);
        if (!other) {
          failure ??= { parameterId: param.id, message: `${param.name}: unknown name "${name}"` };
          return null;
        }
        return visit(other);
      });
      if (value === null) {
        failure ??= {
          parameterId: param.id,
          message: `${param.name}: cannot evaluate "${param.expression}"`,
        };
        return null;
      }
    }
    if (!Number.isFinite(value)) {
      failure ??= { parameterId: param.id, message: `${param.name}: not a finite number` };
      return null;
    }
    state.set(param.id, 'done');
    values.set(param.name, value);
    return value;
  };

  for (const p of parameters) {
    visit(p);
    if (failure) return { ok: false, ...(failure as { parameterId: string; message: string }) };
  }
  return { ok: true, values };
}

export type FeatureExpressionResult = { ok: true; value: number } | { ok: false; message: string };

/**
 * Resolves one feature numeric field's expression (extrude distance, fillet
 * radius, chamfer distance, shell thickness) against the current parameter
 * values. These fields are always lengths, so (like sketch distance
 * dimensions) a non-positive result is rejected.
 */
export function resolveFeatureExpression(
  expression: string,
  paramValues: ReadonlyMap<string, number>,
  options: { signed?: boolean } = {},
): FeatureExpressionResult {
  // Signed fields (a draft angle) accept any finite value; the feature's own validation bounds it.
  const accept = (value: number) => (options.signed ? Number.isFinite(value) : value > 0);
  const rule = options.signed ? 'must be a finite number' : 'must be positive';
  if (isPlainNumber(expression)) {
    const value = Number(expression.replace(/\s*(mm|°|deg)\s*$/i, '').replace(',', '.'));
    if (!accept(value)) return { ok: false, message: rule };
    return { ok: true, value };
  }
  const parsed = parseDimensionExpression(expression);
  if (!parsed) return { ok: false, message: `invalid expression "${expression}"` };
  let unknown: string | null = null;
  const value = parsed.evaluate((name) => {
    const v = paramValues.get(name);
    if (v === undefined) {
      unknown ??= name;
      return null;
    }
    return v;
  });
  if (unknown) return { ok: false, message: `unknown name "${unknown}"` };
  if (value === null) return { ok: false, message: `cannot evaluate "${expression}"` };
  if (!accept(value)) return { ok: false, message: rule };
  return { ok: true, value };
}

/** Every identifier an expression string reads (for rename/usage scanning). */
export function expressionReferences(expression: string): string[] {
  const parsed = parseDimensionExpression(expression);
  return parsed ? parsed.refs : [];
}

/** One place in the document that reads a parameter by name, for delete-refusal / usage listings. */
export interface ParameterUsage {
  kind: 'sketchDimension' | 'feature' | 'parameter';
  /** The referencing feature (for `sketchDimension`/`feature`) or parameter (for `parameter`) id. */
  featureId: string;
  /** The referencing feature's or parameter's display name. */
  featureName: string;
  /** Dimension name (sketch), field name (feature, e.g. `"distanceExpression"`) or `"expression"` (parameter). */
  field: string;
}

/** Every other parameter whose expression reads `paramName` (for delete-refusal). */
export function findParameterDependents(
  parameters: readonly Parameter[],
  paramName: string,
): ParameterUsage[] {
  const usages: ParameterUsage[] = [];
  for (const p of parameters) {
    for (const field of [
      'expression',
      'minExpression',
      'maxExpression',
      'stepExpression',
    ] as const) {
      const text = p[field];
      if (text !== undefined && expressionReferences(text).includes(paramName)) {
        usages.push({ kind: 'parameter', featureId: p.id, featureName: p.name, field });
      }
    }
  }
  return usages;
}

/**
 * A feature's numeric fields that accept a formula come from the kind's
 * registration (`featureKinds.ts` `expressionFields`): the plain field holds
 * the last resolved value (what the kernel reads), `<field>Expression` the
 * formula. All are positive lengths except the kind's
 * `signedExpressionFields` (a draft angle).
 */
export { expressionFieldsOf };

/** Resolves `kind.field`'s formula with that field's sign rule. */
export function resolveFieldExpression(
  kind: string,
  field: string,
  expression: string,
  paramValues: ReadonlyMap<string, number>,
): FeatureExpressionResult {
  return resolveFeatureExpression(expression, paramValues, {
    signed: isSignedExpressionField(kind, field),
  });
}

interface UsageScanFeature {
  id: string;
  name: string;
  kind: string;
}

/** Finds every sketch dimension and feature expression field referencing `paramName`. */
export function findParameterUsages(
  features: readonly UsageScanFeature[],
  paramName: string,
): ParameterUsage[] {
  const usages: ParameterUsage[] = [];
  for (const f of features) {
    const record = f as unknown as Record<string, unknown>;
    if (f.kind === 'sketch' && Array.isArray(record.dimensions)) {
      for (const d of record.dimensions as { name: string; expression?: string }[]) {
        if (d.expression !== undefined && expressionReferences(d.expression).includes(paramName)) {
          usages.push({
            kind: 'sketchDimension',
            featureId: f.id,
            featureName: f.name,
            field: d.name,
          });
        }
      }
    }
    for (const field of expressionFieldsOf(f.kind)) {
      const exprField = `${field}Expression`;
      const exprValue = record[exprField];
      if (typeof exprValue === 'string' && expressionReferences(exprValue).includes(paramName)) {
        usages.push({ kind: 'feature', featureId: f.id, featureName: f.name, field: exprField });
      }
    }
  }
  return usages;
}

/** Replaces every whole-word occurrence of `from` with `to` in an expression string. */
export function renameInExpression(expression: string, from: string, to: string): string {
  return expression.replace(new RegExp(`\\b${from}\\b`, 'g'), to);
}
