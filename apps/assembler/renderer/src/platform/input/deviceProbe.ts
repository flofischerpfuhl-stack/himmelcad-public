/**
 * The device side of the tablet layout (desktop and web UI only — the
 * headless and test programs never import this file, they cannot load the
 * shared package's TypeScript sources): reads the pointer media features,
 * derives the input profile with `@himmelcad/hardware-profile`, applies the
 * tablet-layout and handedness attributes to the document and keeps them
 * current when the device (a detached keyboard) or the settings change.
 * Also starts the window-wide pen tracking: the first pen ever seen sets the
 * persisted `penSeen` flag (fingers stop drawing in `auto` mode).
 */
import { deriveInputProfile } from '@himmelcad/hardware-profile';

import { installPenTracking, penPresence } from './pointer.js';
import { usePreferences } from './preferences.js';
import {
  layoutAttributes,
  resolveKeypad,
  resolveTabletLayout,
  useTabletLayout,
  type InputEnvironment,
} from './tabletLayout.js';

function media(win: Window, query: string): MediaQueryList | null {
  return win.matchMedia?.(query) ?? null;
}

function readEnvironment(win: Window): InputEnvironment {
  const coarse = media(win, '(pointer: coarse)')?.matches ?? false;
  const fine = media(win, '(pointer: fine)')?.matches ?? false;
  const profile = deriveInputProfile({
    maxTouchPoints: win.navigator?.maxTouchPoints ?? 0,
    primaryPointer: coarse ? 'coarse' : fine ? 'fine' : 'none',
    anyCoarse: media(win, '(any-pointer: coarse)')?.matches ?? false,
    hover: media(win, '(hover: hover)')?.matches ?? true,
    penSeen: usePreferences.getState().penSeen,
  });
  return { ...profile };
}

/**
 * Installs the probe; returns the uninstaller. `onFirstPen` runs when a pen
 * is used for the first time on this device (the shell shows a notice).
 */
export function installInputEnvironment(win: Window, onFirstPen?: () => void): () => void {
  const apply = () => {
    const prefs = usePreferences.getState();
    const environment = readEnvironment(win);
    const tablet = resolveTabletLayout(prefs.tabletLayout, environment);
    const keypad = resolveKeypad(prefs.numericKeypad, tablet);
    const store = useTabletLayout.getState();
    store.setEnvironment(environment);
    store.setResolved({ tablet, keypad });
    const root = win.document.documentElement;
    for (const [name, value] of Object.entries(layoutAttributes(tablet, prefs.handedness))) {
      if (value === null) root.removeAttribute(name);
      else root.setAttribute(name, value);
    }
  };
  if (usePreferences.getState().penSeen) penPresence.assumePenSeen();
  installPenTracking(win, () => {
    if (!usePreferences.getState().penSeen) {
      usePreferences.getState().setPreference('penSeen', true);
      onFirstPen?.();
    }
  });
  apply();
  const queries = ['(pointer: coarse)', '(any-pointer: coarse)', '(hover: hover)']
    .map((q) => media(win, q))
    .filter((q): q is MediaQueryList => q !== null);
  for (const q of queries) q.addEventListener?.('change', apply);
  const unsubscribe = usePreferences.subscribe((prefs, previous) => {
    if (
      prefs.tabletLayout !== previous.tabletLayout ||
      prefs.numericKeypad !== previous.numericKeypad ||
      prefs.handedness !== previous.handedness ||
      prefs.penSeen !== previous.penSeen
    ) {
      apply();
    }
  });
  return () => {
    for (const q of queries) q.removeEventListener?.('change', apply);
    unsubscribe();
  };
}
