/**
 * Applies user preferences outside React: the theme class on
 * `<html>` (synchronously, so the viewport re-reads its colours after the
 * class switched), the grid defaults of the view state and the tablet
 * layout / handedness attributes with the window-wide pen tracking
 * (`platform/input/deviceProbe.ts`). Installed once from `main.tsx`.
 */
import { applyShortcutOverrides } from '../../foundation/commands/shortcutOverrides.js';
import { notify } from '../../foundation/commands/notices.js';
import { installInputEnvironment } from '../../platform/input/deviceProbe.js';
import {
  usePreferences,
  type AccentColor,
  type ThemeName,
} from '../../platform/input/preferences.js';
import { useAssemblerStore } from '../../foundation/commands/store.js';

export function applyThemeClass(theme: ThemeName): void {
  const root = document.documentElement;
  root.classList.toggle('hc-theme-light', theme === 'light');
  root.classList.toggle('hc-theme-dark', theme === 'dark');
}

/**
 * Accent colours besides the theme's blue (Shapr3D Settings › Accent colour):
 * the base (borders, focus rings, sketch outlines), the hover tone per theme
 * and a fill dark enough for white text (WCAG AA, ≥ 4.5 : 1).
 */
const ACCENTS: Record<
  Exclude<AccentColor, 'blue'>,
  { base: string; hoverDark: string; hoverLight: string; fill: string }
> = {
  teal: { base: '#14b8a6', hoverDark: '#2dd4bf', hoverLight: '#0f9488', fill: '#0f766e' },
  violet: { base: '#8b5cf6', hoverDark: '#a78bfa', hoverLight: '#7c3aed', fill: '#6d28d9' },
  green: { base: '#22c55e', hoverDark: '#4ade80', hoverLight: '#16a34a', fill: '#15803d' },
  pink: { base: '#ec4899', hoverDark: '#f472b6', hoverLight: '#db2777', fill: '#be185d' },
};

/** Overrides the theme's accent tokens on `<html>` (`blue`: the theme's own tokens). */
export function applyAccent(accent: AccentColor, theme: ThemeName): void {
  const style = document.documentElement.style;
  const names = ['--hc-accent-base', '--hc-accent-hover', '--hc-accent-aa-fill'];
  if (accent === 'blue') {
    for (const name of names) style.removeProperty(name);
    return;
  }
  const colors = ACCENTS[accent];
  style.setProperty('--hc-accent-base', colors.base);
  style.setProperty('--hc-accent-hover', theme === 'light' ? colors.hoverLight : colors.hoverDark);
  style.setProperty('--hc-accent-aa-fill', colors.fill);
}

export function installPreferenceEffects(): () => void {
  const initial = usePreferences.getState();
  applyThemeClass(initial.theme);
  applyAccent(initial.accent, initial.theme);
  applyShortcutOverrides(initial.shortcuts);
  const store = useAssemblerStore.getState();
  store.setGridVisible(initial.gridVisible);
  store.setGridStep(initial.gridStep);
  // The first pen on this device: from now on in sketches the pen draws and fingers navigate
  // (Settings › Touch and pen › Finger in sketches: Automatic).
  installInputEnvironment(window, () => {
    if (usePreferences.getState().fingerDrawing === 'auto') {
      notify(
        'Pen detected: the pen draws, fingers navigate. Change it in Settings › Touch and pen.',
      );
    }
  });
  return usePreferences.subscribe((prefs, previous) => {
    if (prefs.theme !== previous.theme) applyThemeClass(prefs.theme);
    if (prefs.accent !== previous.accent || prefs.theme !== previous.theme) {
      applyAccent(prefs.accent, prefs.theme);
    }
    if (prefs.shortcuts !== previous.shortcuts) applyShortcutOverrides(prefs.shortcuts);
    if (prefs.gridVisible !== previous.gridVisible) {
      useAssemblerStore.getState().setGridVisible(prefs.gridVisible);
    }
    if (prefs.gridStep !== previous.gridStep) {
      useAssemblerStore.getState().setGridStep(prefs.gridStep);
    }
  });
}
