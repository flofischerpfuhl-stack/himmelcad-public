/** Icons of the construction kinds and the Construct commands (History cards, toolbar, search). */
import { Axis3d, SquareDashed, type LucideIcon } from 'lucide-react';

import type { ConstructionFeature } from './construction.js';

export const CONSTRUCTION_FEATURE_ICON: Record<ConstructionFeature['kind'], LucideIcon> = {
  constructionPlane: SquareDashed,
  constructionAxis: Axis3d,
};

export const CONSTRUCTION_COMMAND_ICONS: Partial<Record<string, LucideIcon>> = {
  'construct.planeOffset': SquareDashed,
  'construct.planeAngle': SquareDashed,
  'construct.planeThreePoints': SquareDashed,
  'construct.midplane': SquareDashed,
  'construct.planeTangent': SquareDashed,
  'construct.axisEdge': Axis3d,
  'construct.axisTwoPoints': Axis3d,
  'construct.axisCylinder': Axis3d,
  'construct.axisPlanes': Axis3d,
};
