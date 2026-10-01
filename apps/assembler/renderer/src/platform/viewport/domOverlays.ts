/**
 * DOM overlays and modes of the viewport that modules contribute
 * (assembler/MODULES.md §3 "Viewport DOM overlays and modes"), next to the
 * GL overlays of `overlays.ts`:
 *
 * - a **DOM overlay** is a React component drawn over the canvas (the
 *   sketch overlay, dimension labels, the measure overlay). It gets the
 *   viewport's host services ({@link ViewportDomHost}: host element, camera
 *   pose and animation, redraw flag, ray/pick/projection at a screen point)
 *   and the frame `tick`, and may use hooks (e.g. to animate the camera
 *   into a sketch plane);
 * - a **mode** is what a module tells the viewport while it owns the
 *   interaction (sketch mode): features it draws itself (the scene leaves
 *   them out), whether it owns the keyboard, and what a double click on a
 *   pick opens.
 *
 * Modules register both through their UI part
 * (`defineModuleUi({ viewportDomOverlays, viewportModes })`); the viewport
 * renders/asks what is registered and never imports a module.
 */
import type { ComponentType, MutableRefObject } from 'react';

import type { CameraPose } from './camera.js';
import type { Vec3 } from './math.js';
import type { PickTarget } from './picking.js';

/** A camera animation the viewport plays (`from` → `to` over `duration` ms from `start`). */
export interface CameraAnimation {
  from: CameraPose;
  to: CameraPose;
  start: number;
  duration: number;
}

/** What the viewport hands a DOM overlay. */
export interface ViewportDomHost {
  /** The viewport's host element (CSS size = the canvas size). */
  hostRef: MutableRefObject<HTMLDivElement | null>;
  /** The current camera pose; replace it (never mutate) to move the camera. */
  poseRef: MutableRefObject<CameraPose>;
  /** Set to animate the camera. */
  animRef: MutableRefObject<CameraAnimation | null>;
  /** Set to `true` to request a redraw. */
  dirtyRef: MutableRefObject<boolean>;
  /** The pointer ray at a client point, or `null` outside the canvas. */
  rayAtClient: (clientX: number, clientY: number) => { origin: Vec3; direction: Vec3 } | null;
  /** The pick under a client point (body, face, edge, sketch profile …), or `null`. */
  pickAt: (clientX: number, clientY: number) => PickTarget | null;
  /** Host-relative CSS position of a world point, or `null` behind the camera. */
  project: (point: readonly [number, number, number]) => [number, number] | null;
}

export interface ViewportDomOverlayProps {
  host: ViewportDomHost;
  /** Increments on every drawn frame (camera moves included). */
  tick: number;
}

export interface ViewportDomOverlay {
  id: string;
  /** Stacking order among DOM overlays (lower first, i.e. below). */
  order: number;
  component: ComponentType<ViewportDomOverlayProps>;
}

export interface ViewportMode {
  id: string;
  /** Feature ids the mode draws itself while it runs (the scene leaves them out). */
  hiddenFeatureIds?(): readonly string[];
  /** Whether the mode owns the keyboard (the viewport's own keys, e.g. look-at, are off). */
  ownsKeyboard?(): boolean;
  /** A double click on `pick`: `true` if the mode handled it (e.g. opened a sketch). */
  openOnDoubleClick?(pick: PickTarget): boolean;
}

const domOverlays: ViewportDomOverlay[] = [];
const modes: ViewportMode[] = [];

export function registerViewportDomOverlay(overlay: ViewportDomOverlay): void {
  if (domOverlays.some((o) => o.id === overlay.id)) {
    throw new Error(`Viewport DOM overlay "${overlay.id}" is registered twice`);
  }
  domOverlays.push(overlay);
  domOverlays.sort((a, b) => a.order - b.order);
}

/** The registered DOM overlays, in `order`. */
export function viewportDomOverlays(): readonly ViewportDomOverlay[] {
  return domOverlays;
}

export function registerViewportMode(mode: ViewportMode): void {
  if (modes.some((m) => m.id === mode.id)) {
    throw new Error(`Viewport mode "${mode.id}" is registered twice`);
  }
  modes.push(mode);
}

/** Feature ids every running mode draws itself. */
export function modeHiddenFeatureIds(): string[] {
  return modes.flatMap((m) => m.hiddenFeatureIds?.() ?? []);
}

/** Whether a running mode owns the keyboard. */
export function modeOwnsKeyboard(): boolean {
  return modes.some((m) => m.ownsKeyboard?.() ?? false);
}

/** Offers a double click to the modes; `true` if one handled it. */
export function openPickInMode(pick: PickTarget): boolean {
  return modes.some((m) => m.openOnDoubleClick?.(pick) ?? false);
}
