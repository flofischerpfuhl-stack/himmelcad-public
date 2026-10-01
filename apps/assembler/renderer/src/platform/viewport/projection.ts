/**
 * Projection policy of the viewport (owner decision 2026-10-01,
 * assembler/SELECTION-NAVIGATION.md "Projection"): which field of view the
 * camera should have right now, and the short blend that gets it there.
 *
 * - **Orthographic** (default): parallel projection everywhere.
 * - **Adaptive** (Fusion 360's "Perspective with Ortho Faces"): perspective
 *   while the user orbits freely; parallel while a sketch is open and after
 *   a view-cube face/edge/corner click or a named view (presets, Home, saved
 *   views, Look at face) until the next orbit.
 * - **Perspective**: the field of view from Settings everywhere.
 *
 * Pure (no DOM, no WebGL): the viewport feeds it the user preference and
 * its own state and applies the result with `camera.ts` `withFovAt`, which
 * keeps the pivot's (or target's) plane where it is — no jump in apparent
 * size.
 */
import { fovOfStrength, perspectiveStrength } from './camera.js';
import type { Projection } from '../input/preferences.js';

export interface ProjectionModeEntry {
  id: Projection;
  label: string;
  hint: string;
}

/** The three modes in UI order (Display popover, View menu, cube menu). */
export const PROJECTION_MODES: readonly ProjectionModeEntry[] = [
  { id: 'orthographic', label: 'Orthographic', hint: 'Parallel view everywhere' },
  {
    id: 'adaptive',
    label: 'Adaptive',
    hint: 'Perspective while orbiting, parallel in sketches and standard views',
  },
  { id: 'perspective', label: 'Perspective', hint: 'Field of view from Settings' },
];

export function projectionLabel(mode: Projection): string {
  return PROJECTION_MODES.find((m) => m.id === mode)?.label ?? mode;
}

/** The mode after `mode` (the cycle shortcut): Orthographic → Adaptive → Perspective → … */
export function nextProjection(mode: Projection): Projection {
  const index = PROJECTION_MODES.findIndex((m) => m.id === mode);
  return PROJECTION_MODES[(index + 1) % PROJECTION_MODES.length]!.id;
}

export interface ProjectionState {
  /** A sketch is open (the sketching module's viewport mode). */
  sketching: boolean;
  /**
   * Adaptive only: the last camera move was a view-cube face/edge/corner,
   * a named view, Home, a saved view or Look at face — and no orbit since.
   */
  standardView: boolean;
}

/** The field of view (degrees, `0` = orthographic) the camera should have. */
export function wantedFov(mode: Projection, fovSetting: number, state: ProjectionState): number {
  if (mode === 'orthographic') return 0;
  if (mode === 'perspective') return fovSetting;
  return state.sketching || state.standardView ? 0 : fovSetting;
}

/** Duration of a projection change that is not part of a camera animation (ms). */
export const PROJECTION_BLEND_MS = 220;

/** A running change of the field of view (`0` = orthographic at either end). */
export interface ProjectionBlend {
  fromFov: number;
  toFov: number;
  start: number;
  duration: number;
}

/**
 * The field of view of a blend at time `now`: the perspective strength
 * (`tan(fov / 2)`, 0 = parallel) moves with an ease-out; the end value is
 * exact (an orthographic end is `0`, not a tiny perspective).
 */
export function blendFov(blend: ProjectionBlend, now: number): { fov: number; done: boolean } {
  const t = Math.min(1, Math.max(0, (now - blend.start) / Math.max(1, blend.duration)));
  if (t >= 1) return { fov: blend.toFov, done: true };
  const eased = 1 - Math.pow(1 - t, 3);
  const from = perspectiveStrength(blend.fromFov);
  const to = perspectiveStrength(blend.toFov);
  return { fov: fovOfStrength(from + (to - from) * eased), done: false };
}
