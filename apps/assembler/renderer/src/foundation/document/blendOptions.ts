/**
 * Options of the Fillet, Chamfer, Shell and Boolean features beyond their
 * original constant-size form: variable-radius fillets, two-distance and
 * distance-angle chamfers, edges chosen by rule, outward and per-face shell
 * thickness, and booleans that keep their tool bodies. All optional, so
 * existing documents keep their meaning. Evaluated in `kernel/evaluator.ts`
 * with the helpers in `kernel/features/blendRules.ts`.
 */
import type { FaceRef, Millimeters } from './document.js';

/**
 * Edges picked by a rule instead of one by one, re-evaluated on every
 * replay (so edges that appear or disappear after an earlier edit follow):
 * - `faceEdges`: every boundary edge of a face;
 * - `concave` / `convex`: every sharp inside (valley) or outside (ridge)
 *   edge of a body. Tangent (smooth) edges belong to neither.
 */
export type EdgeRule =
  | { kind: 'faceEdges'; face: FaceRef }
  | { kind: 'concave'; bodyId: string }
  | { kind: 'convex'; bodyId: string };

export type ChamferMode = 'equal' | 'twoDistances' | 'distanceAngle';

export type ShellDirection = 'inside' | 'outside';

/** A shell wall with its own thickness (the wall that grows from `face`). */
export interface ShellFaceThickness {
  face: FaceRef;
  thickness: Millimeters;
}

export function edgeRuleLabel(rule: EdgeRule): string {
  switch (rule.kind) {
    case 'faceEdges':
      return 'edges of a face';
    case 'concave':
      return 'all concave edges';
    case 'convex':
      return 'all convex edges';
  }
}

/** Body id an edge rule applies to. */
export function edgeRuleBodyId(rule: EdgeRule): string {
  return rule.kind === 'faceEdges' ? rule.face.bodyId : rule.bodyId;
}

/** Printing clearance presets for Offset Face / Shell gaps (mm). */
export const PRINT_CLEARANCES: readonly number[] = [0.1, 0.2, 0.3, 0.4];
