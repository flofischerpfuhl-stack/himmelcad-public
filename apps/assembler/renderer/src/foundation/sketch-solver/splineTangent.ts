/**
 * Which point carries a spline's end tangent (shared by the constraint
 * rules, the solver mapping and the tools).
 */
import type { SketchSpline } from './types.js';

/**
 * The point that carries a spline's tangent at its end point `end`: the
 * second (second-to-last) pole of a control-point spline, the tangent
 * handle of a fit spline; `null` when `end` is not an end of the spline or
 * a fit spline has no handle there.
 */
export function splineTangentPoint(spline: SketchSpline, end: string): string | null {
  const pts = spline.points;
  if (pts.length < 2) return null;
  const atStart = pts[0] === end;
  const atEnd = pts[pts.length - 1] === end;
  if (!atStart && !atEnd) return null;
  if (spline.mode === 'control') return atStart ? pts[1]! : pts[pts.length - 2]!;
  return (atStart ? spline.handles?.[0] : spline.handles?.[1]) ?? null;
}
