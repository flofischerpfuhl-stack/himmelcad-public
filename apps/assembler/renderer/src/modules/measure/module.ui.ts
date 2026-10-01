/**
 * The measure module's UI: the movable Measure panel while Measure is on,
 * the dimension overlay over the viewport and the Points tool's clicks
 * (`viewport.tsx`).
 */
import { defineModuleUi } from '../../platform/widgets/moduleUi.js';
import { MeasureModePanel } from './ui/MeasurePanel.js';
import { MEASURE_POINTS_CLICK, MeasureViewportOverlay } from './viewport.js';

export const measureUi = defineModuleUi({
  id: 'measure',
  panels: [{ id: 'measure', slot: 'overlay', order: 200, component: MeasureModePanel }],
  // Above the sketch overlay, as before.
  viewportDomOverlays: [{ id: 'measure', order: 20, component: MeasureViewportOverlay }],
  viewportClicks: [MEASURE_POINTS_CLICK],
});
