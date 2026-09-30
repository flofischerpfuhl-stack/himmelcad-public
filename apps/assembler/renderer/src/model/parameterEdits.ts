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
import type { Feature, SketchFeature } from './document.js';
import {
  expressionFieldsOf,
  expressionReferences,
  findParameterDependents,
  findParameterUsages,
  isValidParameterName,
  renameInExpression,
  resolveFieldExpression,
  resolveParameterValues,
  type Parameter,
  type ParameterUnit,
  type ParameterUsage,
} from './parameters.js';
import { isPlainNumber } from '../sketch/expressions.js';
import { rememberRegions } from '../sketch/regionMemory.js';
import { getSketchSolver } from '../sketch/solverProvider.js';
import { sketchDataOf } from '../sketch/types.js';

/** Creates (no `id`) or edits (`id` = parameter id or name) one parameter. */
export interface ParameterEdit {
  id?: string;
  name?: string;
  unit?: ParameterUnit;
  /** A typed value; without `expression` it replaces any formula. */
  value?: number;
  /** Source formula; `null` removes it (the parameter keeps its current value). */
  expression?: string | null;
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
    };

export type ParameterEditResult =
  | { ok: true; id: string; resolvedSketchIds: string[]; changedFeatureIds: string[] }
  | { ok: false; message: string; usages?: ParameterUsage[]; conflicts?: ParameterConflict[] };

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

/** Rewrites every expression in the document that reads `from` to read `to`. */
function renameEverywhere(
  features: readonly Feature[],
  parameters: readonly Parameter[],
  from: string,
  to: string,
): { features: Feature[]; parameters: Parameter[] } {
  const nextParameters = parameters.map((p) =>
    p.expression !== undefined && expressionReferences(p.expression).includes(from)
      ? { ...p, expression: renameInExpression(p.expression, from, to) }
      : p,
  );
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
    id = existing?.id ?? newId();
    const next: Parameter = {
      id,
      name,
      unit: change.unit ?? existing?.unit ?? 'mm',
      value,
      ...(expression !== undefined ? { expression } : {}),
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
  const nextParameters = parameters.map((p) => ({
    ...p,
    value: resolved.values.get(p.name) ?? p.value,
  }));

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
