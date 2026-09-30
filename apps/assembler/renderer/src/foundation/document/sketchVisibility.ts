/**
 * Viewport visibility of sketches (Shapr3D): a sketch whose profiles a later
 * step consumes (an extrude, a revolve, …, as each kind declares with
 * `sketchIdsUsedBy` in the feature-kind registry) is hidden by default; an
 * explicit user choice wins. Pure data; no store.
 */
import type { Feature } from './document.js';
import { sketchIdsUsedBy } from './featureKinds.js';

/** Sketches consumed by a (non-suppressed) step: hidden by default, like Shapr3D. */
export function consumedSketchIds(features: readonly Feature[]): Set<string> {
  const out = new Set<string>();
  for (const f of features) {
    if (!f.suppressed) for (const id of sketchIdsUsedBy(f)) out.add(id);
  }
  return out;
}

/** Visibility of a sketch in the viewport: an explicit user choice wins, else hidden once consumed. */
export function isSketchVisible(
  featureId: string,
  consumed: ReadonlySet<string>,
  overrides: Readonly<Record<string, boolean>>,
): boolean {
  const override = overrides[featureId];
  if (override !== undefined) return override;
  return !consumed.has(featureId);
}
