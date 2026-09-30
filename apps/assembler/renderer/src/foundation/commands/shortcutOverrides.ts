/**
 * Custom keyboard shortcuts (Shapr3D: shortcuts are customisable in the
 * settings — interaction research §6). Overrides are a user preference
 * (`preferences.shortcuts`: command id → shortcut in the registry's display
 * form, `''` = none). {@link applyShortcutOverrides} writes the effective
 * shortcut onto each registry command, so the resolver (`shortcuts.ts`),
 * menus, tooltips, command search and the cheat sheet all show and use the
 * same key; the registry's own shortcut stays the default for "Reset".
 */
import { COMMANDS, registeredShortcut, type Command } from './registry.js';
import { invalidateShortcutMap } from './shortcuts.js';

/** Keys the shell handles itself (Escape ladder, Enter = Done, search, cheat sheet, panels). */
export const RESERVED_SHORTCUTS: readonly string[] = [
  'Escape',
  'Enter',
  'Tab',
  'Space',
  'X',
  'Ctrl+F',
  '?',
  'Shift+?',
  'Ctrl+Alt+S',
  'Ctrl+Alt+H',
  'Ctrl+Alt+P',
];

/** The registry's built-in shortcut of a command (the one its module registered). */
export function defaultShortcut(commandId: string): string | undefined {
  return registeredShortcut(commandId);
}

const MODIFIER_KEYS = new Set(['Control', 'Shift', 'Alt', 'Meta', 'AltGraph', 'CapsLock']);
// Same aliases as the resolver (`shortcuts.ts`); Space is only named so it can be refused.
const NAMED: Readonly<Record<string, string>> = {
  Delete: 'Del',
  Backspace: 'Del',
  ' ': 'Space',
};

/**
 * The display form of a pressed key combination (`Ctrl+Shift+E`, `Alt+3`,
 * `Del`, `F2`), or `null` for a lone modifier. Same normalisation as the
 * resolver: Cmd counts as Ctrl, letters are upper-case.
 */
export function comboFromKey(event: {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
}): string | null {
  if (MODIFIER_KEYS.has(event.key)) return null;
  const key = NAMED[event.key] ?? (event.key.length === 1 ? event.key.toUpperCase() : event.key);
  const parts: string[] = [];
  if (event.ctrlKey || event.metaKey) parts.push('Ctrl');
  if (event.shiftKey) parts.push('Shift');
  if (event.altKey) parts.push('Alt');
  parts.push(key);
  return parts.join('+');
}

function scopesOverlap(a: Command, b: Command): boolean {
  return (
    a.shortcutScope === undefined ||
    b.shortcutScope === undefined ||
    a.shortcutScope === b.shortcutScope
  );
}

/** The shortcut a command has with `overrides` applied (`undefined` = none). */
export function effectiveShortcut(
  command: Command,
  overrides: Readonly<Record<string, string>>,
): string | undefined {
  const override = overrides[command.id];
  if (override === undefined) return defaultShortcut(command.id);
  return override === '' ? undefined : override;
}

export type ShortcutCheck = { ok: true } | { ok: false; reason: string };

/**
 * Whether `combo` can become the shortcut of `commandId` given the other
 * overrides: not reserved by the shell, and not used by another command in
 * an overlapping keyboard scope (sketch / model).
 */
export function checkShortcut(
  commandId: string,
  combo: string,
  overrides: Readonly<Record<string, string>>,
): ShortcutCheck {
  const command = COMMANDS.find((c) => c.id === commandId);
  if (!command) return { ok: false, reason: 'Unknown command.' };
  if (RESERVED_SHORTCUTS.includes(combo)) {
    return { ok: false, reason: `${combo} is used by the app itself.` };
  }
  const clash = COMMANDS.find(
    (other) =>
      other.id !== commandId &&
      effectiveShortcut(other, overrides) === combo &&
      scopesOverlap(command, other),
  );
  if (clash) return { ok: false, reason: `${combo} is already used by "${clash.label}".` };
  return { ok: true };
}

/**
 * Writes the effective shortcut of every command (defaults + valid
 * overrides) onto the registry objects. Invalid overrides (unknown command,
 * reserved or clashing key) are ignored and the default stays. Returns the
 * ids whose override was ignored.
 */
export function applyShortcutOverrides(overrides: Readonly<Record<string, string>>): string[] {
  const ignored: string[] = [];
  const accepted: Record<string, string> = {};
  for (const [id, combo] of Object.entries(overrides)) {
    if (!COMMANDS.some((c) => c.id === id)) {
      ignored.push(id);
      continue;
    }
    if (combo === '') {
      accepted[id] = '';
      continue;
    }
    // Checked against the whole intended set, so swapping two keys works.
    const check = checkShortcut(id, combo, overrides);
    if (check.ok) accepted[id] = combo;
    else ignored.push(id);
  }
  for (const command of COMMANDS) {
    const shortcut = effectiveShortcut(command, accepted);
    if (shortcut === undefined) delete (command as { shortcut?: string }).shortcut;
    else (command as { shortcut?: string }).shortcut = shortcut;
  }
  invalidateShortcutMap();
  return ignored;
}
