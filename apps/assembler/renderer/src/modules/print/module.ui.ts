/**
 * The print module's UI: the Print mode chrome (Printability panel,
 * place-on-plate hint, STL export dialog) floating over the viewport, the
 * Print toggle in the left dock's mode group, and the viewport overlays
 * (overhangs, thin walls, build volume, orientation ghost).
 */
import { usePreferences } from '../../platform/input/preferences.js';
import { defineModuleUi } from '../../platform/widgets/moduleUi.js';
import { printOverlayBatches } from './overlay.js';
import { usePrintStore } from './printStore.js';
import { PrintChrome } from './ui/PrintChrome.js';
import { PrintModeButton } from './ui/PrintModeButton.js';

export const printUi = defineModuleUi({
  id: 'print',
  panels: [{ id: 'print', slot: 'overlay', order: 100, component: PrintChrome }],
  modeButtons: [{ id: 'print', order: 100, component: PrintModeButton }],
  viewportOverlays: [
    {
      id: 'print',
      order: 100,
      batches: (input) =>
        printOverlayBatches(input.bodies, input.hiddenBodyIds, input.isolatedBodyIds),
      // Print mode overlays redraw on their own changes (analysis, settings, orientation preview,
      // ignored findings) and when a finding type is hidden or shown again.
      subscribe: (onChange) => {
        const offPrint = usePrintStore.subscribe(onChange);
        const offPrefs = usePreferences.subscribe((state, prev) => {
          if (state.hiddenPrintFindings !== prev.hiddenPrintFindings) onChange();
        });
        return () => {
          offPrint();
          offPrefs();
        };
      },
    },
  ],
});
