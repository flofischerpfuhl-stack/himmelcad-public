/**
 * File › Agent Access (Local): turns the in-app automation endpoint on and
 * off (`automationStore.ts`). Registered through the agent-api module
 * (`module.ts`); moved out of the command registry unchanged.
 */
import type { Command } from '../../foundation/commands/registry.js';
import { useAutomationStore } from './automationStore.js';

export const AGENT_COMMANDS: readonly Command[] = [
  {
    id: 'file.agentAccess',
    label: 'Agent Access (Local)',
    group: 'file',
    keywords: ['agent', 'automation', 'python', 'api', 'ai', 'script', 'endpoint'],
    availability: () => {
      const automation = useAutomationStore.getState();
      if (!automation.available) {
        return { enabled: false, reason: 'Only available in the desktop app.' };
      }
      return { enabled: true, recommended: automation.enabled };
    },
    run: () => {
      const automation = useAutomationStore.getState();
      void automation.setEnabled(!automation.enabled);
    },
  },
];
