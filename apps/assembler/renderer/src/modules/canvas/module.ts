/**
 * The canvas module (assembler/MODULES.md): reference images (Shapr3D
 * "canvas") — PNG/JPEG pictures on a plane to trace, placed, scaled,
 * rotated, faded and calibrated by two points and a known distance.
 *
 * - kind: `referenceImage` (`kinds.ts`, no geometry; no-op evaluator in
 *   `kernel.ts`), so insert/edit/delete/suppress/reorder are History steps
 *   with undo/redo for free;
 * - the pictures: `imageStore.ts`, saved as the `images` file field (only
 *   pictures some step uses) through `IMAGES_PROJECT_SECTION`;
 * - commands: Add › Image…, Calibrate Image (`canvasCommands.ts`);
 * - agent API: `image.insert`, `image.calibrate` (`api.ts`).
 *
 * The viewport quads, the History card and the calibration overlay are in
 * `module.ui.tsx`.
 */
import { COMMAND_ORDER } from '../../foundation/commands/registry.js';
import { defineAssemblerModule } from '../../foundation/commands/module.js';
import './kinds.js';
import { CANVAS_API } from './api.js';
import { CANVAS_COMMANDS } from './canvasCommands.js';
import { IMAGES_PROJECT_SECTION } from './imageStore.js';

export const canvasModule = defineAssemblerModule({
  id: 'canvas',
  commands: [{ order: COMMAND_ORDER.canvas, commands: CANVAS_COMMANDS }],
  api: CANVAS_API,
  fileFormatFields: [IMAGES_PROJECT_SECTION],
});
