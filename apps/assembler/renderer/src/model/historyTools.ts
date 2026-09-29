/**
 * Pure History-panel logic (unit tested): which steps are relevant to the
 * current selection, which steps a step depends on, and whether a step can
 * be moved to another position without breaking a reference.
 *
 * Dependencies are read from the feature data itself: every reference in
 * the document names the feature it comes from — sketch/profile ids,
 * `body:<feature id>` body ids and naming keys such as
 * `feature-extrude-1:end:0` (see `kernel/naming.ts`). A step therefore
 * depends on every other step whose id appears in its references, plus the
 * steps that created the bodies it works on.
 */
import type { EvaluationResult } from '../kernel/types.js';
import type { Feature } from './document.js';
import type { SelectionItem } from './store.js';

/** All strings inside a feature's data (ids, body ids, naming keys), excluding its own id/name. */
function referenceStrings(feature: Feature): string[] {
  const out: string[] = [];
  const visit = (value: unknown, key: string | null): void => {
    if (typeof value === 'string') {
      if (key !== 'id' && key !== 'name' && key !== 'data' && key !== 'fileName') out.push(value);
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value) visit(item, null);
      return;
    }
    if (value && typeof value === 'object') {
      for (const [k, v] of Object.entries(value)) visit(v, k);
    }
  };
  visit(feature, null);
  return out;
}

/** Feature ids a reference string mentions (`body:feature-x-1`, `feature-x-1:end|…`, `feature-x-1`). */
function mentionedIds(text: string, ids: ReadonlySet<string>): string[] {
  return text.split(/[|:~#@]+/).filter((token) => ids.has(token));
}

/** Ids of the features `feature` directly depends on (never itself). */
export function directDependencies(feature: Feature, features: readonly Feature[]): Set<string> {
  const ids = new Set(features.map((f) => f.id));
  const deps = new Set<string>();
  for (const text of referenceStrings(feature)) {
    for (const id of mentionedIds(text, ids)) if (id !== feature.id) deps.add(id);
  }
  return deps;
}

/** Map feature id → its direct dependencies. */
export function dependencyGraph(features: readonly Feature[]): Map<string, Set<string>> {
  return new Map(features.map((f) => [f.id, directDependencies(f, features)]));
}

export type MoveCheck = { ok: true } | { ok: false; reason: string };

/**
 * Whether the step at `from` may move to index `to` (index in the list
 * after removal, i.e. the final position). Moving earlier must not pass a
 * step it depends on; moving later must not pass a step that depends on it.
 */
export function checkMove(features: readonly Feature[], from: number, to: number): MoveCheck {
  const moving = features[from];
  if (!moving) return { ok: false, reason: 'That step no longer exists.' };
  if (to === from) return { ok: true };
  if (to < 0 || to >= features.length) return { ok: false, reason: 'Invalid position.' };
  const graph = dependencyGraph(features);
  if (to < from) {
    const passed = features.slice(to, from);
    const needed = passed.find((f) => graph.get(moving.id)?.has(f.id));
    if (needed) {
      return {
        ok: false,
        reason: `"${moving.name}" uses "${needed.name}", so it must stay after it.`,
      };
    }
  } else {
    const passed = features.slice(from + 1, to + 1);
    const dependent = passed.find((f) => graph.get(f.id)?.has(moving.id));
    if (dependent) {
      return {
        ok: false,
        reason: `"${dependent.name}" uses "${moving.name}", so "${moving.name}" must stay before it.`,
      };
    }
  }
  return { ok: true };
}

/** The feature list with the step at `from` moved to final index `to`. */
export function moveFeature(features: readonly Feature[], from: number, to: number): Feature[] {
  const next = [...features];
  const [moved] = next.splice(from, 1);
  if (!moved) return next;
  next.splice(Math.max(0, Math.min(next.length, to)), 0, moved);
  return next;
}

/**
 * Steps relevant to the selection (History "filter to selection"): the
 * selected steps themselves, the steps that create or change the selected
 * bodies (faces/edges count for their body) or sketches, and everything
 * those steps depend on.
 */
export function relevantFeatureIds(
  features: readonly Feature[],
  evaluation: EvaluationResult,
  selection: readonly SelectionItem[],
): Set<string> {
  const bodyIds = new Set<string>();
  const seeds = new Set<string>();
  for (const item of selection) {
    if (item.kind === 'feature' || item.kind === 'sketchProfile') seeds.add(item.featureId);
    else if (item.kind !== 'mesh') bodyIds.add(item.bodyId); // reference meshes have no steps
  }
  for (const bodyId of bodyIds) {
    const body = evaluation.bodies.find((b) => b.id === bodyId);
    if (body) seeds.add(body.createdBy);
  }
  // Steps that mention a selected body (fillets, moves, booleans, sketches on its faces …).
  if (bodyIds.size > 0) {
    for (const feature of features) {
      if (referenceStrings(feature).some((text) => [...bodyIds].some((id) => text.includes(id)))) {
        seeds.add(feature.id);
      }
    }
  }
  const graph = dependencyGraph(features);
  const out = new Set<string>();
  const stack = [...seeds];
  while (stack.length > 0) {
    const id = stack.pop()!;
    if (out.has(id) || !graph.has(id)) continue;
    out.add(id);
    for (const dep of graph.get(id) ?? []) stack.push(dep);
  }
  return out;
}
