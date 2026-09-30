/**
 * Values of a sketch's driving dimensions: every dimension expression
 * (`../document/expressions.ts`) evaluated in dependency order, reading the
 * document's parameters for names the sketch does not define.
 */
import { isPlainNumber, parseDimensionExpression } from '../document/expressions.js';
import type { SketchDimension } from './types.js';

export type DimensionValues =
  | { ok: true; values: Map<string, number> }
  | { ok: false; dimensionId: string; message: string };

/**
 * Evaluates every dimension's expression in dependency order. Plain
 * dimensions keep their stored value. A name not found among the sketch's
 * own dimensions is looked up in `paramValues` (the document's parameters,
 * `model/parameters.ts`), so a sketch dimension expression may read both
 * (`"wall * 2"`, `"d1 + wall"`). Fails on a syntax error, an unknown name, a
 * reference cycle or a non-positive result.
 */
export function resolveDimensionValues(
  dimensions: readonly SketchDimension[],
  paramValues?: ReadonlyMap<string, number>,
): DimensionValues {
  const byName = new Map(dimensions.map((d) => [d.name, d]));
  const values = new Map<string, number>();
  const state = new Map<string, 'visiting' | 'done'>();
  let failure: { dimensionId: string; message: string } | null = null;

  const visit = (d: SketchDimension): number | null => {
    if (state.get(d.id) === 'done') return values.get(d.id) ?? null;
    if (state.get(d.id) === 'visiting') {
      failure ??= { dimensionId: d.id, message: `Circular reference involving ${d.name}` };
      return null;
    }
    state.set(d.id, 'visiting');
    let value: number | null = d.value;
    if (d.expression !== undefined && !isPlainNumber(d.expression)) {
      const parsed = parseDimensionExpression(d.expression);
      if (!parsed) {
        failure ??= {
          dimensionId: d.id,
          message: `${d.name}: invalid expression "${d.expression}"`,
        };
        return null;
      }
      value = parsed.evaluate((name) => {
        const other = byName.get(name);
        if (other) return visit(other);
        const paramValue = paramValues?.get(name);
        if (paramValue !== undefined) return paramValue;
        failure ??= { dimensionId: d.id, message: `${d.name}: unknown name "${name}"` };
        return null;
      });
      if (value === null) {
        failure ??= { dimensionId: d.id, message: `${d.name}: cannot evaluate "${d.expression}"` };
        return null;
      }
    }
    const allowsZero = d.kind === 'horizontalDistance' || d.kind === 'verticalDistance';
    if (!(value > 0 || (allowsZero && value === 0))) {
      failure ??= { dimensionId: d.id, message: `${d.name} must be positive` };
      return null;
    }
    state.set(d.id, 'done');
    values.set(d.id, value);
    return value;
  };

  for (const d of dimensions) {
    visit(d);
    if (failure) return { ok: false, ...(failure as { dimensionId: string; message: string }) };
  }
  return { ok: true, values };
}
