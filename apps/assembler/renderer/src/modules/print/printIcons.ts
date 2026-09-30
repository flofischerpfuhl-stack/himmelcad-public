/** Icons of the 3D-printing commands (own `lucide-react` choices). */
import { ArrowDownToLine, Compass, FileDown, Printer, type LucideIcon } from 'lucide-react';

export const PRINT_COMMAND_ICONS: Record<string, LucideIcon> = {
  'modes.print': Printer,
  'print.placeOnPlate': ArrowDownToLine,
  'print.autoOrient': Compass,
  'file.exportStlOptions': FileDown,
};
