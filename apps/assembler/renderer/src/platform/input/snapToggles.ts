/**
 * The snap switches of sketching (a user preference, `preferences.ts`),
 * read by the sketch inference (`sketch/inference.ts`).
 */

/**
 * Separate snap switches, like Shapr3D's Snapping Options (interaction
 * research §5): snaps are suggestions — each kind can be turned off.
 */
export interface SketchSnapToggles {
  /** End points, centres and the origin (coincident connections). */
  points: boolean;
  /** Line midpoints (midpoint connections). */
  midpoints: boolean;
  /** Guidelines: horizontal/vertical/perpendicular/parallel directions and alignment with other points. */
  guidelines: boolean;
  /** Points on curves (point-on-curve connections). */
  curves: boolean;
  /**
   * Auto-constraining: inferred horizontal/vertical/perpendicular/parallel
   * constraints. Off keeps point connections (coincident, midpoint, on curve).
   */
  autoConstrain: boolean;
  /** 3D body points: vertices, edge midpoints, circle/hole centres. */
  bodyPoints: boolean;
  /** Edges away from the sketch plane, in an orthographic view. */
  farEdges: boolean;
}

export const DEFAULT_SKETCH_SNAPS: SketchSnapToggles = {
  points: true,
  midpoints: true,
  guidelines: true,
  curves: true,
  autoConstrain: true,
  bodyPoints: true,
  farEdges: true,
};
