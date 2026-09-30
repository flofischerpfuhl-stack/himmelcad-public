/**
 * Region fingerprints for geometric re-binding (known limit fixed
 * 2026-09-30): a region key is made of boundary entity ids, so deleting
 * and redrawing a boundary line changes the key. Every sketch commit
 * records the current regions' sample point, area and bounding box in
 * `regionMemory`, keeping the fingerprints of keys that vanished (bounded),
 * so the kernel can re-bind a reference to a redrawn profile by geometry
 * (`kernel/regionRebind.ts`) — deterministic, from the document only.
 */
import { detectRegions, loopPolygon, type SketchRegion } from './regions.js';
import type { RegionSignature, SketchData } from './types.js';

/** At most this many fingerprints of vanished regions are kept. */
const MAX_FORGOTTEN = 32;

export function regionSignature(region: SketchRegion): RegionSignature {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const [x, y] of loopPolygon(region.outer)) {
    x0 = Math.min(x0, x);
    y0 = Math.min(y0, y);
    x1 = Math.max(x1, x);
    y1 = Math.max(y1, y);
  }
  const r = (v: number) => Math.round(v * 1e6) / 1e6;
  return {
    key: region.key,
    sample: [r(region.sample[0]), r(region.sample[1])],
    area: r(region.area),
    box: [r(x0), r(y0), r(x1), r(y1)],
  };
}

/**
 * The sketch with `regionMemory` updated to its current regions (plus the
 * remembered fingerprints of keys that no longer exist, newest first).
 */
export function rememberRegions(sketch: SketchData, previous?: SketchData): SketchData {
  const current = detectRegions(sketch).map(regionSignature);
  const keys = new Set(current.map((s) => s.key));
  // The state before the edit contributes the regions it had (a file without memory yet).
  const earlier = previous ? (rememberRegions(previous).regionMemory ?? []) : [];
  const known = [...earlier, ...(sketch.regionMemory ?? [])].filter(
    (s, i, all) => all.findIndex((o) => o.key === s.key) === i,
  );
  const forgotten = known.filter((s) => !keys.has(s.key)).slice(0, MAX_FORGOTTEN);
  const memory = [...current, ...forgotten];
  if (memory.length === 0 && !sketch.regionMemory) return sketch;
  return { ...sketch, regionMemory: memory };
}

/**
 * Whether two fingerprints describe the same region: bounding boxes within
 * 1 % of the region size and areas within 1 %.
 */
export function sameRegionGeometry(a: RegionSignature, b: RegionSignature): boolean {
  const size = Math.max(a.box[2] - a.box[0], a.box[3] - a.box[1], 1e-6);
  const tol = size * 0.01;
  const boxOk = a.box.every((v, i) => Math.abs(v - b.box[i]!) <= tol);
  const areaOk = Math.abs(a.area - b.area) <= Math.max(1e-6, Math.abs(a.area) * 0.01);
  return boxOk && areaOk;
}
