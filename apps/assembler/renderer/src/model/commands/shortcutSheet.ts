/**
 * The keyboard cheat sheet's content, generated from the command registry
 * (pure; rendered by `chrome/ShortcutOverlay.tsx`, checked by tests).
 */
import { COMMANDS, type Command, type CommandGroup } from './registry.js';

const GROUP_TITLE: Record<CommandGroup, string> = {
  sketch: 'Sketch',
  add: 'Add',
  transform: 'Transform',
  tools: 'Tools',
  modes: 'Modes',
  edit: 'Edit & selection',
  view: 'View',
  file: 'File',
};

const GROUP_ORDER: CommandGroup[] = [
  'tools',
  'transform',
  'sketch',
  'edit',
  'view',
  'modes',
  'file',
];

export interface ShortcutRow {
  label: string;
  keys: string;
}

/** `true` for plain single-letter hotkeys (off when Settings › Single-key hotkeys is off). */
export function isSingleKey(shortcut: string): boolean {
  return /^[A-Z]$/.test(shortcut);
}

/** Registry commands with shortcuts, grouped in cheat-sheet order. */
export function shortcutSections(
  singleKeyHotkeys: boolean,
): { title: string; rows: ShortcutRow[] }[] {
  return GROUP_ORDER.map((group) => ({
    title: GROUP_TITLE[group],
    rows: COMMANDS.filter((c) => c.group === group && c.shortcut)
      .filter((c) => singleKeyHotkeys || !isSingleKey(c.shortcut!))
      .map((c) => ({ label: c.label, keys: c.shortcut! })),
  })).filter((section) => section.rows.length > 0);
}

/**
 * Shortcuts used by more than one command in an overlapping keyboard
 * context (should be empty). Commands may share a key only when their
 * `shortcutScope`s are disjoint (`'sketch'` vs `'model'`).
 */
export function shortcutConflicts(): { shortcut: string; ids: string[] }[] {
  const byKey = new Map<string, Command[]>();
  for (const c of COMMANDS) {
    if (!c.shortcut) continue;
    byKey.set(c.shortcut, [...(byKey.get(c.shortcut) ?? []), c]);
  }
  const overlap = (a: Command, b: Command) =>
    a.shortcutScope === undefined ||
    b.shortcutScope === undefined ||
    a.shortcutScope === b.shortcutScope;
  return [...byKey.entries()]
    .filter(([, cs]) => cs.some((a, i) => cs.some((b, j) => j > i && overlap(a, b))))
    .map(([shortcut, cs]) => ({ shortcut, ids: cs.map((c) => c.id) }));
}
