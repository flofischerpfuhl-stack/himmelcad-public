/**
 * The checks module's commands (menus, command search, shortcuts): the
 * Checks panel, Run checks now and Add check…. None is adaptive: checks are
 * opt-in and never show up uninvited next to the modelling tools.
 */
import type { Command } from '../../foundation/commands/registry.js';
import { useAssemblerStore } from '../../foundation/commands/store.js';
import { useCheckResults } from './checksStore.js';
import { runChecksNow } from './runner.js';

export const CHECKS_COMMANDS: readonly Command[] = [
  {
    id: 'checks.panel',
    label: 'Checks',
    group: 'view',
    keywords: ['requirements', 'tests', 'verify', 'clearance', 'validate', 'rules'],
    adaptive: false,
    checked: () => useAssemblerStore.getState().checksPanelOpen,
    availability: (ctx) => ({ enabled: true, recommended: ctx.checksPanelOpen }),
    run: (ctx) => ctx.setChecksPanelOpen(!ctx.checksPanelOpen),
  },
  {
    id: 'checks.add',
    label: 'Add check…',
    group: 'view',
    keywords: ['requirement', 'clearance check', 'test', 'verify'],
    adaptive: false,
    availability: () => ({ enabled: true }),
    run: (ctx) => {
      ctx.setChecksPanelOpen(true);
      useCheckResults.setState({ editingId: 'new', draft: null });
    },
  },
  {
    id: 'checks.run',
    label: 'Run checks now',
    group: 'view',
    keywords: ['evaluate checks', 'verify', 'requirements'],
    adaptive: false,
    availability: (ctx) =>
      ctx.checks.length > 0
        ? { enabled: true }
        : { enabled: false, reason: 'This document has no checks.' },
    run: () => void runChecksNow(),
  },
];
