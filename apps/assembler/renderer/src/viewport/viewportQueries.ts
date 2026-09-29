/**
 * Glue between the live viewport (renderer id buffer, camera, displayed
 * bodies) and the pure selection logic in `boxSelect.ts` and
 * `pickCandidates.ts`. No React; called from `Viewport.tsx` on pointer up.
 */
import type { Body, EvaluatedSketch } from '../kernel/types.js';
import type { SelectionItem } from '../model/store.js';
import {
  boxSelect,
  targetKey,
  type BoxFilter,
  type BoxMode,
  type Projector,
  type ScreenRect,
} from './boxSelect.js';
import { viewProjectionMatrix, type CameraPose } from './camera.js';
import type { ViewportRenderer } from './gl.js';
import { projectToScreen, unprojectRay } from './math.js';
import {
  collectCandidates,
  edgesNearPoint,
  rayCastFaces,
  type CandidateContext,
  type PickCandidate,
} from './pickCandidates.js';
import type { PickTable, PickTarget } from './picking.js';

export interface ViewportQueryContext {
  renderer: ViewportRenderer;
  table: PickTable;
  /** Host size in CSS pixels. */
  width: number;
  height: number;
  dpr: number;
  pose: CameraPose;
  /** Displayed, visible bodies (hidden/isolated-away removed). */
  bodies: readonly Body[];
  sketches: readonly EvaluatedSketch[];
}

export function hostProjector(pose: CameraPose, width: number, height: number): Projector {
  const vp = viewProjectionMatrix(pose, width / Math.max(1, height));
  return (p) => projectToScreen(vp, p, width, height);
}

const SELECTABLE = new Set(['face', 'edge', 'sketchProfile']);

/** Distinct selectable targets in the id buffer within `radius` CSS px of (x, y), nearest first. */
function visibleTargetsNear(
  ctx: ViewportQueryContext,
  x: number,
  y: number,
  radius: number,
): PickTarget[] {
  const d = ctx.dpr;
  const ids = ctx.renderer.readPickIdsInRect(
    (x - radius) * d,
    (y - radius) * d,
    (x + radius) * d,
    (y + radius) * d,
    x * d,
    y * d,
  );
  return [...ids.entries()]
    .filter(([, dist2]) => dist2 <= radius * radius * d * d)
    .sort((a, b) => a[1] - b[1])
    .map(([id]) => ctx.table.resolve(id))
    .filter((t): t is PickTarget => t !== null && SELECTABLE.has(t.kind));
}

/** Pick candidates at a host-relative point (see `pickCandidates.ts`). */
export function candidatesAt(
  ctx: ViewportQueryContext,
  x: number,
  y: number,
  options: {
    radius: number;
    selectThrough: boolean;
    names: Omit<CandidateContext, 'bodies' | 'sketches'>;
  },
): PickCandidate[] {
  const visible = visibleTargetsNear(ctx, x, y, options.radius);
  const vp = viewProjectionMatrix(ctx.pose, ctx.width / Math.max(1, ctx.height));
  const ray = unprojectRay(vp, x, y, ctx.width, ctx.height);
  const rayFaces = ray ? rayCastFaces(ctx.bodies, ray) : [];
  const nearEdges = options.selectThrough
    ? edgesNearPoint(
        ctx.bodies,
        hostProjector(ctx.pose, ctx.width, ctx.height),
        [x, y],
        options.radius,
      )
    : [];
  return collectCandidates(
    { visible, rayFaces, nearEdges, selectThrough: options.selectThrough },
    { ...options.names, bodies: ctx.bodies, sketches: ctx.sketches },
  );
}

/** Box selection over a host-relative rectangle. */
export function boxSelectionIn(
  ctx: ViewportQueryContext,
  rect: ScreenRect,
  mode: BoxMode,
  filter: BoxFilter,
  selectThrough: boolean,
): SelectionItem[] {
  const d = ctx.dpr;
  const keysOf = (ids: Map<number, number>) => {
    const keys = new Set<string>();
    for (const id of ids.keys()) {
      const target = ctx.table.resolve(id);
      if (target) keys.add(targetKey(target));
    }
    return keys;
  };
  const touchedKeys = keysOf(
    ctx.renderer.readPickIdsInRect(rect.x0 * d, rect.y0 * d, rect.x1 * d, rect.y1 * d),
  );
  const visibleKeys =
    mode === 'window' && !selectThrough
      ? keysOf(ctx.renderer.readPickIdsInRect(0, 0, ctx.width * d, ctx.height * d))
      : new Set<string>();
  return boxSelect({
    rect,
    mode,
    filter,
    bodies: ctx.bodies,
    sketches: ctx.sketches,
    project: hostProjector(ctx.pose, ctx.width, ctx.height),
    visibleKeys,
    touchedKeys,
    selectThrough,
  });
}
