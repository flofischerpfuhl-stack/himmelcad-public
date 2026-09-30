/**
 * Bounds of what the viewport shows (visible bodies) and the section-plane
 * defaults derived from them: used by the store's section actions, the
 * viewport and the display tools. Pure; no store, no DOM.
 */
import type { Vec3 } from '../document/document.js';
import type { Body } from '../geometry-kernel/types.js';

export type Axis = 'X' | 'Y' | 'Z';
const AXIS_INDEX: Record<Axis, 0 | 1 | 2> = { X: 0, Y: 1, Z: 2 };

export interface Bounds3 {
  min: Vec3;
  max: Vec3;
}

/** Union bounding box of the visible bodies, or `null` when nothing is visible. */
export function visibleBounds(
  bodies: readonly Body[],
  hiddenBodyIds: readonly string[],
  isolatedBodyIds: readonly string[] | null,
): Bounds3 | null {
  let min: Vec3 | null = null;
  let max: Vec3 | null = null;
  for (const body of bodies) {
    if (hiddenBodyIds.includes(body.id)) continue;
    if (isolatedBodyIds && !isolatedBodyIds.includes(body.id)) continue;
    min = min
      ? [
          Math.min(min[0], body.min[0]),
          Math.min(min[1], body.min[1]),
          Math.min(min[2], body.min[2]),
        ]
      : [...body.min];
    max = max
      ? [
          Math.max(max[0], body.max[0]),
          Math.max(max[1], body.max[1]),
          Math.max(max[2], body.max[2]),
        ]
      : [...body.max];
  }
  return min && max ? { min, max } : null;
}

/** Default section offset: through the centre of the visible model along `axis` (0 without a model). */
export function defaultSectionOffset(bounds: Bounds3 | null, axis: Axis): number {
  if (!bounds) return 0;
  const i = AXIS_INDEX[axis];
  return (bounds.min[i] + bounds.max[i]) / 2;
}

/** Extent of the model along `axis` (for clamping the section handle), with a margin. */
export function sectionRange(bounds: Bounds3 | null, axis: Axis): [number, number] {
  if (!bounds) return [-100, 100];
  const i = AXIS_INDEX[axis];
  const margin = Math.max(1, (bounds.max[i] - bounds.min[i]) * 0.05);
  return [bounds.min[i] - margin, bounds.max[i] + margin];
}
