/** Icons of the 3D-printing commands (own `lucide-react` choices). */
import {
  ArrowDownToLine,
  Compass,
  ExternalLink,
  FileDown,
  Printer,
  Settings2,
  type LucideIcon,
} from 'lucide-react';

export const PRINT_COMMAND_ICONS: Record<string, LucideIcon> = {
  'modes.print': Printer,
  'print.placeOnPlate': ArrowDownToLine,
  'print.autoOrient': Compass,
  'file.exportStlOptions': FileDown,
  'file.openInSlicer': ExternalLink,
  'file.slicers': Settings2,
};
