/**
 * Measure in the viewport: the dimension overlay of the Measure panel's
 * pinned items and current pick (a DOM overlay while Measure is on), and
 * Measure › Points, where clicks place measured points snapped to vertices,
 * midpoints and circle centres near the pointer, else on the face.
 */
import { useAssemblerStore } from '../../foundation/commands/store.js';
import type { ViewportDomOverlayProps } from '../../platform/viewport/domOverlays.js';
import type { ViewportClickHandler } from '../../platform/viewport/viewportHooks.js';
import { snapMeasurePoint, snapPoints } from './measure.js';
import { useMeasureStore } from './measureStore.js';
import { MeasureOverlay } from './ui/MeasureOverlay.js';

export function MeasureViewportOverlay({
  host,
  tick,
}: ViewportDomOverlayProps): JSX.Element | null {
  const enabled = useAssemblerStore((s) => s.viewState.measureEnabled);
  return enabled ? <MeasureOverlay tick={tick} project={host.project} /> : null;
}

export const MEASURE_POINTS_CLICK: ViewportClickHandler = {
  id: 'measure.points',
  order: 100,
  click: ({ state, touch, hostPoint, project, visibleBodies, surfacePoint }) => {
    if (!state.viewState.measureEnabled || !useMeasureStore.getState().pointMode) return false;
    const snapped = snapMeasurePoint(
      snapPoints(visibleBodies()),
      project,
      hostPoint,
      touch ? 20 : 10,
      surfacePoint() as Parameters<typeof snapMeasurePoint>[4],
    );
    if (snapped) useMeasureStore.getState().addPoint(snapped.point, snapped.label);
    return true;
  },
};
