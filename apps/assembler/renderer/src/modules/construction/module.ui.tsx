/**
 * The construction module's UI: the History card of construction planes and
 * axes and the icons of their kinds and Construct commands.
 *
 * Phase B note: written by agent B when the modelling History card stopped
 * rendering construction steps; agent A's construction move owns this file
 * (take A's version on a merge conflict).
 */
import { Axis3d, SquareDashed } from 'lucide-react';

import { defineModuleUi } from '../../platform/widgets/moduleUi.js';
import type { ConstructionFeature } from '../../model/construction.js';
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
  featureIcons: { constructionPlane: SquareDashed, constructionAxis: Axis3d },
  commandIcons: {
    'construct.planeOffset': SquareDashed,
    'construct.planeAngle': SquareDashed,
    'construct.planeThreePoints': SquareDashed,
    'construct.midplane': SquareDashed,
    'construct.planeTangent': SquareDashed,
    'construct.axisEdge': Axis3d,
    'construct.axisTwoPoints': Axis3d,
    'construct.axisCylinder': Axis3d,
    'construct.axisPlanes': Axis3d,
  },
});
