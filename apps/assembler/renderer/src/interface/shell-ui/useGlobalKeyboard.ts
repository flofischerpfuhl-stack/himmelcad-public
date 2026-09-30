/**
 * Wires the model's shortcut/Escape contracts to the DOM.
 *
 * - Installs the shared `@himmelcad/ui` escape ladder once (menus, dialogs
 *   and dimension fields already register their own rungs against it) and
 *   adds this app's `tool`/`selection` rungs, both delegating to the
 *   model's {@link handleEscape} so the layering (numeric editing -> tool
 *   cancel -> selection/hover clear) lives in exactly one place.
 * - A single bubble-phase `keydown` listener handles everything else:
 *   panel toggles (Ctrl+Alt+S / Ctrl+Alt+H / Ctrl+Alt+P), opening command search
 *   (Ctrl+F or the single-key `X` hotkey; with single-key hotkeys turned
 *   off in Settings, typing any letter starts the search), the shortcut
 *   overlay (`?`, or holding Ctrl), committing the active tool (Enter), and
 *   — for everything not already handled — `resolveShortcut`.
 */
import { useEffect } from 'react';

import { installEscapeLadder, registerEscapeRung } from '@himmelcad/ui';

import {
  handleEscape,
  resolveShortcut,
  type EscapeLayer,
} from '../../foundation/commands/shortcuts.js';
import { useFixStore } from './fixReference.js';
import { usePreferences } from './preferences.js';
import type { AssemblerState } from '../../foundation/commands/store.js';
import { useWorkspaceStore } from './workspace.js';
import { useSketchStore } from '../../sketch/session.js';

/** History "Fix…" is a mode of its own: Esc leaves it before touching the selection. */
const FIX_ESCAPE: readonly EscapeLayer[] = [
  () => {
    if (!useFixStore.getState().session) return false;
    useFixStore.getState().end();
    return true;
  },
];

/** Holding Ctrl alone this long shows the shortcut overlay (Shapr3D, Windows). */
export const CTRL_HOLD_MS = 700;

function isTextInputTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
}

export function useGlobalKeyboard(
  getState: () => AssemblerState,
  onOpenCommandSearch: (initialQuery?: string) => void,
): void {
  useEffect(() => installEscapeLadder(window), []);

  useEffect(
    () =>
      registerEscapeRung('tool', () => {
        const state = getState();
        // A History "Fix…" session is a mode like a tool: Esc ends it even with nothing selected.
        if (!state.activeTool && !useFixStore.getState().session) return false;
        handleEscape(state, FIX_ESCAPE);
        return true;
      }),
    [getState],
  );

  useEffect(
    () =>
      registerEscapeRung('selection', () => {
        const state = getState();
        if (state.selection.length === 0 && !state.hover) return false;
        handleEscape(state, FIX_ESCAPE);
        return true;
      }),
    [getState],
  );

  // Hold Ctrl (alone) → shortcut overlay while held.
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    let openedByHold = false;
    const cancel = () => {
      if (timer) clearTimeout(timer);
      timer = null;
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Control' && !event.repeat && !event.shiftKey && !event.altKey) {
        cancel();
        timer = setTimeout(() => {
          timer = null;
          if (!useWorkspaceStore.getState().shortcutOverlay) {
            openedByHold = true;
            useWorkspaceStore.getState().setShortcutOverlay(true);
          }
        }, CTRL_HOLD_MS);
      } else if (event.key !== 'Control') {
        cancel();
      }
    };
    const onKeyUp = (event: KeyboardEvent) => {
      if (event.key !== 'Control') return;
      cancel();
      if (openedByHold) {
        openedByHold = false;
        useWorkspaceStore.getState().setShortcutOverlay(false);
      }
    };
    const onBlur = () => {
      cancel();
      if (openedByHold) {
        openedByHold = false;
        useWorkspaceStore.getState().setShortcutOverlay(false);
      }
    };
    window.addEventListener('keydown', onKeyDown, true);
    window.addEventListener('keyup', onKeyUp, true);
    window.addEventListener('pointerdown', cancel, true);
    window.addEventListener('blur', onBlur);
    return () => {
      cancel();
      window.removeEventListener('keydown', onKeyDown, true);
      window.removeEventListener('keyup', onKeyUp, true);
      window.removeEventListener('pointerdown', cancel, true);
      window.removeEventListener('blur', onBlur);
    };
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') return; // handled by the escape ladder
      if (event.defaultPrevented) return;
      const targetIsTextInput = isTextInputTarget(event.target);
      const state = getState();
      const singleKeys = usePreferences.getState().singleKeyHotkeys;
      const plain = !event.ctrlKey && !event.metaKey && !event.altKey;

      // The Home screen covers the model: only File shortcuts (New, Open, Home …) apply.
      if (useWorkspaceStore.getState().homeOpen) {
        if (targetIsTextInput) return;
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
          'model',
        );
        if (command?.group === 'file' && command.availability(state).enabled) {
          event.preventDefault();
          command.run(state);
        }
        return;
      }

      if (!targetIsTextInput && (event.ctrlKey || event.metaKey) && event.altKey) {
        const key = event.key.toLowerCase();
        if (key === 's' && !event.shiftKey) {
          event.preventDefault();
          state.togglePanel('items');
          return;
        }
        if (key === 'h') {
          event.preventDefault();
          state.togglePanel('history');
          return;
        }
        if (key === 'p') {
          event.preventDefault();
          state.togglePanel('parameters');
          return;
        }
      }

      if (
        !targetIsTextInput &&
        (event.ctrlKey || event.metaKey) &&
        !event.altKey &&
        event.key.toLowerCase() === 'f'
      ) {
        event.preventDefault();
        onOpenCommandSearch();
        return;
      }

      if (!targetIsTextInput && plain && event.key === '?') {
        event.preventDefault();
        const ws = useWorkspaceStore.getState();
        ws.setShortcutOverlay(!ws.shortcutOverlay);
        return;
      }

      if (!targetIsTextInput && plain && !state.activeTool) {
        if (singleKeys && event.key.toLowerCase() === 'x' && !event.shiftKey) {
          event.preventDefault();
          onOpenCommandSearch();
          return;
        }
        // Single-key hotkeys off: typing a letter starts the command search with it.
        if (!singleKeys && /^[a-z]$/i.test(event.key) && !event.shiftKey) {
          event.preventDefault();
          onOpenCommandSearch(event.key);
          return;
        }
      }

      if (!targetIsTextInput && event.key === 'Enter' && state.activeTool) {
        event.preventDefault();
        state.commit();
        return;
      }

      // Single-key hotkeys off: only modified shortcuts (Ctrl+…, Del, …) resolve.
      if (!singleKeys && plain && /^[a-z]$/i.test(event.key)) return;

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
        useSketchStore.getState().session ? 'sketch' : 'model',
      );
      if (!command) return;
      const availability = command.availability(state);
      if (!availability.enabled) {
        // A tool hotkey that cannot run says why (e.g. E while the sketch is still open)
        // instead of doing nothing silently.
        if (plain && /^[a-z]$/i.test(event.key) && availability.reason) {
          useWorkspaceStore.getState().notify(`${command.label}: ${availability.reason}`);
        }
        return;
      }
      event.preventDefault();
      command.run(state);
      state.pushRecentCommand(command.id);
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [getState, onOpenCommandSearch]);
}
