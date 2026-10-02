/**
 * The checks module's UI: the Checks panel in the right column (between
 * Parameters and History), the Checks toggle with its passive status badge
 * in the left dock's mode group, and the focused check's markers in the
 * viewport. "Add as check" elsewhere (Measure) opens the new check here
 * (`openCheckEditor`).
 */
import { setCheckEditorSink } from '../../foundation/commands/checks.js';
import { useAssemblerStore } from '../../foundation/commands/store.js';
import { defineModuleUi } from '../../platform/widgets/moduleUi.js';
import { useCheckResults } from './checksStore.js';
import { checkOverlayBatches } from './overlay.js';
import { ChecksModeButton } from './ui/ChecksModeButton.js';
import { ChecksPanel } from './ui/ChecksPanel.js';

export const checksUi = defineModuleUi({
  id: 'checks',
  panels: [
    {
      id: 'checks',
      slot: 'rightStack',
      order: 50,
      isOpen: (state) => state.checksPanelOpen,
      component: ChecksPanel,
    },
  ],
  modeButtons: [{ id: 'checks', order: 110, component: ChecksModeButton }],
  viewportOverlays: [
    {
      id: 'checks',
      order: 300,
      batches: (input) => checkOverlayBatches(input.bodies),
      subscribe: (onChange) => {
        const offResults = useCheckResults.subscribe(onChange);
        const offPanel = useAssemblerStore.subscribe((state, prev) => {
          if (state.checksPanelOpen !== prev.checksPanelOpen) onChange();
        });
        return () => {
          offResults();
          offPanel();
        };
      },
    },
  ],
  install: () => {
    // "Add as check" (Measure) and other modules open a new check in the panel's editor.
    setCheckEditorSink((checkId) => {
      useAssemblerStore.getState().setChecksPanelOpen(true);
      useCheckResults.setState({ editingId: checkId, draft: null });
    });
  },
});
