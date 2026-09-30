/**
 * The shell's own panels, hosted like every module's (assembler/MODULES.md
 * §3): History sits in the right stack below the modules' panels.
 */
import { defineModuleUi } from '../../foundation/commands/module.js';
import { HistoryPanel } from './HistoryPanel.js';

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
});
