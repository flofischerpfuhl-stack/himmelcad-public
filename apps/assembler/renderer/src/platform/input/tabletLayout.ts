/**
 * Tablet layout state (assembler/TOUCH.md "Tablet layout"): whether the UI
 * runs in its touch form — larger targets, labels instead of hover tips, the
 * number keypad, finger-sized handles — and on which side the tools sit.
 *
 * The device side (`deviceProbe.ts`, desktop/web UI only) publishes the
 * input profile of `@himmelcad/hardware-profile` here; this file holds the
 * pure decisions and the small store the UI reads. The document element
 * carries `data-hc-touch` (tablet layout on) and `data-hc-hand="left"`
 * (left-handed) for the CSS.
 */
import { create } from 'zustand';

import type { Handedness, TabletLayoutSetting, ToolbarLabels } from './preferences.js';

/** The input profile as the UI needs it (mirrors `@himmelcad/hardware-profile` `InputProfile`). */
export interface InputEnvironment {
  touch: 'none' | 'secondary' | 'primary';
  pen: boolean;
  minTargetPx: number;
  pickRadiusPx: number;
}

export const DESKTOP_ENVIRONMENT: InputEnvironment = {
  touch: 'none',
  pen: false,
  minTargetPx: 28,
  pickRadiusPx: 4,
};

/** Tablet layout on? `auto` follows the device: on when touch is the primary input. */
export function resolveTabletLayout(
  setting: TabletLayoutSetting,
  env: Pick<InputEnvironment, 'touch'>,
): boolean {
  if (setting === 'on') return true;
  if (setting === 'off') return false;
  return env.touch === 'primary';
}

/** The number keypad for value fields: `auto` = with the tablet layout. */
export function resolveKeypad(setting: TabletLayoutSetting, tablet: boolean): boolean {
  return setting === 'on' || (setting === 'auto' && tablet);
}

/** Hover tips do not exist on touch: the tablet layout shows the labels instead. */
export function effectiveToolbarLabels(labels: ToolbarLabels, tablet: boolean): ToolbarLabels {
  return tablet && labels === 'hover' ? 'always' : labels;
}

/** Document attributes for the CSS of the tablet layout. */
export function layoutAttributes(tablet: boolean, hand: Handedness): Record<string, string | null> {
  return {
    'data-hc-touch': tablet ? '' : null,
    'data-hc-hand': hand === 'left' ? 'left' : null,
  };
}

export interface TabletLayoutState {
  environment: InputEnvironment;
  /** Tablet layout on (setting + device). */
  tablet: boolean;
  /** Number keypad for value fields. */
  keypad: boolean;
  setEnvironment: (environment: InputEnvironment) => void;
  setResolved: (resolved: { tablet: boolean; keypad: boolean }) => void;
}

export const useTabletLayout = create<TabletLayoutState>((set) => ({
  environment: DESKTOP_ENVIRONMENT,
  tablet: false,
  keypad: false,
  setEnvironment: (environment) => set({ environment }),
  setResolved: (resolved) => set(resolved),
}));
