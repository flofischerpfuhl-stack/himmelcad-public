/**
 * Applies user preferences outside React: the theme class on
 * `<html>` (synchronously, so the viewport re-reads its colours after the
 * class switched) and the grid defaults of the view state. Installed once
 * from `main.tsx`.
 */
import { applyShortcutOverrides } from '../../foundation/commands/shortcutOverrides.js';
import { usePreferences, type ThemeName } from '../../platform/input/preferences.js';
import { useAssemblerStore } from '../../foundation/commands/store.js';

export function applyThemeClass(theme: ThemeName): void {
  const root = document.documentElement;
  root.classList.toggle('hc-theme-light', theme === 'light');
  root.classList.toggle('hc-theme-dark', theme === 'dark');
}

export function installPreferenceEffects(): () => void {
  const initial = usePreferences.getState();
  applyThemeClass(initial.theme);
  applyShortcutOverrides(initial.shortcuts);
  const store = useAssemblerStore.getState();
  store.setGridVisible(initial.gridVisible);
  store.setGridStep(initial.gridStep);
  return usePreferences.subscribe((prefs, previous) => {
    if (prefs.theme !== previous.theme) applyThemeClass(prefs.theme);
    if (prefs.shortcuts !== previous.shortcuts) applyShortcutOverrides(prefs.shortcuts);
    if (prefs.gridVisible !== previous.gridVisible) {
      useAssemblerStore.getState().setGridVisible(prefs.gridVisible);
    }
    if (prefs.gridStep !== previous.gridStep) {
      useAssemblerStore.getState().setGridStep(prefs.gridStep);
    }
  });
}
