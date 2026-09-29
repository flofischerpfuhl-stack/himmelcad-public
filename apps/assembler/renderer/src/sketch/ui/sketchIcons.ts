/**
 * Icons of the sketch commands (merged into `chrome/icons.ts` COMMAND_ICON)
 * so the adaptive toolbar and command search never show several sketch
 * commands with the same group glyph.
 */
import {
  Check,
  Circle,
  DraftingCompass,
  Grid2x2,
  Hexagon,
  Layers2,
  Link2,
  Pencil,
  PencilRuler,
  RectangleHorizontal,
  Ruler,
  Scissors,
  Slash,
  SquareDashed,
  Trash2,
  type LucideIcon,
} from 'lucide-react';

import { CONSTRAINT_INFO } from '../constraintRules.js';

export const SKETCH_COMMAND_ICONS: Record<string, LucideIcon> = {
  'sketch.new': PencilRuler,
  'sketch.newXY': Grid2x2,
  'sketch.newXZ': Grid2x2,
  'sketch.newYZ': Grid2x2,
  'sketch.edit': Pencil,
  'sketch.finish': Check,
  'sketch.line': Slash,
  'sketch.arc': DraftingCompass,
  'sketch.circle': Circle,
  'sketch.rectangle': RectangleHorizontal,
  'sketch.polygon': Hexagon,
  'sketch.trim': Scissors,
  'sketch.offset': Layers2,
  'sketch.dimension': Ruler,
  'sketch.construction': SquareDashed,
  'sketch.deleteSelection': Trash2,
  ...Object.fromEntries(CONSTRAINT_INFO.map((c) => [`sketch.constrain.${c.kind}`, Link2])),
};
