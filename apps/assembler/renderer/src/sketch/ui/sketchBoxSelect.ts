/**
 * Box selection of sketch entities in sketch mode, pure (unit tested).
 * Same direction rule as the 3D box (`viewport/boxSelect.ts`): drag right
 * selects entities completely inside, drag left everything touched. While
 * dragging, Tab cycles All / Curves / Points; A, E (edges = curves) and P
 * choose directly.
 */
import {
  pointInRect,
  segmentTouchesRect,
  type BoxMode,
  type ScreenPoint,
  type ScreenRect,
} from '../../viewport/boxSelect.js';
import { entityCurve, sampleCurve } from '../geometry.js';
import { entityMap, isCurve, type SketchData, type Vec2 } from '../types.js';

export type SketchBoxFilter = 'all' | 'curves' | 'points';
export const SKETCH_BOX_FILTERS: readonly SketchBoxFilter[] = ['all', 'curves', 'points'];

export function nextSketchBoxFilter(filter: SketchBoxFilter, backwards = false): SketchBoxFilter {
  const i = SKETCH_BOX_FILTERS.indexOf(filter);
  const n = SKETCH_BOX_FILTERS.length;
  return SKETCH_BOX_FILTERS[(i + (backwards ? n - 1 : 1)) % n]!;
}

export function sketchBoxFilterForKey(key: string): SketchBoxFilter | null {
  switch (key.toLowerCase()) {
    case 'a':
      return 'all';
    case 'e':
      return 'curves';
    case 'p':
      return 'points';
    default:
      return null;
  }
}

/** Entity ids the box selects. `toScreen` maps sketch (u, v) to the same pixel space as `rect`. */
export function sketchBoxSelect(
  sketch: SketchData,
  rect: ScreenRect,
  mode: BoxMode,
  filter: SketchBoxFilter,
  toScreen: (uv: Vec2) => ScreenPoint | null,
): string[] {
  const map = entityMap(sketch);
  const out: string[] = [];
  for (const entity of sketch.entities) {
    if (entity.kind === 'point') {
      if (filter === 'curves') continue;
      const s = toScreen([entity.x, entity.y]);
      if (s && pointInRect(s, rect)) out.push(entity.id);
      continue;
    }
    if (!isCurve(entity) || filter === 'points') continue;
    const curve = entityCurve(map, entity);
    if (!curve) continue;
    const screen = sampleCurve(curve).map(toScreen);
    if (screen.some((p) => p === null)) continue;
    const points = screen as ScreenPoint[];
    const hit =
      mode === 'window'
        ? points.every((p) => pointInRect(p, rect))
        : points.some((p, i) => i > 0 && segmentTouchesRect(points[i - 1]!, p, rect)) ||
          points.some((p) => pointInRect(p, rect));
    if (hit) out.push(entity.id);
  }
  return out;
}
