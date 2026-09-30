/** Card icons of the templates this module registers (Home screen); other ids get a generic icon. */
import { Cable, CornerDownRight, FilePlus, Package, type LucideIcon } from 'lucide-react';

export const TEMPLATE_ICONS: Partial<Record<string, LucideIcon>> = {
  blank: FilePlus,
  enclosure: Package,
  bracket: CornerDownRight,
  cableClip: Cable,
};
