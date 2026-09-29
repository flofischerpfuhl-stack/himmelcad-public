/** Icons of the modelling features/commands (`model/features.ts`, `commands/featureCommands.ts`). */
import {
  AlignVerticalSpaceAround,
  Eraser,
  Expand,
  FlipHorizontal2,
  Layers,
  LayoutGrid,
  Move3d,
  RotateCw,
  Route,
  SquareSplitHorizontal,
  type LucideIcon,
} from 'lucide-react';

import type { ModelingFeature } from '../model/features.js';

export const MODELING_FEATURE_ICON: Record<ModelingFeature['kind'], LucideIcon> = {
  revolve: RotateCw,
  sweep: Route,
  loft: Layers,
  mirror: FlipHorizontal2,
  pattern: LayoutGrid,
  split: SquareSplitHorizontal,
  transform: Move3d,
  align: AlignVerticalSpaceAround,
  offsetFace: Expand,
  deleteFace: Eraser,
};

export const MODELING_COMMAND_ICON: Partial<Record<string, LucideIcon>> = {
  'tools.revolve': RotateCw,
  'tools.sweep': Route,
  'tools.loft': Layers,
  'transform.mirror': FlipHorizontal2,
  'transform.pattern': LayoutGrid,
  'tools.split': SquareSplitHorizontal,
  'transform.align': AlignVerticalSpaceAround,
  'tools.offsetFace': Expand,
  'tools.deleteFace': Eraser,
};
