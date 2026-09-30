/**
 * A text input with a styled, keyboard-accessible name completion list for
 * expression fields (document parameters, sketch dimension names) — the
 * replacement for the unstyled native `<datalist>` (never ship browser
 * defaults). ARIA combobox pattern: focus stays in the input, the list is
 * `role="listbox"` referenced by `aria-activedescendant`.
 *
 * Keys while the list is open: ↓/↑ move (wrapping), Enter or Tab accept the
 * highlighted name (the field does not commit on that Enter), Esc closes the
 * list only (a registered `fieldRevert` escape rung ahead of the field's
 * own revert; a second Esc then reverts the field as usual). Clicking a row
 * accepts it without blurring the field. The list is portalled to
 * `document.body` with fixed positioning, so scrolling panels never clip it.
 * Matching logic: `expressionSuggest.ts`.
 */
import {
  forwardRef,
  useCallback,
  useEffect,
  useId,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
  type InputHTMLAttributes,
  type KeyboardEvent,
} from 'react';
import { createPortal } from 'react-dom';

import { registerEscapeRung } from '@himmelcad/ui';

import {
  acceptSuggestion,
  identifierAt,
  matchSuggestions,
  moveActive,
  type SuggestionCandidate,
} from './expressionSuggest.js';
import styles from './ExpressionSuggest.module.css';

export interface ExpressionSuggestInputProps extends Omit<
  InputHTMLAttributes<HTMLInputElement>,
  'value' | 'onChange'
> {
  value: string;
  onValueChange: (text: string) => void;
  /** Names offered for the identifier at the caret. */
  suggestions: readonly SuggestionCandidate[];
}

export const ExpressionSuggestInput = forwardRef<HTMLInputElement, ExpressionSuggestInputProps>(
  function ExpressionSuggestInput(
    { value, onValueChange, suggestions, onKeyDown, onBlur, onFocus, ...inputProps },
    forwardedRef,
  ) {
    const inputRef = useRef<HTMLInputElement | null>(null);
    useImperativeHandle(forwardedRef, () => inputRef.current as HTMLInputElement);
    const listId = useId();
    const [focused, setFocused] = useState(false);
    const [caret, setCaret] = useState(value.length);
    const [open, setOpen] = useState(false);
    const [active, setActive] = useState(0);
    const [rect, setRect] = useState<{ left: number; top: number; width: number } | null>(null);
    const pendingCaret = useRef<number | null>(null);

    const token = identifierAt(value, caret);
    const matches = token ? matchSuggestions(token.prefix, suggestions) : [];
    const shown = focused && open && matches.length > 0;
    const activeIndex = shown ? Math.min(Math.max(active, 0), matches.length - 1) : -1;

    const readCaret = useCallback(() => {
      const input = inputRef.current;
      if (input) setCaret(input.selectionStart ?? input.value.length);
    }, []);

    // Accepting a name moves the caret right after it once React has written the value.
    useLayoutEffect(() => {
      const input = inputRef.current;
      if (pendingCaret.current === null || !input) return;
      input.setSelectionRange(pendingCaret.current, pendingCaret.current);
      setCaret(pendingCaret.current);
      pendingCaret.current = null;
    }, [value]);

    // Position under the input (fixed: scrolling containers never clip the list).
    useLayoutEffect(() => {
      if (!shown) return;
      const place = () => {
        const r = inputRef.current?.getBoundingClientRect();
        if (r) setRect({ left: r.left, top: r.bottom + 2, width: r.width });
      };
      place();
      window.addEventListener('resize', place);
      window.addEventListener('scroll', place, true);
      return () => {
        window.removeEventListener('resize', place);
        window.removeEventListener('scroll', place, true);
      };
    }, [shown]);

    // Esc closes the list before the field's own revert rung sees it.
    useEffect(() => {
      if (!shown) return;
      return registerEscapeRung(
        'fieldRevert',
        () => {
          if (document.activeElement !== inputRef.current) return false;
          setOpen(false);
          return true;
        },
        { order: 100 },
      );
    }, [shown]);

    const accept = (candidate: SuggestionCandidate) => {
      if (!token) return;
      const next = acceptSuggestion(value, token, candidate.name);
      pendingCaret.current = next.caret;
      setOpen(false);
      onValueChange(next.text);
    };

    const handleKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
      if (shown) {
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
          event.preventDefault();
          setActive(moveActive(activeIndex, matches.length, event.key));
          return;
        }
        if ((event.key === 'Enter' || event.key === 'Tab') && activeIndex >= 0) {
          event.preventDefault();
          event.stopPropagation();
          accept(matches[activeIndex]!);
          return;
        }
      }
      onKeyDown?.(event);
    };

    return (
      <>
        <input
          {...inputProps}
          ref={inputRef}
          value={value}
          role="combobox"
          aria-autocomplete="list"
          aria-expanded={shown}
          aria-controls={shown ? listId : undefined}
          aria-activedescendant={shown && activeIndex >= 0 ? `${listId}-${activeIndex}` : undefined}
          autoComplete="off"
          spellCheck={false}
          onChange={(event) => {
            onValueChange(event.currentTarget.value);
            setCaret(event.currentTarget.selectionStart ?? event.currentTarget.value.length);
            setOpen(true);
            setActive(0);
          }}
          onSelect={readCaret}
          onClick={readCaret}
          onKeyUp={(event) => {
            if (
              event.key === 'ArrowLeft' ||
              event.key === 'ArrowRight' ||
              event.key === 'Home' ||
              event.key === 'End'
            ) {
              readCaret();
            }
          }}
          onKeyDown={handleKeyDown}
          onFocus={(event) => {
            setFocused(true);
            onFocus?.(event);
          }}
          onBlur={(event) => {
            setFocused(false);
            setOpen(false);
            onBlur?.(event);
          }}
        />
        {shown && rect
          ? createPortal(
              <ul
                id={listId}
                role="listbox"
                aria-label="Suggestions"
                className={styles.list}
                style={{ left: rect.left, top: rect.top, minWidth: Math.max(140, rect.width) }}
              >
                {matches.map((candidate, index) => (
                  <li
                    key={candidate.name}
                    id={`${listId}-${index}`}
                    role="option"
                    aria-selected={index === activeIndex}
                    className={`${styles.option} ${index === activeIndex ? styles.optionActive : ''}`}
                    // Keep focus (and the caret) in the input.
                    onMouseDown={(event) => event.preventDefault()}
                    onMouseEnter={() => setActive(index)}
                    onClick={() => accept(candidate)}
                  >
                    <span className={styles.name}>{candidate.name}</span>
                    {candidate.detail ? (
                      <span className={styles.detail}>{candidate.detail}</span>
                    ) : null}
                  </li>
                ))}
              </ul>,
              document.body,
            )
          : null}
      </>
    );
  },
);
