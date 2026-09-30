/**
 * Measure mode's command, registered through the measure module
 * (`renderer/src/modules/measure/module.ts`); moved out of the command
 * registry unchanged.
 */
import type { Command } from '../../foundation/commands/registry.js';

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
