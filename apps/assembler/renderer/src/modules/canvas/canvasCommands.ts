/**
 * Commands of the canvas module: Add › Image… (Shapr3D Insert › Image; on
 * the selected planar face or construction plane, else XY) and Calibrate
 * Image (two points + their real distance). The History card and the Items
 * row of an image step offer the rest (opacity, size, position, rotation).
 */
import type { Command } from '../../foundation/commands/registry.js';
import { pickAndInsertImage, selectedImage, useCanvasStore } from './canvasStore.js';

export const CANVAS_COMMANDS: readonly Command[] = [
  {
    id: 'add.image',
    label: 'Image…',
    group: 'add',
    // A block of its own in the Add menu, after the primitives.
    separatorBefore: true,
    keywords: [
      'insert image',
      'canvas',
      'reference image',
      'picture',
      'photo',
      'trace',
      'png',
      'jpg',
      'blueprint',
    ],
    availability: () => ({ enabled: true }),
    run: () => pickAndInsertImage(),
  },
  {
    id: 'canvas.calibrate',
    label: 'Calibrate Image',
    group: 'tools',
    keywords: ['canvas', 'scale image', 'two points', 'known distance', 'reference image'],
    availability: (ctx) =>
      selectedImage(ctx)
        ? { enabled: true, recommended: true, priority: 60 }
        : { enabled: false, reason: 'Select an image (its History step or Items row).' },
    run: (ctx) => {
      const image = selectedImage(ctx);
      if (image) useCanvasStore.getState().startCalibration(image.id);
    },
  },
];
