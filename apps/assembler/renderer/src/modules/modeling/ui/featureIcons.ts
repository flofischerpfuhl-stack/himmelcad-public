/**
 * Icons of the modelling features and commands (`features.ts`,
 * `featureCommands.ts`), registered through `module.ui.tsx`.
 */
import {
  AlignVerticalSpaceAround,
  CircleDot,
  FlipHorizontal2,
  Layers,
  Layers2,
  LayoutGrid,
  Move3d,
  Rotate3d,
  RotateCw,
  Route,
  Spline,
  SquareSlash,
  SquareSplitHorizontal,
  Stamp,
  TriangleRight,
  type LucideIcon,
} from 'lucide-react';

import type { ModelingFeature } from '../features.js';

export const MODELING_FEATURE_ICON: Readonly<Record<ModelingFeature['kind'], LucideIcon>> = {
  revolve: RotateCw,
  sweep: Route,
  loft: Layers,
  mirror: FlipHorizontal2,
  pattern: LayoutGrid,
  split: SquareSplitHorizontal,
  transform: Move3d,
  rotateAxis: Rotate3d,
  align: AlignVerticalSpaceAround,
  hole: CircleDot,
  emboss: Stamp,
  draft: TriangleRight,
  rib: SquareSlash,
  thicken: Layers2,
};

export const MODELING_COMMAND_ICON: Readonly<Record<string, LucideIcon>> = {
  'tools.revolve': RotateCw,
  'tools.sweep': Route,
  'tools.loft': Layers,
  'transform.mirror': FlipHorizontal2,
  'transform.pattern': LayoutGrid,
  'tools.split': SquareSplitHorizontal,
  'transform.rotateAxis': Rotate3d,
  'transform.align': AlignVerticalSpaceAround,
  'tools.hole': CircleDot,
  'tools.emboss': Stamp,
  'tools.draft': TriangleRight,
  'tools.rib': SquareSlash,
  'tools.thicken': Layers2,
  'tools.filletFaceEdges': Spline,
  'tools.filletConcave': Spline,
  'tools.filletConvex': Spline,
};
