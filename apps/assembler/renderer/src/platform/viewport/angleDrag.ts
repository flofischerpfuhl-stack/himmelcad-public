/**
 * How a dragged angle handle turns its value (owner feedback 2026-10-02: a
 * ~28 px drag swung the extrude taper from 5° to 50°). Three mappings, one
 * feel — the value follows the pointer's displacement in screen space,
 * never the pointer's angle about a centre that may be only a few pixels
 * away:
 *
 * - **turn** — rings and wide arcs (Move/Rotate rings, Revolve, circular
 *   Pattern, Rotate About Axis): the pointer's angle about the centre in the
 *   arc's plane, as before; it can go round any number of times. When the
 *   plane is seen almost edge-on that angle is unstable, so the **arc**
 *   mapping takes over.
 * - **arc** — the value changes by the arc length the pointer covers along
 *   the arc's tangent: `Δθ = Δs / r` (r = the arc radius on screen, at least
 *   {@link MIN_LEVER_PX}).
 * - **lever** — tilt handles with a small range (Extrude taper, Move Face
 *   turn): the handle is a lever of length L (the extrude height); moving
 *   its tip sideways by Δs tilts it to `atan((L·tan θ₀ + Δs) / L)`, with L
 *   measured on screen and at least {@link MIN_LEVER_PX} — so a short
 *   extrude seen from far away is not hypersensitive.
 *
 * Snapping (1° for tilts, 15° for rings, Shift: 0.1°) is applied by the
 * caller. Pure: no DOM, no GL.
 */
import type { Vec3 } from './math.js';

/** Shortest lever (and arc radius) on screen, CSS px: about 3.5 px per degree near 0°. */
export const MIN_LEVER_PX = 200;

/** Below this |cos| between the view ray and the arc's axis the plane counts as edge-on. */
export const EDGE_ON_COS = 0.2;

export type AngleDragKind = 'turn' | 'arc' | 'lever';

/** Screen-space drag state of the arc/lever mappings. */
export interface ScreenAngleDrag {
  kind: 'arc' | 'lever';
  /** Value at the start, degrees. */
  startDeg: number;
  /** Pointer at the start, CSS px. */
  start: [number, number];
  /** Unit screen direction in which the value grows. */
  tangent: [number, number];
  /** Lever length / arc radius on screen, CSS px (already at least {@link MIN_LEVER_PX}). */
  leverPx: number;
}

/** The value for the pointer at `pointer` (degrees, unsnapped). */
export function screenDragAngle(drag: ScreenAngleDrag, pointer: [number, number]): number {
  const ds =
    (pointer[0] - drag.start[0]) * drag.tangent[0] + (pointer[1] - drag.start[1]) * drag.tangent[1];
  if (drag.kind === 'arc') return drag.startDeg + (ds / drag.leverPx) * (180 / Math.PI);
  const t0 = Math.tan((Math.max(-89, Math.min(89, drag.startDeg)) * Math.PI) / 180);
  return (Math.atan((drag.leverPx * t0 + ds) / drag.leverPx) * 180) / Math.PI;
}

function add(a: Vec3, b: Vec3, k = 1): Vec3 {
  return [a[0] + b[0] * k, a[1] + b[1] * k, a[2] + b[2] * k];
}

function cross(a: Vec3, b: Vec3): Vec3 {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}

function normalize(v: Vec3): Vec3 {
  const len = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / len, v[1] / len, v[2] / len];
}

/**
 * The screen-space drag of an angle handle (`center`, `axis`, zero direction
 * `ref`, value `startDeg`): the lever (or arc radius) is `lengthMm` from the
 * centre. `project` maps a world point to CSS px (`null` behind the camera).
 * Lever: the tip moves along the line tangent at 0° (the geometry of a
 * tilt); arc: along the tangent at the current value. `null` when the
 * handle cannot be projected.
 */
export function screenAngleDrag(
  kind: 'arc' | 'lever',
  handle: { center: Vec3; axis: Vec3; ref: Vec3 },
  startDeg: number,
  lengthMm: number,
  pointer: [number, number],
  project: (point: Vec3) => readonly [number, number] | null,
): ScreenAngleDrag | null {
  const u = normalize(handle.ref);
  const v = normalize(cross(handle.axis, u));
  const a = kind === 'lever' ? 0 : (startDeg * Math.PI) / 180;
  const dir: Vec3 = [
    u[0] * Math.cos(a) + v[0] * Math.sin(a),
    u[1] * Math.cos(a) + v[1] * Math.sin(a),
    u[2] * Math.cos(a) + v[2] * Math.sin(a),
  ];
  const along: Vec3 = [
    -u[0] * Math.sin(a) + v[0] * Math.cos(a),
    -u[1] * Math.sin(a) + v[1] * Math.cos(a),
    -u[2] * Math.sin(a) + v[2] * Math.cos(a),
  ];
  const length = Math.max(1e-6, Math.abs(lengthMm));
  const c = project(handle.center);
  const tip = project(add(handle.center, dir, length));
  const step = project(add(add(handle.center, dir, length), along, length * 0.01));
  if (!c || !tip || !step) return null;
  const leverPx = Math.max(MIN_LEVER_PX, Math.hypot(tip[0] - c[0], tip[1] - c[1]));
  let tx = step[0] - tip[0];
  let ty = step[1] - tip[1];
  let t = Math.hypot(tx, ty);
  if (t < 1e-6) {
    // The tangent points along the view: drag across the lever's screen direction instead.
    tx = -(tip[1] - c[1]);
    ty = tip[0] - c[0];
    t = Math.hypot(tx, ty);
    if (t < 1e-6) {
      tx = 1;
      ty = 0;
      t = 1;
    }
  }
  return { kind, startDeg, start: pointer, tangent: [tx / t, ty / t], leverPx };
}
