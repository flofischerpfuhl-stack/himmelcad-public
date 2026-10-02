/**
 * The measure module (assembler/MODULES.md): Measure mode, pinned
 * measurements, the Measure panel and overlay, the measure API. Everything
 * it adds is registered here and in `module.ui.ts`:
 *
 * - commands: `measureCommands.ts` (Measure; Pin measurement, Measure
 *   points);
 * - agent API: `measureApi.ts` (the `measure.*` handlers);
 * - project file: `projectFile.ts` (pinned measurements in `viewState`);
 * - check kinds: `checkKinds.ts` (distance, angle, length, clearance, volume, mass);
 * - runtime: the kernel for exact minimum distances (`BRepExtrema`).
 */
import { COMMAND_ORDER } from '../../foundation/commands/registry.js';
import { defineAssemblerModule } from '../../foundation/commands/module.js';
import { MEASURE_CHECK_KINDS } from './checkKinds.js';
import { MEASURE_API } from './measureApi.js';
import { MEASURE_COMMANDS, MEASURE_TOOL_COMMANDS } from './measureCommands.js';
import { useMeasureStore } from './measureStore.js';
import { MEASURE_PROJECT_SECTION } from './projectFile.js';

export const measureModule = defineAssemblerModule({
  id: 'measure',
  commands: [
    { order: COMMAND_ORDER.measureTools, commands: MEASURE_TOOL_COMMANDS },
    { order: COMMAND_ORDER.measure, commands: MEASURE_COMMANDS },
  ],
  api: MEASURE_API,
  fileFormatFields: [MEASURE_PROJECT_SECTION],
  // Stored checks of measured quantities (assembler/CHECKS.md).
  checkKinds: MEASURE_CHECK_KINDS,
  install: (host) => {
    // Measure panel: exact minimum distances from the same kernel.
    useMeasureStore.getState().attachKernel(host.kernel);
  },
});
