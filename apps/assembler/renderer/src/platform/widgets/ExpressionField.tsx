/**
 * Editable numeric dimension field for history-card parameters
 * (Sketch width/height/x/y/offset, Extrude distance, Move dx/dy/dz).
 *
 * Accepts simple `+ - * /` expressions (interaction research §4/§6, the
 * Shapr3D "numerical values" reference behaviour) and commits on Enter or
 * blur. Escape reverts the draft to the last committed value and keeps the
 * field open without committing the revert (DESIGN-SYSTEM "Input
 * consistency") — implemented on the shared `@himmelcad/ui` escape ladder
 * so it composes with menus/dialogs using the same Escape press.
 */
import { useEffect, useId, useRef, useState } from 'react';

import {
  consumeEscapeBlurCommitSuppression,
  registerEscapeRung,
  revertEscapeField,
} from '@himmelcad/ui';

import { evaluateExpression, formatExpressionValue } from './expression.js';
import styles from './ExpressionField.module.css';

export interface ExpressionFieldProps {
  label: string;
  value: number;
  unit?: string;
  onCommit: (value: number) => void;
  precision?: number;
}

export function ExpressionField({
  label,
  value,
  unit,
  onCommit,
  precision = 3,
}: ExpressionFieldProps): JSX.Element {
  const [draft, setDraft] = useState(() => formatExpressionValue(value, precision));
  const [committed, setCommitted] = useState(value);
  const [invalid, setInvalid] = useState(false);
  const [focused, setFocused] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const messageId = useId();

  useEffect(() => {
    if (focused) return;
    setCommitted(value);
    setDraft(formatExpressionValue(value, precision));
  }, [value, focused, precision]);

  useEffect(() => {
    if (!focused) return;
    return registerEscapeRung('fieldRevert', () => {
      const input = inputRef.current;
      if (!input || document.activeElement !== input) return false;
      const restored = formatExpressionValue(committed, precision);
      revertEscapeField(input, restored);
      setDraft(restored);
      setInvalid(false);
      return true;
    });
  }, [committed, focused, precision]);

  const commit = (): void => {
    const parsed = evaluateExpression(draft);
    if (parsed === null) {
      setInvalid(true);
      return;
    }
    setInvalid(false);
    setCommitted(parsed);
    setDraft(formatExpressionValue(parsed, precision));
    if (parsed !== committed) onCommit(parsed);
  };

  return (
    <div className={styles.field}>
      <span className={styles.label}>{label}</span>
      <div className={`${styles.wrap} ${invalid ? styles.wrapInvalid : ''}`}>
        <input
          ref={inputRef}
          className={styles.input}
          value={draft}
          aria-label={label}
          aria-invalid={invalid || undefined}
          aria-describedby={invalid ? messageId : undefined}
          onFocus={() => setFocused(true)}
          onChange={(event) => {
            consumeEscapeBlurCommitSuppression(event.currentTarget);
            setDraft(event.currentTarget.value);
            setInvalid(false);
          }}
          onBlur={(event) => {
            setFocused(false);
            if (consumeEscapeBlurCommitSuppression(event.currentTarget)) return;
            commit();
          }}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault();
              event.currentTarget.blur();
            }
          }}
        />
        {unit ? <span className={styles.unit}>{unit}</span> : null}
      </div>
      {invalid ? (
        <span id={messageId} role="alert" className={styles.message}>
          Enter a number or a +-*/ expression.
        </span>
      ) : null}
    </div>
  );
}
