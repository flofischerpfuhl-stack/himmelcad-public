/**
 * The canvas module's UI: reference images in the viewport (textured
 * quads, `viewportImages.ts`), the calibration overlay, the History card of
 * an image step and the icons of the kind and commands.
 */
import { Image, Ruler } from 'lucide-react';

import { defineModuleUi } from '../../platform/widgets/moduleUi.js';
import type { ReferenceImageFeature } from './referenceImage.js';
import { CalibrationOverlay } from './ui/CalibrationOverlay.js';
import { ImageParams } from './ui/ImageParams.js';
import { IMAGE_CLICK, IMAGE_OVERLAY } from './viewportImages.js';

export const canvasUi = defineModuleUi({
  id: 'canvas',
  historyCards: [
    {
      kinds: ['referenceImage'],
      component: ({ feature, state }) => (
        <ImageParams feature={feature as ReferenceImageFeature} state={state} />
      ),
    },
  ],
  viewportOverlays: [IMAGE_OVERLAY],
  viewportClicks: [IMAGE_CLICK],
  viewportDomOverlays: [{ id: 'canvas.calibration', order: 60, component: CalibrationOverlay }],
  featureIcons: { referenceImage: Image },
  commandIcons: { 'add.image': Image, 'canvas.calibrate': Ruler },
});
