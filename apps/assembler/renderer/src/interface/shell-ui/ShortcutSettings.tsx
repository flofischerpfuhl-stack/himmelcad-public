/**
 * Settings › Keyboard › Shortcuts: rebind any registry command (Shapr3D:
 * customisable shortcuts, interaction research §6). Click a key cap, press
 * the new combination (Esc cancels); clashes with another command in the
 * same keyboard context and keys the app itself uses are refused with the
 * reason. Overrides are a user preference (`preferences.shortcuts`) applied
 * to the registry by `model/commands/shortcutOverrides.ts`.
 */
import { useEffect, useMemo, useState } from 'react';

import { Button } from '@himmelcad/ui';

import { COMMANDS, matchScore } from '../../foundation/commands/registry.js';
import {
  checkShortcut,
  comboFromKey,
  defaultShortcut,
  effectiveShortcut,
} from '../../foundation/commands/shortcutOverrides.js';
import { usePreferences } from '../../platform/input/preferences.js';
import styles from './SettingsDialog.module.css';

export function ShortcutSettings(): JSX.Element {
  const overrides = usePreferences((p) => p.shortcuts);
  const setPreference = usePreferences((p) => p.setPreference);
  const [filter, setFilter] = useState('');
  const [capturing, setCapturing] = useState<string | null>(null);
  const [problem, setProblem] = useState<{ id: string; text: string } | null>(null);

  const rows = useMemo(() => {
    const q = filter.trim().toLowerCase();
    return COMMANDS.filter((c) => {
      if (!q) return true;
      const shortcut = effectiveShortcut(c, overrides) ?? '';
      return matchScore(q, c.label) !== null || shortcut.toLowerCase() === q;
    });
  }, [filter, overrides]);

  // While capturing, the next key press (capture phase, before the app's shortcuts) is the new key.
  useEffect(() => {
    if (!capturing) return;
    const onKeyDown = (event: KeyboardEvent) => {
      event.preventDefault();
      event.stopPropagation();
      if (event.key === 'Escape') {
        setCapturing(null);
        return;
      }
      const combo = comboFromKey(event);
      if (!combo) return;
      const check = checkShortcut(capturing, combo, overrides);
      if (!check.ok) {
        setProblem({ id: capturing, text: check.reason });
        return;
      }
      const next = { ...overrides };
      if (combo === defaultShortcut(capturing)) delete next[capturing];
      else next[capturing] = combo;
      setPreference('shortcuts', next);
      setProblem(null);
      setCapturing(null);
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [capturing, overrides, setPreference]);

  const reset = (id: string) => {
    const next = { ...overrides };
    delete next[id];
    setPreference('shortcuts', next);
  };
  const clear = (id: string) => setPreference('shortcuts', { ...overrides, [id]: '' });
  const customised = Object.keys(overrides).length;

  return (
    <div className={styles.shortcuts}>
      <div className={styles.shortcutsHeader}>
        <input
          type="search"
          className={styles.shortcutFilter}
          aria-label="Find a command"
          placeholder="Find a command…"
          value={filter}
          onChange={(event) => setFilter(event.currentTarget.value)}
        />
        <Button
          variant="quiet"
          size="small"
          disabled={customised === 0}
          onClick={() => setPreference('shortcuts', {})}
        >
          Reset all{customised > 0 ? ` (${customised})` : ''}
        </Button>
      </div>
      <div className={styles.shortcutList} role="list" aria-label="Keyboard shortcuts">
        {rows.map((command) => {
          const current = effectiveShortcut(command, overrides);
          const changed = overrides[command.id] !== undefined;
          const isCapturing = capturing === command.id;
          return (
            <div key={command.id} role="listitem" className={styles.shortcutRow}>
              <span className={styles.shortcutLabel}>
                {command.label}
                {command.shortcutScope === 'sketch' ? (
                  <span className={styles.hint}> · in sketches</span>
                ) : null}
              </span>
              <button
                type="button"
                className={`${styles.keyCap} ${isCapturing ? styles.keyCapCapturing : ''} ${changed ? styles.keyCapChanged : ''}`}
                aria-label={`Shortcut for ${command.label}: ${current ?? 'none'}. Press to change.`}
                onClick={() => {
                  setProblem(null);
                  setCapturing(isCapturing ? null : command.id);
                }}
              >
                {isCapturing ? 'Press keys… (Esc)' : (current ?? '—')}
              </button>
              <span className={styles.shortcutActions}>
                {current ? (
                  <Button variant="quiet" size="small" onClick={() => clear(command.id)}>
                    Clear
                  </Button>
                ) : null}
                {changed ? (
                  <Button variant="quiet" size="small" onClick={() => reset(command.id)}>
                    Reset
                  </Button>
                ) : null}
              </span>
              {problem?.id === command.id ? (
                <span className={styles.shortcutProblem} role="alert">
                  {problem.text}
                </span>
              ) : null}
            </div>
          );
        })}
      </div>
    </div>
  );
}
