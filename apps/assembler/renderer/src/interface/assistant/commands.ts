/**
 * Commands of the embedded assistant: View › Assistant (the island) and
 * Mention in Assistant (the selection as reference chips in the composer;
 * also in the context menu). No global shortcut, like Builder's agent plan.
 */
import type { Command } from '../../foundation/commands/registry.js';
import { host } from '../../foundation/host/index.js';
import { useAssistant } from './controller.js';

function unavailable(): { enabled: false; reason: string } | null {
  const assistant = host().assistant ?? null;
  if (!assistant) return { enabled: false, reason: host().unavailableReason('assistant') };
  return null;
}

export const ASSISTANT_COMMANDS: readonly Command[] = [
  {
    id: 'view.assistant',
    get label() {
      return useAssistant.getState().open ? 'Hide assistant' : 'Assistant';
    },
    group: 'view',
    keywords: ['ai', 'agent', 'chat', 'claude', 'codex', 'opencode', 'describe part', 'skills'],
    adaptive: false,
    availability: () =>
      unavailable() ?? { enabled: true, recommended: useAssistant.getState().open },
    run: () => {
      const assistant = useAssistant.getState();
      assistant.setOpen(!assistant.open);
    },
  },
  {
    id: 'assistant.mentionSelection',
    label: 'Mention in Assistant',
    group: 'edit',
    keywords: ['ai', 'agent', 'reference', 'chat'],
    availability: (ctx) => {
      const missing = unavailable();
      if (missing) return missing;
      if (ctx.selection.length === 0)
        return { enabled: false, reason: 'Select a body, face, edge or step first.' };
      return { enabled: true, priority: -10 };
    },
    run: () => {
      const assistant = useAssistant.getState();
      assistant.addSelection();
      assistant.setOpen(true);
      assistant.setTab('chat');
    },
  },
];
