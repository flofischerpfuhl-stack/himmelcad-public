/**
 * The construction module's UI: the History-card editor of construction
 * planes and axes and the icons of its kinds and Construct commands.
 */
import { defineModuleUi } from '../../platform/widgets/moduleUi.js';
import type { ConstructionFeature } from './construction.js';
import { CONSTRUCTION_COMMAND_ICONS, CONSTRUCTION_FEATURE_ICON } from './icons.js';
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
  featureIcons: CONSTRUCTION_FEATURE_ICON,
  commandIcons: CONSTRUCTION_COMMAND_ICONS,
});
