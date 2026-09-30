/**
 * The parameters module's UI: the Parameters panel, stacked above History
 * below the right dock (toggled with Ctrl+Alt+P, command search and the
 * right dock; open state is `panels.parameters`).
 */
import { defineModuleUi } from '../../foundation/commands/module.js';
import { ParametersPanel } from './ui/ParametersPanel.js';

export const parametersUi = defineModuleUi({
  id: 'parameters',
  panels: [
    {
      id: 'parameters',
      slot: 'rightStack',
      order: 10,
      isOpen: (state) => state.panels.parameters,
      component: ParametersPanel,
    },
  ],
});
