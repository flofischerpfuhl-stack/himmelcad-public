/**
 * Which sketches the document uses up, and the ids of derived sketches
 * (assembler/MODULES.md §3 "Sketch usage"). Both are document facts every
 * module reads the same way — the History and Items panels hide consumed
 * sketches, `sketches.list` reports them — so they live here, computed from
 * the feature-kind registry (`featureKinds.ts` `sketchIdsUsedBy`), not from
 * a list of the kinds some module owns.
 */
import type { Feature } from './document.js';
import { sketchIdsUsedBy } from './featureKinds.js';

/** Sketch feature ids an active (not suppressed) feature reads profiles or lines from. */
export function consumedSketchIds(features: readonly Feature[]): Set<string> {
  const out = new Set<string>();
  for (const feature of features) {
    if (feature.suppressed) continue;
    for (const id of sketchIdsUsedBy(feature)) out.add(id);
  }
  return out;
}

/**
 * Id of the `index`-th sketch a feature derives (a Mirror step's mirrored
 * sketches and faces): `<featureId>:sketch:<index>`. Later steps reference
 * its profiles like a sketch's (`{ kind: 'sketch', featureId }`).
 */
export function derivedSketchId(featureId: string, index: number): string {
  return `${featureId}:sketch:${index}`;
}

/** The feature and index a derived-sketch id stands for, or `null` for any other id. */
export function parseDerivedSketchId(id: string): { featureId: string; index: number } | null {
  const match = /^(.*):sketch:(\d+)$/.exec(id);
  return match ? { featureId: match[1]!, index: Number(match[2]) } : null;
}
