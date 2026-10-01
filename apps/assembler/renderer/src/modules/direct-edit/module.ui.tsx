/**
 * The direct-edit module's UI: the Offset/Delete/Move Face and Move Edge
 * History cards and their icons.
 */
import { Eraser, Expand, Move, MoveDiagonal } from 'lucide-react';

import { defineModuleUi } from '../../platform/widgets/moduleUi.js';
import type { DirectEditFeature } from './kinds.js';
import { DirectEditParams } from './ui/DirectEditParams.js';

export const directEditUi = defineModuleUi({
  id: 'direct-edit',
  historyCards: [
    {
      kinds: ['offsetFace', 'deleteFace', 'moveEdge', 'moveFace'],
      component: ({ feature, state }) => (
        <DirectEditParams feature={feature as DirectEditFeature} state={state} />
      ),
    },
  ],
  featureIcons: { offsetFace: Expand, deleteFace: Eraser, moveEdge: MoveDiagonal, moveFace: Move },
  commandIcons: { 'tools.offsetFace': Expand, 'tools.deleteFace': Eraser },
});
