/**
 * Keyboard-shortcut resolution for the HimmelCAD Assembler UI shell.
 *
 * Maps key events to {@link COMMANDS} entries, using each command's own
 * `shortcut` display string as the single source of truth (see
 * `registry.ts`) so the menu, tooltip and this resolver never drift
 * apart. The chrome agent is expected to call {@link resolveShortcut} from
 * its window-level `keydown` handler and, when it returns a command whose
 * availability is enabled, call `command.run(ctx)`.
 */
import type { Command, CommandContext, ShortcutScope } from './registry.js';
import { COMMANDS } from './registry.js';
import { useFixStore } from '../../interface/shell-ui/fixReference.js';

/**
 * A framework-agnostic view of a keyboard event. The chrome agent builds
 * this from a real DOM `KeyboardEvent` (or an Electron accelerator
 * callback) — kept separate so this module has no DOM dependency and can
 * be unit-tested under `node:test`.
 */
export interface KeyEvent {
  /** `KeyboardEvent.key`, e.g. `'r'`, `'Z'`, `'1'`, `'Delete'`, `'Escape'`. */
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
  /**
   * `true` when the event's target is a text/number input, a textarea, or
   * any other element that owns its own keyboard editing (`contentEditable`).
   * Shortcuts never fire in that case — typing "r" into a rename field must
   * not start the Rectangle tool.
   */
  targetIsTextInput: boolean;
}

/** Non-character key names normalized to the display form used in `Command.shortcut`. */
const NAMED_KEY_ALIASES: Readonly<Record<string, string>> = {
  Delete: 'Del',
  Backspace: 'Del',
  Escape: 'Escape',
};

function normalizeKeyToken(key: string): string {
  if (key.length === 1) return key.toUpperCase();
  return NAMED_KEY_ALIASES[key] ?? key;
}

function normalizeCombo(event: KeyEvent): string {
  const parts: string[] = [];
  if (event.ctrlKey || event.metaKey) parts.push('Ctrl');
  if (event.shiftKey) parts.push('Shift');
  if (event.altKey) parts.push('Alt');
  parts.push(normalizeKeyToken(event.key));
  return parts.join('+');
}

/**
 * Every command per shortcut (several only in disjoint `shortcutScope`s, see
 * `shortcutSheet.ts`). Rebuilt after custom shortcuts change
 * (`shortcutOverrides.ts` → {@link invalidateShortcutMap}).
 */
let shortcutMap: ReadonlyMap<string, readonly Command[]> | null = null;

function currentShortcutMap(): ReadonlyMap<string, readonly Command[]> {
  if (shortcutMap) return shortcutMap;
  const map = new Map<string, Command[]>();
  for (const c of COMMANDS) {
    if (c.shortcut === undefined) continue;
    map.set(c.shortcut, [...(map.get(c.shortcut) ?? []), c]);
  }
  shortcutMap = map;
  return map;
}

/** Drops the cached key → command map (the commands' shortcuts changed). */
export function invalidateShortcutMap(): void {
  shortcutMap = null;
}

/**
 * Resolves a key event to the command it should trigger, or `null` if
 * none applies. Returns `null` while the event target is a text input,
 * and — for single-key hotkeys only (no Ctrl/Cmd/Alt) — while the active
 * tool is in the `numericEditing` phase, so typing a number into a
 * dimension field never triggers e.g. "E" for Extrude.
 *
 * `scope` is the keyboard context (`'sketch'` while a sketch session is
 * open): commands whose `shortcutScope` names the other context are
 * skipped, so `P` is Project in a sketch and Printability in the model.
 *
 * Does not check whether the resolved command is currently enabled —
 * callers should check `command.availability(ctx).enabled` before
 * running it, exactly as command search and the context menu do.
 */
export function resolveShortcut(
  event: KeyEvent,
  ctx: CommandContext,
  scope: ShortcutScope = 'model',
): Command | null {
  if (event.targetIsTextInput) return null;
  const hasModifier = event.ctrlKey || event.metaKey || event.altKey;
  if (!hasModifier && ctx.activeTool?.phase === 'numericEditing') return null;
  const combo = normalizeCombo(event);
  const candidates = currentShortcutMap().get(combo) ?? [];
  return candidates.find((c) => c.shortcutScope === undefined || c.shortcutScope === scope) ?? null;
}

/**
 * Layered Escape handling (interaction research §4): a focused numeric
 * field consumes Escape first (leaving `numericEditing`), then an active
 * tool (cancelling it, `features` untouched), then the current selection
 * and hover. Each layer only acts if the one before it had nothing to do.
 * Sketch sessions have their own rung (`sketch/session.ts` `escape`).
 */
export function handleEscape(ctx: CommandContext): void {
  if (ctx.activeTool?.phase === 'numericEditing') {
    ctx.endNumericEditing();
    return;
  }
  if (ctx.activeTool) {
    ctx.cancel();
    return;
  }
  // History "Fix…" is a mode of its own: Esc leaves it before touching the selection.
  if (useFixStore.getState().session) {
    useFixStore.getState().end();
    return;
  }
  if (ctx.selection.length > 0) ctx.clearSelection();
  if (ctx.hover) ctx.setHover(null);
}
