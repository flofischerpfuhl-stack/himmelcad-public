/**
 * Centered command-search popover (`X` / Ctrl+F). Fuzzy results from
 * `searchCommands`, recent commands when the query is empty, arrow-key /
 * Enter / Esc navigation. Running a command pushes it to recents.
 */
import { Search } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';

import { registerEscapeRung } from '@himmelcad/ui';

import { searchCommands, type CommandSearchResult } from '../model/commands/registry.js';
import type { AssemblerState } from '../model/store.js';
import styles from './CommandSearch.module.css';

export interface CommandSearchProps {
  state: AssemblerState;
  onClose: () => void;
}

export function CommandSearch({ state, onClose }: CommandSearchProps): JSX.Element {
  const [query, setQuery] = useState('');
  const [activeIndex, setActiveIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const overlayRef = useRef<HTMLDivElement | null>(null);

  const results = searchCommands(query, state);
  const isRecents = query.trim() === '' && state.recentCommandIds.length > 0;

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  useEffect(() => setActiveIndex(0), [query]);

  useEffect(() => registerEscapeRung('menu', () => (onClose(), true)), [onClose]);

  // The shared escape ladder treats any plain text/search `<input>` as an
  // unregistered free-text field and unconditionally swallows Escape for
  // it (never reaching the 'menu' rung above) unless this component claims
  // the 'fieldRevert' rung itself. First Escape clears a non-empty query
  // (revert, surface stays open); Escape again (or with an empty query)
  // closes the popover — matching DESIGN-SYSTEM "Input consistency".
  useEffect(
    () =>
      registerEscapeRung('fieldRevert', () => {
        const input = inputRef.current;
        if (!input || document.activeElement !== input) return false;
        if (query !== '') {
          setQuery('');
          return true;
        }
        onClose();
        return true;
      }),
    [query, onClose],
  );

  useEffect(() => {
    const onPointerDown = (event: PointerEvent): void => {
      if (!overlayRef.current) return;
      if (!(event.target instanceof Node)) return;
      if (event.target === overlayRef.current) onClose();
    };
    document.addEventListener('pointerdown', onPointerDown, true);
    return () => document.removeEventListener('pointerdown', onPointerDown, true);
  }, [onClose]);

  const run = (result: CommandSearchResult): void => {
    if (!result.enabled) return;
    result.command.run(state);
    state.pushRecentCommand(result.command.id);
    onClose();
  };

  return (
    <div ref={overlayRef} className={styles.overlay}>
      <div className={styles.popover} role="dialog" aria-label="Command search">
        <div className={styles.inputRow}>
          <Search size={16} aria-hidden />
          <input
            ref={inputRef}
            className={styles.input}
            placeholder="Search commands…"
            value={query}
            onChange={(event) => setQuery(event.currentTarget.value)}
            onKeyDown={(event) => {
              if (event.key === 'ArrowDown') {
                event.preventDefault();
                setActiveIndex((i) => Math.min(i + 1, Math.max(results.length - 1, 0)));
              } else if (event.key === 'ArrowUp') {
                event.preventDefault();
                setActiveIndex((i) => Math.max(i - 1, 0));
              } else if (event.key === 'Enter') {
                event.preventDefault();
                const result = results[activeIndex];
                if (result) run(result);
              }
            }}
          />
          <span className={styles.hint}>Esc to close</span>
        </div>
        <div className={styles.list} role="listbox" aria-label="Command results">
          {isRecents ? <div className={styles.sectionLabel}>Recent</div> : null}
          {results.length === 0 ? <div className={styles.empty}>No matching commands</div> : null}
          {results.map((result, index) => (
            <button
              key={result.command.id}
              type="button"
              role="option"
              aria-selected={index === activeIndex}
              disabled={!result.enabled}
              title={result.reason}
              className={`${styles.option} ${index === activeIndex ? styles.optionActive : ''} ${
                !result.enabled ? styles.optionDisabled : ''
              }`}
              onMouseEnter={() => setActiveIndex(index)}
              onClick={() => run(result)}
            >
              <span className={styles.optionMain}>
                <span className={styles.optionLabel}>{result.command.label}</span>
                <span className={styles.optionGroup}>{result.command.group}</span>
              </span>
              <span className={styles.optionMeta}>
                {!result.enabled && result.reason ? (
                  <span className={styles.optionReason}>{result.reason}</span>
                ) : null}
                {result.command.shortcut ? (
                  <span className={styles.optionShortcut}>{result.command.shortcut}</span>
                ) : null}
              </span>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
