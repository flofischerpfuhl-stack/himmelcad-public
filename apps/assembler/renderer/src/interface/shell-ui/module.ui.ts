/**
 * The shell's own panels, hosted like every module's (assembler/MODULES.md
 * §3): History sits in the right stack below the modules' panels.
 */

import { defineModuleUi } from '../../platform/widgets/moduleUi.js';
import { setViewportShell } from '../../platform/viewport/viewportHooks.js';
import { HistoryPanel } from './HistoryPanel.js';
import { FIX_GHOST_DATUMS, FIX_PICK_CLICK, SHELL_VIEWPORT } from './viewportShell.js';

export const shellUi = defineModuleUi({
  id: 'shell-ui',
  panels: [
    {
      id: 'history',
      slot: 'rightStack',
      order: 100,
      isOpen: (state) => state.panels.history,
      component: HistoryPanel,
    },
  ],
  // History "Fix…" in the viewport: the missing reference's ghost and the replacement pick.
  viewportDatums: [FIX_GHOST_DATUMS],
  viewportClicks: [FIX_PICK_CLICK],
  // Camera commands, Select Through, Save View and the live pose for the viewport.
  install: () => setViewportShell(SHELL_VIEWPORT),
});
