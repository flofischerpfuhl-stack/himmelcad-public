/**
 * Best-effort rebind of a sketch-profile reference whose region key no
 * longer exists because boundary geometry was redrawn (a deleted and
 * re-drawn line gets a new entity id, so the region key — the sorted ids of
 * its boundary entities — changes). Deterministic: it only looks at the
 * document, never at earlier evaluations.
 *
 * 1. **Unchanged edges.** The entities of the missing key that still exist
 *    must all bound exactly one free region (one no other reference of the
 *    feature uses); among several, one with the same number of boundary
 *    entities wins if it is unique.
 * 2. **Only profile.** If none of its entities survive, a sketch with
 *    exactly one free region re-binds to it.
 *
 * Every rebind is reported as a warning on the feature; anything else stays
 * a `Missing reference: profile …` error (never a silent guess).
 */
import type { SketchFeature } from '../model/document.js';
import type { SketchRegion } from '../sketch/regions.js';

/** Entity ids of a region key (`l1+l2+l4@LR#0` → `[l1, l2, l4]`). */
function keyEntities(key: string): string[] {
  return key
    .replace(/[@#].*$/, '')
    .split('+')
    .filter(Boolean);
}

export function rebindRegion(
  missingKey: string,
  regions: readonly SketchRegion[],
  bound: ReadonlySet<string>,
  sketch: Pick<SketchFeature, 'entities' | 'name'>,
): { region: SketchRegion; message: string } | null {
  const free = regions.filter((r) => !bound.has(r.key));
  if (free.length === 0) return null;
  const wanted = keyEntities(missingKey);
  const existing = new Set(sketch.entities.map((e) => e.id));
  const surviving = wanted.filter((id) => existing.has(id));
  if (surviving.length > 0) {
    let candidates = free.filter((r) => {
      const ids = new Set(keyEntities(r.key));
      return surviving.every((id) => ids.has(id));
    });
    if (candidates.length > 1) {
      const sameSize = candidates.filter((r) => keyEntities(r.key).length === wanted.length);
      if (sameSize.length === 1) candidates = sameSize;
    }
    if (candidates.length !== 1) return null;
    const region = candidates[0]!;
    return {
      region,
      message:
        `Profile "${missingKey}" of "${sketch.name}" was redrawn; re-bound to "${region.key}" ` +
        `by its unchanged edges (${surviving.join(', ')}) — check the result`,
    };
  }
  if (free.length !== 1) return null;
  const region = free[0]!;
  return {
    region,
    message:
      `Profile "${missingKey}" of "${sketch.name}" was redrawn; re-bound to the sketch's only ` +
      `remaining profile "${region.key}" — check the result`,
  };
}
