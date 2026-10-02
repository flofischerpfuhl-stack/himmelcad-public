/**
 * A parameter edit (create, change, rename, delete) as ONE consistent
 * document change: the new parameter list, every sketch whose driving
 * dimensions read a parameter whose value changed (directly or through
 * other parameters) re-solved with the new values, and every feature
 * `*Expression` field re-resolved. Planning is pure and asynchronous (the
 * sketch solver is); the store commits the plan as one undo step only when
 * the document is still the one the plan was computed from
 * (`model/store.ts` `applyParameterPlan`), so the UI, the agent API and
 * Python (`doc.param`) share exactly this path.
 *
 * Refusals are all-or-nothing: an invalid name or expression, a reference
 * cycle, a sketch the solver cannot satisfy with the new values
 * (over-constrained, no solution, a dimension turning non-positive) or a
 * feature size expression that no longer resolves to a positive length
 * refuses the whole edit and nothing changes.
 */
import type { Feature } from '../../foundation/document/document.js';
import type { SketchFeature } from '../../foundation/sketch-solver/sketchFeature.js';
import {
  expressionFieldsOf,
  expressionReferences,
  findParameterDependents,
  findParameterUsages,
  isValidParameterName,
  PARAMETER_RANGE_FIELDS,
  parameterRangeViolation,
  renameInExpression,
  resolveFieldExpression,
  resolveParameterRanges,
  resolveParameterValues,
  type Parameter,
  type ParameterRange,
  type ParameterUnit,
  type ParameterUsage,
} from '../../foundation/document/parameters.js';
import { isPlainNumber } from '../../foundation/document/expressions.js';
import { rememberRegions } from '../../foundation/sketch-solver/regionMemory.js';
import { getSketchSolver } from '../../foundation/sketch-solver/solverProvider.js';
import { sketchDataOf } from '../../foundation/sketch-solver/types.js';

/** Creates (no `id`) or edits (`id` = parameter id or name) one parameter. */
export interface ParameterEdit {
  id?: string;
  name?: string;
  unit?: ParameterUnit;
  /** A typed value; without `expression` it replaces any formula. */
  value?: number;
  /** Source formula; `null` removes it (the parameter keeps its current value). */
  expression?: string | null;
  /**
   * Range bounds and slider step: a number, a formula/text with a unit
   * (`"wall * 2"`, `"5 mm"`), or `null`/`""` to remove; absent keeps them.
   */
  min?: number | string | null;
  max?: number | string | null;
  step?: number | string | null;
}

/** The parameter a refused edit would have put outside its range. */
export interface ParameterOutOfRange {
  parameterId: string;
  name: string;
  value: number;
  min?: number;
  max?: number;
}

export type ParameterChange = ParameterEdit | { delete: string };

/** A sketch the solver could not satisfy with the new parameter values. */
export interface ParameterConflict {
  featureId: string;
  featureName: string;
  message: string;
  /** Conflicting dimension/constraint ids of that sketch. */
  ids: string[];
}

export type ParameterPlan =
  | {
      ok: true;
      /** The affected parameter. */
      id: string;
      /** The document the plan was computed from (the store refuses a stale plan). */
      base: { features: readonly Feature[]; parameters: readonly Parameter[] };
      features: Feature[];
      parameters: Parameter[];
      /** Sketches re-solved with the new values. */
      resolvedSketchIds: string[];
      /** Every feature whose stored data changed (sketches, `*Expression` fields, renames). */
      changedFeatureIds: string[];
    }
  | {
      ok: false;
      message: string;
      usages?: ParameterUsage[];
      conflicts?: ParameterConflict[];
      outOfRange?: ParameterOutOfRange;
    };

export type ParameterEditResult =
  | { ok: true; id: string; resolvedSketchIds: string[]; changedFeatureIds: string[] }
  | {
      ok: false;
      message: string;
      usages?: ParameterUsage[];
      conflicts?: ParameterConflict[];
      outOfRange?: ParameterOutOfRange;
    };

type Doc = { features: readonly Feature[]; parameters: readonly Parameter[] };

function fail(
  message: string,
  extra: Omit<Extract<ParameterPlan, { ok: false }>, 'ok' | 'message'> = {},
): ParameterPlan {
  return { ok: false, message, ...extra };
}

function parsePlain(text: string): number {
  return Number(text.replace(/\s*(mm|°|deg)\s*$/i, '').replace(',', '.'));
}

/** A typed number, optionally negative and with a unit (`-2.5 mm`), or `null` for a formula. */
function signedPlain(text: string): number | null {
  const negative = /^\s*-/.test(text);
  const body = negative ? text.replace(/^\s*-/, '') : text;
  if (!isPlainNumber(body)) return null;
  const value = parsePlain(body.trim());
  return negative ? -value : value;
}

/**
 * The range fields after `change`: absent keeps the existing ones, `null`
 * or empty text removes, a number or plain text sets a bound, any other
 * text is a formula (resolved with the other parameters afterwards).
 */
function editRange(
  existing: Parameter | undefined,
  change: ParameterEdit,
): Partial<Parameter> | string {
  const out: Partial<Parameter> = {};
  for (const field of PARAMETER_RANGE_FIELDS) {
    const input = change[field];
    const formulaKey = `${field}Expression` as const;
    if (input === undefined) {
      if (existing?.[field] !== undefined) out[field] = existing[field];
      if (existing?.[formulaKey] !== undefined) out[formulaKey] = existing[formulaKey];
      continue;
    }
    if (input === null) continue;
    if (typeof input === 'number') {
      if (!Number.isFinite(input)) return `${field} must be a finite number`;
      out[field] = input;
      continue;
    }
    const text = input.trim();
    if (text === '') continue;
    const plain = signedPlain(text);
    if (plain !== null) {
      if (!Number.isFinite(plain)) return `${field} must be a finite number`;
      out[field] = plain;
      continue;
    }
    out[formulaKey] = text;
    // Resolved with the other parameters' values below.
    out[field] = existing?.[field] ?? 0;
  }
  return out;
}

function rangeKey(range: ParameterRange | undefined): string {
  return range ? `${range.min ?? ''}|${range.max ?? ''}|${range.step ?? ''}` : '||';
}

/** Rewrites every expression in the document that reads `from` to read `to`. */
function renameEverywhere(
  features: readonly Feature[],
  parameters: readonly Parameter[],
  from: string,
  to: string,
): { features: Feature[]; parameters: Parameter[] } {
  const nextParameters = parameters.map((p) => {
    let out = p;
    for (const key of ['expression', 'minExpression', 'maxExpression', 'stepExpression'] as const) {
      const text = out[key];
      if (text !== undefined && expressionReferences(text).includes(from)) {
        out = { ...out, [key]: renameInExpression(text, from, to) };
      }
    }
    return out;
  });
  const nextFeatures = features.map((f) => {
    let changed: Feature = f;
    if (f.kind === 'sketch') {
      const own = new Set(f.dimensions.map((d) => d.name));
      // A sketch's own dimension of the same name shadows the parameter.
      if (
        !own.has(from) &&
        f.dimensions.some(
          (d) => d.expression !== undefined && expressionReferences(d.expression).includes(from),
        )
      ) {
        changed = {
          ...f,
          dimensions: f.dimensions.map((d) =>
            d.expression !== undefined
              ? { ...d, expression: renameInExpression(d.expression, from, to) }
              : d,
          ),
        };
      }
    }
    for (const field of expressionFieldsOf(f.kind)) {
      const key = `${field}Expression`;
      const expression = (changed as unknown as Record<string, unknown>)[key];
      if (typeof expression === 'string' && expressionReferences(expression).includes(from)) {
        changed = { ...changed, [key]: renameInExpression(expression, from, to) } as Feature;
      }
    }
    return changed;
  });
  return { features: nextFeatures, parameters: nextParameters };
}

/** Document parameter names a sketch's driving dimensions read (its own dimension names excluded). */
export function sketchParameterReferences(sketch: SketchFeature): Set<string> {
  const own = new Set(sketch.dimensions.map((d) => d.name));
  const names = new Set<string>();
  for (const d of sketch.dimensions) {
    if (d.driven || d.expression === undefined) continue;
    for (const name of expressionReferences(d.expression)) if (!own.has(name)) names.add(name);
  }
  return names;
}

/**
 * Plans `change` against `doc`. `newId` allocates the id of a created
 * parameter. Never mutates `doc`.
 */
export async function planParameterChange(
  doc: Doc,
  change: ParameterChange,
  newId: () => string,
): Promise<ParameterPlan> {
  let features: Feature[] = [...doc.features];
  let parameters: Parameter[];
  let id: string;

  if ('delete' in change) {
    const existing = doc.parameters.find((p) => p.id === change.delete || p.name === change.delete);
    if (!existing) return fail(`No parameter "${change.delete}"`);
    const usages = [
      ...findParameterDependents(doc.parameters, existing.name),
      ...findParameterUsages(doc.features, existing.name),
    ];
    if (usages.length > 0) {
      return fail(
        `"${existing.name}" is used by ${usages.length} field${usages.length === 1 ? '' : 's'}`,
        { usages },
      );
    }
    id = existing.id;
    parameters = doc.parameters.filter((p) => p.id !== existing.id);
  } else {
    const existing =
      change.id !== undefined
        ? doc.parameters.find((p) => p.id === change.id || p.name === change.id)
        : undefined;
    if (change.id !== undefined && !existing) return fail(`No parameter "${change.id}"`);
    const name = (change.name ?? existing?.name ?? '').trim();
    if (!isValidParameterName(name)) return fail(`"${name}" is not a valid parameter name`);
    if (doc.parameters.some((p) => p.name === name && p.id !== existing?.id)) {
      return fail(`A parameter named "${name}" already exists`);
    }
    // Value vs formula: an explicit formula wins; a typed value alone replaces the formula.
    let expression: string | undefined;
    let value: number;
    if (typeof change.expression === 'string' && change.expression.trim() !== '') {
      const text = change.expression.trim();
      if (isPlainNumber(text)) {
        value = parsePlain(text);
      } else {
        expression = text;
        value = existing?.value ?? 0;
      }
    } else if (change.expression === null || change.value !== undefined) {
      value = change.value ?? existing?.value ?? 0;
    } else {
      expression = existing?.expression;
      value = existing?.value ?? 0;
    }
    if (!Number.isFinite(value)) return fail(`${name}: not a finite number`);
    const range = editRange(existing, change);
    if (typeof range === 'string') return fail(`${name}: ${range}`);
    id = existing?.id ?? newId();
    const next: Parameter = {
      id,
      name,
      unit: change.unit ?? existing?.unit ?? 'mm',
      value,
      ...(expression !== undefined ? { expression } : {}),
      ...range,
    };
    parameters = existing
      ? doc.parameters.map((p) => (p.id === existing.id ? next : p))
      : [...doc.parameters, next];
    if (existing && existing.name !== name) {
      const renamed = renameEverywhere(features, parameters, existing.name, name);
      features = renamed.features;
      parameters = renamed.parameters;
    }
  }

  const resolved = resolveParameterValues(parameters);
  if (!resolved.ok) return fail(resolved.message);
  const ranges = resolveParameterRanges(parameters, resolved.values);
  if (!ranges.ok) return fail(`${ranges.message}. Nothing was changed.`);
  const nextParameters = parameters.map((p) => {
    const range = ranges.ranges.get(p.id) ?? {};
    const out: Parameter = { ...p, value: resolved.values.get(p.name) ?? p.value };
    // Formula bounds keep their last resolved value next to the formula (like `value`).
    for (const field of PARAMETER_RANGE_FIELDS) {
      if (p[`${field}Expression`] !== undefined && range[field] !== undefined) {
        out[field] = range[field];
      }
    }
    return out;
  });

  // Parameters whose resolved value changed (a created parameter counts as changed).
  const before = resolveParameterValues(doc.parameters);
  const oldById = new Map(
    doc.parameters.map((p) => [p.id, before.ok ? before.values.get(p.name) : undefined]),
  );
  const changedNames = new Set(
    nextParameters
      .filter((p) => !oldById.has(p.id) || oldById.get(p.id) !== p.value)
      .map((p) => p.name),
  );

  // A value outside its range is refused, never clamped. Only what this edit touches is
  // checked (the edited parameter, changed values, changed ranges), so a document that
  // already holds an out-of-range value (an older file) can still be edited elsewhere.
  const rangesBefore = before.ok ? resolveParameterRanges(doc.parameters, before.values) : null;
  for (const p of nextParameters) {
    const range = ranges.ranges.get(p.id) ?? {};
    const previous = rangesBefore?.ok ? rangesBefore.ranges.get(p.id) : undefined;
    const touched =
      p.id === id || changedNames.has(p.name) || rangeKey(previous) !== rangeKey(range);
    if (!touched) continue;
    const violation = parameterRangeViolation(p, p.value, range);
    if (violation) {
      return fail(`${violation}. Nothing was changed.`, {
        outOfRange: {
          parameterId: p.id,
          name: p.name,
          value: p.value,
          ...(range.min !== undefined ? { min: range.min } : {}),
          ...(range.max !== undefined ? { max: range.max } : {}),
        },
      });
    }
  }

  // Re-solve every sketch that reads a changed value, with the new values.
  const paramValues = [...resolved.values] as [string, number][];
  const conflicts: ParameterConflict[] = [];
  const resolvedSketchIds: string[] = [];
  for (let i = 0; i < features.length; i += 1) {
    const feature = features[i]!;
    if (feature.kind !== 'sketch') continue;
    const reads = sketchParameterReferences(feature);
    if (![...reads].some((name) => changedNames.has(name))) continue;
    const sketch = sketchDataOf(feature);
    const result = await getSketchSolver().solve({ sketch, paramValues });
    if (result.status !== 'ok') {
      conflicts.push({
        featureId: feature.id,
        featureName: feature.name,
        message: result.message ?? `the sketch cannot be solved (${result.status})`,
        ids: [...result.conflicting],
      });
      continue;
    }
    features[i] = { ...feature, ...rememberRegions(result.sketch, sketch) } as SketchFeature;
    resolvedSketchIds.push(feature.id);
  }
  if (conflicts.length > 0) {
    const first = conflicts[0]!;
    return fail(
      `${first.featureName}: ${first.message}${
        conflicts.length > 1
          ? ` (and ${conflicts.length - 1} more sketch${conflicts.length > 2 ? 'es' : ''})`
          : ''
      }. Nothing was changed.`,
      { conflicts },
    );
  }

  // Re-resolve feature size expressions; one that no longer gives a positive length refuses the edit.
  for (let i = 0; i < features.length; i += 1) {
    for (const field of expressionFieldsOf(features[i]!.kind)) {
      const feature = features[i]!;
      const expression = (feature as unknown as Record<string, unknown>)[`${field}Expression`];
      if (typeof expression !== 'string') continue;
      const value = resolveFieldExpression(feature.kind, field, expression, resolved.values);
      if (!value.ok) {
        if (expressionReferences(expression).some((name) => changedNames.has(name))) {
          return fail(
            `${feature.name}: ${field} "${expression}" ${value.message}. Nothing was changed.`,
          );
        }
        continue;
      }
      if ((feature as unknown as Record<string, unknown>)[field] !== value.value) {
        features[i] = { ...feature, [field]: value.value } as Feature;
      }
    }
  }

  const changedFeatureIds = features.filter((f, i) => f !== doc.features[i]).map((f) => f.id);
  return {
    ok: true,
    id,
    base: doc,
    features,
    parameters: nextParameters,
    resolvedSketchIds,
    changedFeatureIds,
  };
}
