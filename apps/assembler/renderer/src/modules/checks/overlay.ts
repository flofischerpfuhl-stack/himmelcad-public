/**
 * Viewport markers of the focused check (click a check in the panel): the
 * closest points of a clearance or distance, the centre of an overlap —
 * lines drawn through the bodies, red for a failing check, green otherwise.
 * Nothing is drawn unless the user focused a check in the open panel.
 */
import type { CheckLocation } from '../../foundation/commands/checks.js';
import { useAssemblerStore } from '../../foundation/commands/store.js';
import type { Body } from '../../foundation/geometry-kernel/types.js';
import type { FlatBatch } from '../../platform/viewport/gl.js';
import { useCheckResults } from './checksStore.js';

const FAIL_COLOR: readonly [number, number, number] = [0.94, 0.27, 0.27];
const PASS_COLOR: readonly [number, number, number] = [0.13, 0.77, 0.37];

let cache: { key: unknown[]; value: FlatBatch[] } | null = null;

/** Lines of the locations' segments and points (crosses), sized to the bodies involved. */
export function locationBatch(
  locations: readonly CheckLocation[],
  bodies: readonly Body[],
  color: readonly [number, number, number],
): FlatBatch | null {
  const positions: number[] = [];
  const colors: number[] = [];
  const line = (a: readonly number[], b: readonly number[]) => {
    positions.push(a[0]!, a[1]!, a[2]!, b[0]!, b[1]!, b[2]!);
    for (let i = 0; i < 2; i += 1) colors.push(color[0], color[1], color[2], 1);
  };
  const cross = (p: readonly number[], size: number) => {
    for (let axis = 0; axis < 3; axis += 1) {
      const a = [...p];
      const b = [...p];
      a[axis]! -= size;
      b[axis]! += size;
      line(a, b);
    }
  };
  for (const location of locations) {
    const involved = bodies.filter((b) => location.bodyIds.includes(b.id));
    const diagonal = Math.max(
      1,
      ...involved.map((b) =>
        Math.hypot(b.max[0] - b.min[0], b.max[1] - b.min[1], b.max[2] - b.min[2]),
      ),
    );
    const size = Math.min(5, diagonal * 0.03);
    if (location.segment) {
      line(location.segment[0], location.segment[1]);
      cross(location.segment[0], size * 0.4);
      cross(location.segment[1], size * 0.4);
    }
    if (location.point) cross(location.point, size);
  }
  if (positions.length === 0) return null;
  return {
    positions: new Float32Array(positions),
    colors: new Float32Array(colors),
    mode: 'lines',
    depthTest: false,
  };
}

/** The focused check's markers (empty when the panel is closed or nothing is focused). */
export function checkOverlayBatches(bodies: readonly Body[]): {
  surface: FlatBatch[];
  last: FlatBatch[];
} {
  const open = useAssemblerStore.getState().checksPanelOpen;
  const { focusedId, results } = useCheckResults.getState();
  const result = focusedId ? results[focusedId] : undefined;
  if (!open || !result?.outcome?.locations) return { surface: [], last: [] };
  const key = [result, bodies];
  if (!cache || cache.key.some((k, i) => k !== key[i])) {
    const batch = locationBatch(
      result.outcome.locations,
      bodies,
      result.state === 'pass' ? PASS_COLOR : FAIL_COLOR,
    );
    cache = { key, value: batch ? [batch] : [] };
  }
  return { surface: [], last: cache.value };
}
