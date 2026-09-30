/**
 * Name completion for expression fields (parameters, sketch dimension
 * names): which identifier the caret is in, which names match it, and the
 * text after accepting one. Pure (no DOM), shared by
 * `ExpressionSuggestInput.tsx` and its tests.
 */

export interface SuggestionCandidate {
  name: string;
  /** Secondary text (current value, "parameter", "dimension"). */
  detail?: string;
}

export interface IdentifierToken {
  start: number;
  end: number;
  prefix: string;
}

const IDENT_CHAR = /[A-Za-z0-9_]/;

/**
 * The identifier the caret is at the end of (`wa|` in `2 * wa|`), or
 * `null` when the caret is not right after a name (after a digit-led token
 * such as `3`, an operator, a space).
 */
export function identifierAt(text: string, caret: number): IdentifierToken | null {
  const at = Math.max(0, Math.min(caret, text.length));
  let start = at;
  while (start > 0 && IDENT_CHAR.test(text[start - 1]!)) start -= 1;
  let end = at;
  while (end < text.length && IDENT_CHAR.test(text[end]!)) end += 1;
  if (start === at) return null;
  const prefix = text.slice(start, at);
  if (!/^[A-Za-z_]/.test(prefix)) return null;
  return { start, end, prefix };
}

/**
 * Candidates matching `prefix` (case-insensitive): names that start with it
 * first, then names that contain it, each group alphabetically; the exact
 * name alone is no suggestion (nothing left to complete). At most `limit`.
 */
export function matchSuggestions(
  prefix: string,
  candidates: readonly SuggestionCandidate[],
  limit = 8,
): SuggestionCandidate[] {
  const p = prefix.toLowerCase();
  const seen = new Set<string>();
  const unique = candidates.filter((c) => !seen.has(c.name) && seen.add(c.name));
  if (
    unique.some((c) => c.name === prefix) &&
    unique.filter((c) => c.name.toLowerCase().startsWith(p)).length === 1
  ) {
    return [];
  }
  const byName = (a: SuggestionCandidate, b: SuggestionCandidate) => a.name.localeCompare(b.name);
  const starts = unique.filter((c) => c.name.toLowerCase().startsWith(p)).sort(byName);
  const contains = unique
    .filter((c) => !c.name.toLowerCase().startsWith(p) && c.name.toLowerCase().includes(p))
    .sort(byName);
  return [...starts, ...contains].slice(0, limit);
}

/** Replaces the token with `name`; the caret goes right after it. */
export function acceptSuggestion(
  text: string,
  token: IdentifierToken,
  name: string,
): { text: string; caret: number } {
  return {
    text: text.slice(0, token.start) + name + text.slice(token.end),
    caret: token.start + name.length,
  };
}

/** Next highlighted row for an arrow key (wraps around). */
export function moveActive(active: number, count: number, key: 'ArrowDown' | 'ArrowUp'): number {
  if (count === 0) return -1;
  if (key === 'ArrowDown') return active < 0 ? 0 : (active + 1) % count;
  return active <= 0 ? count - 1 : active - 1;
}

/** Parameters as completion candidates, each with its current value and unit. */
export function parameterCandidates(
  parameters: readonly { name: string; unit: string; value: number }[],
  exclude?: string,
): SuggestionCandidate[] {
  return parameters
    .filter((p) => p.name !== exclude)
    .map((p) => ({
      name: p.name,
      detail: `${Math.round(p.value * 1000) / 1000}${p.unit === 'deg' ? '°' : p.unit ? ` ${p.unit}` : ''}`,
    }));
}
/**
 * Candidates of a sketch dimension field: the sketch's other driving
 * dimensions (they shadow parameters of the same name), then parameters.
 */
export function sketchDimensionCandidates(
  dimensions: readonly { name: string; value: number; driven?: boolean; kind: string }[],
  parameters: readonly { name: string; unit: string; value: number }[],
  editing: string,
): SuggestionCandidate[] {
  const own = dimensions
    .filter((d) => d.name !== editing && !d.driven)
    .map((d) => ({
      name: d.name,
      detail: `${Math.round(d.value * 1000) / 1000}${d.kind === 'angle' ? '°' : ' mm'} · dimension`,
    }));
  const taken = new Set(dimensions.map((d) => d.name));
  return [...own, ...parameterCandidates(parameters.filter((p) => !taken.has(p.name)))];
}
