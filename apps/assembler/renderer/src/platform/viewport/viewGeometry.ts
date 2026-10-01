/**
 * View-level geometry the display features share with the viewport: the
 * union bounds of the visible bodies and the unit normal of the section
 * plane. Pure. The modelling tools' copies (`model/modeling.ts`
 * `visibleBounds`, `viewport/toolAnchors.ts` `sectionNormal`) compute the
 * same and can delegate here once the tool handles move to the viewport's
 * handle provider.
 */
import type { SectionAxis } from '../../foundation/commands/store.js';
import type { Body } from '../../foundation/geometry-kernel/types.js';
import type { Vec3 } from './math.js';

export interface ViewBounds {
  min: Vec3;
  max: Vec3;
}

/** Union bounding box of the visible bodies, or `null` when nothing is visible. */
export function visibleBodyBounds(
  bodies: readonly Pick<Body, 'id' | 'min' | 'max'>[],
  hiddenBodyIds: readonly string[],
  isolatedBodyIds: readonly string[] | null,
): ViewBounds | null {
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

/** The section view as the viewport draws it. */
export interface SectionPlaneView {
  axis: SectionAxis;
  offset: number;
  flipped: boolean;
  /** Face-aligned plane: replaces `axis` (unit `normal`). */
  plane?: { normal: Vec3; origin: Vec3 } | null;
}

const AXIS_UNIT: Record<SectionAxis, Vec3> = { X: [1, 0, 0], Y: [0, 1, 0], Z: [0, 0, 1] };

/** Unit normal of the clip plane (after Flip): material on its positive side is cut away. */
export function sectionPlaneNormal(section: SectionPlaneView): Vec3 {
  const unit = section.plane ? section.plane.normal : AXIS_UNIT[section.axis];
  if (!section.flipped) return unit;
  return [-unit[0] || 0, -unit[1] || 0, -unit[2] || 0]; // no -0 components
}
