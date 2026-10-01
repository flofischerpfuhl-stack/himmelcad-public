/**
 * The measure module's UI: the movable Measure panel while Measure is on.
 * The dimension overlay (`ui/MeasureOverlay.tsx`) is still drawn by the
 * viewport until the viewport offers a DOM-overlay slot.
 */
import { defineModuleUi } from '../../platform/widgets/moduleUi.js';
import { MeasureModePanel } from './ui/MeasurePanel.js';

export const measureUi = defineModuleUi({
  id: 'measure',
  panels: [{ id: 'measure', slot: 'overlay', order: 200, component: MeasureModePanel }],
});
