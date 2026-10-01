/**
 * Measure mode's commands, registered through the measure module
 * (`module.ts`): the Measure toggle, and Pin measurement / Measure points
 * (formerly at the end of the display block; their block follows it, so the
 * published command order is unchanged).
 */
import type { Command, CommandAvailability } from '../../foundation/commands/registry.js';
import { currentRefs } from './measure.js';
import { useMeasureStore } from './measureStore.js';

const enabled: CommandAvailability = { enabled: true };

export const MEASURE_COMMANDS: readonly Command[] = [
  {
    id: 'modes.measure',
    label: 'Measure',
    group: 'modes',
    keywords: ['distance', 'dimension'],
    availability: (ctx) => ({ enabled: true, recommended: ctx.viewState.measureEnabled }),
    run: (ctx) => ctx.setMeasureEnabled(!ctx.viewState.measureEnabled),
  },
];

/** Pin measurement and the Points tool of Measure mode. */
export const MEASURE_TOOL_COMMANDS: readonly Command[] = [
  {
    id: 'modes.measurePin',
    label: 'Pin measurement',
    group: 'modes',
    keywords: ['measure', 'keep', 'dimension', 'pin'],
    adaptive: false,
    availability: (ctx) => {
      if (!ctx.viewState.measureEnabled)
        return { enabled: false, reason: 'Turn Measure on first.' };
      return currentRefs(ctx.selection, useMeasureStore.getState().points).length > 0
        ? enabled
        : { enabled: false, reason: 'Select something to measure, or pick points.' };
    },
    run: (ctx) => {
      const measure = useMeasureStore.getState();
      measure.pin(currentRefs(ctx.selection, measure.points));
    },
  },
  {
    id: 'modes.measurePoints',
    label: 'Measure points',
    group: 'modes',
    keywords: ['point to point', 'distance', 'measure', 'vertex', 'centre'],
    adaptive: false,
    availability: () => ({ enabled: true, recommended: useMeasureStore.getState().pointMode }),
    run: (ctx) => {
      const measure = useMeasureStore.getState();
      if (!ctx.viewState.measureEnabled) ctx.setMeasureEnabled(true);
      measure.setPointMode(!measure.pointMode);
    },
  },
];
