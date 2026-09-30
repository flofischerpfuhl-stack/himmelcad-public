/** The construction module's UI: the History-card editor of construction planes and axes. */
import { defineModuleUi } from '../../platform/widgets/moduleUi.js';
import type { ConstructionFeature } from './construction.js';
import { ConstructionParams } from './ui/ConstructionParams.js';

export const constructionUi = defineModuleUi({
  id: 'construction',
  historyCards: [
    {
      kinds: ['constructionPlane', 'constructionAxis'],
      component: ({ feature, state }) => (
        <ConstructionParams feature={feature as ConstructionFeature} state={state} />
      ),
    },
  ],
});
