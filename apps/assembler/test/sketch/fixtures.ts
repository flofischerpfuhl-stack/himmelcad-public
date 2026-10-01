/**
 * Test fixtures: sketch features built from simple rectangle/circle
 * profiles (the former v1 shapes), fully dimensioned like migrated files.
 */
import type { Plane, SketchPlaneRef } from '../../renderer/src/foundation/document/document.js';
import type { SketchFeature } from '../../renderer/src/foundation/sketch-solver/sketchFeature.js';
import {
  legacyProfileContains,
  sketchFromLegacyProfiles,
  type LegacySketchProfile,
} from '../../renderer/src/foundation/sketch-solver/builders.js';
import { detectRegions } from '../../renderer/src/foundation/sketch-solver/regions.js';

export type { LegacySketchProfile };

/**
 * A sketch feature holding the given profiles, plus the region key of each
 * profile (`regionKeys[i]` = key of the region inside profile `i`).
 */
export function sketchFeature(
  id: string,
  profiles: LegacySketchProfile[],
  plane: SketchPlaneRef | Plane = 'XY',
  name = 'Sketch 1',
): { feature: SketchFeature; regionKeys: string[] } {
  const { sketch } = sketchFromLegacyProfiles(profiles);
  const regions = detectRegions(sketch);
  const regionKeys = profiles.map((profile) => {
    const region = regions.find((r) => legacyProfileContains(profile, r.sample));
    if (!region) throw new Error('fixture profile has no region');
    return region.key;
  });
  return {
    feature: {
      id,
      name,
      suppressed: false,
      kind: 'sketch',
      plane: typeof plane === 'string' ? { kind: 'plane', plane, offset: 0 } : plane,
      ...sketch,
    },
    regionKeys,
  };
}

export function rect(x: number, y: number, width: number, height: number): LegacySketchProfile {
  return { kind: 'rectangle', x, y, width, height };
}

export function circle(cx: number, cy: number, radius: number): LegacySketchProfile {
  return { kind: 'circle', cx, cy, radius };
}
