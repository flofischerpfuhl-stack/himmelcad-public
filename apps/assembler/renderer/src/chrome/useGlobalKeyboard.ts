/**
 * Wires the model's shortcut/Escape contracts to the DOM.
 *
 * - Installs the shared `@himmelcad/ui` escape ladder once (menus, dialogs
 *   and dimension fields already register their own rungs against it) and
 *   adds this app's `tool`/`selection` rungs, both delegating to the
 *   model's {@link handleEscape} so the layering (numeric editing -> tool
 *   cancel -> selection/hover clear) lives in exactly one place.
 * - A single bubble-phase `keydown` listener handles everything else:
 *   panel toggles (Ctrl+Alt+S / Ctrl+Alt+H), opening command search
 *   (Ctrl+F or the single-key `X` hotkey), committing the active tool
 *   (Enter), and — for everything not already handled — `resolveShortcut`.
 */
import { useEffect } from 'react';

import { installEscapeLadder, registerEscapeRung } from '@himmelcad/ui';

import { handleEscape, resolveShortcut } from '../model/commands/shortcuts.js';
import type { AssemblerState } from '../model/store.js';

function isTextInputTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
}

export function useGlobalKeyboard(
  getState: () => AssemblerState,
  onOpenCommandSearch: () => void,
): void {
  useEffect(() => installEscapeLadder(window), []);

  useEffect(
    () =>
      registerEscapeRung('tool', () => {
        const state = getState();
        if (!state.activeTool) return false;
        handleEscape(state);
        return true;
      }),
    [getState],
  );

  useEffect(
    () =>
      registerEscapeRung('selection', () => {
        const state = getState();
        if (state.selection.length === 0 && !state.hover) return false;
        handleEscape(state);
        return true;
      }),
    [getState],
  );

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') return; // handled by the escape ladder
      const targetIsTextInput = isTextInputTarget(event.target);
      const state = getState();

      if (!targetIsTextInput && (event.ctrlKey || event.metaKey) && event.altKey) {
        const key = event.key.toLowerCase();
        if (key === 's') {
          event.preventDefault();
          state.togglePanel('items');
          return;
        }
        if (key === 'h') {
          event.preventDefault();
          state.togglePanel('history');
          return;
        }
      }

      if (
        !targetIsTextInput &&
        (event.ctrlKey || event.metaKey) &&
        event.key.toLowerCase() === 'f'
      ) {
        event.preventDefault();
        onOpenCommandSearch();
        return;
      }

      if (!targetIsTextInput && !state.activeTool && event.key.toLowerCase() === 'x') {
        event.preventDefault();
        onOpenCommandSearch();
        return;
      }

      if (!targetIsTextInput && event.key === 'Enter' && state.activeTool) {
        event.preventDefault();
        state.commit();
        return;
      }

      const command = resolveShortcut(
        {
          key: event.key,
          ctrlKey: event.ctrlKey,
          metaKey: event.metaKey,
          shiftKey: event.shiftKey,
          altKey: event.altKey,
          targetIsTextInput,
        },
        state,
      );
      if (!command) return;
      const availability = command.availability(state);
      if (!availability.enabled) return;
      event.preventDefault();
      command.run(state);
      state.pushRecentCommand(command.id);
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [getState, onOpenCommandSearch]);
}
