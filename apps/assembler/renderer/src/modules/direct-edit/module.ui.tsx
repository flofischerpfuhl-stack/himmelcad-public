/** The direct-edit module's UI: the Offset/Delete Face History cards and their icons. */
import { Eraser, Expand } from 'lucide-react';

import { defineModuleUi } from '../../platform/widgets/moduleUi.js';
import type { DirectEditFeature } from './kinds.js';
import { DirectEditParams } from './ui/DirectEditParams.js';

export const directEditUi = defineModuleUi({
  id: 'direct-edit',
  historyCards: [
    {
      kinds: ['offsetFace', 'deleteFace'],
      component: ({ feature, state }) => (
        <DirectEditParams feature={feature as DirectEditFeature} state={state} />
      ),
    },
  ],
  featureIcons: { offsetFace: Expand, deleteFace: Eraser },
  commandIcons: { 'tools.offsetFace': Expand, 'tools.deleteFace': Eraser },
});
