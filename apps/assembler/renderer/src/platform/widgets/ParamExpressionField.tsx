/**
 * Editable numeric field for a feature's size (extrude distance, fillet
 * radius, chamfer distance, shell thickness) that additionally accepts an
 * expression over document parameters (`model/parameters.ts`, the
 * Parameters panel) — `"wall * 2"`, not just `"3 + 2"`. A plain number
 * commits `value` (and clears any stored expression, like typing over a
 * sketch dimension's formula); a name-referencing expression commits the
 * formula itself, which the store resolves and keeps re-resolving whenever
 * a parameter changes.
 *
 * Parameter names complete from a styled suggestion list
 * (`ExpressionSuggestInput`: arrows, Enter/Tab accept, Esc closes); hovering
 * a resolved field shows the source formula in the title tooltip (Shapr3D
 * "numerical values" pattern, extended with named references).
 */
import { useEffect, useId, useRef, useState } from 'react';

import {
  consumeEscapeBlurCommitSuppression,
  registerEscapeRung,
  revertEscapeField,
} from '@himmelcad/ui';

import { formatExpressionValue } from './expression.js';
import { parameterCandidates } from './expressionSuggest.js';
import { ExpressionSuggestInput } from './ExpressionSuggestInput.js';
import type { Parameter } from '../../foundation/document/parameters.js';
import { resolveFeatureExpression } from '../../foundation/document/parameters.js';
import { isPlainNumber } from '../../foundation/document/expressions.js';
import styles from './ExpressionField.module.css';

export interface ParamExpressionFieldProps {
  label: string;
  value: number;
  /** The stored source formula, if the value is currently computed rather than typed directly. */
  expression?: string | undefined;
  unit?: string;
  parameters: readonly Parameter[];
  paramValues: ReadonlyMap<string, number>;
  onCommitValue: (value: number) => void;
  onCommitExpression: (expression: string) => void;
  precision?: number;
  /** Accept zero and negative results (a draft angle); size fields must stay positive. */
  signed?: boolean;
}

export function ParamExpressionField({
  label,
  value,
  expression,
  unit,
  parameters,
  paramValues,
  onCommitValue,
  onCommitExpression,
  precision = 3,
  signed = false,
}: ParamExpressionFieldProps): JSX.Element {
  const initial = expression ?? formatExpressionValue(value, precision);
  const [draft, setDraft] = useState(initial);
  const [committedText, setCommittedText] = useState(initial);
  const [invalid, setInvalid] = useState(false);
  const [focused, setFocused] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const messageId = useId();

  useEffect(() => {
    if (focused) return;
    const text = expression ?? formatExpressionValue(value, precision);
    setCommittedText(text);
    setDraft(text);
  }, [value, expression, focused, precision]);

  useEffect(() => {
    if (!focused) return;
    return registerEscapeRung('fieldRevert', () => {
      const input = inputRef.current;
      if (!input || document.activeElement !== input) return false;
      revertEscapeField(input, committedText);
      setDraft(committedText);
      setInvalid(false);
      return true;
    });
  }, [committedText, focused]);

  const commit = (): void => {
    const text = draft.trim();
    if (text === '') {
      setInvalid(true);
      return;
    }
    if (isPlainNumber(text)) {
      const parsed = Number(text.replace(/\s*(mm|Â°|deg)\s*$/i, '').replace(',', '.'));
      setInvalid(false);
      const formatted = formatExpressionValue(parsed, precision);
      setCommittedText(formatted);
      setDraft(formatted);
      if (parsed !== value || expression !== undefined) onCommitValue(parsed);
      return;
    }
    const resolved = resolveFeatureExpression(text, paramValues, { signed });
    if (!resolved.ok) {
      setInvalid(true);
      return;
    }
    setInvalid(false);
    setCommittedText(text);
    if (text !== expression) onCommitExpression(text);
  };

  return (
    <div className={styles.field}>
      <span className={styles.label}>{label}</span>
      <div className={`${styles.wrap} ${invalid ? styles.wrapInvalid : ''}`}>
        <ExpressionSuggestInput
          ref={inputRef}
          className={styles.input}
          value={draft}
          suggestions={parameterCandidates(parameters)}
          aria-label={label}
          aria-invalid={invalid || undefined}
          aria-describedby={invalid ? messageId : undefined}
          title={
            expression !== undefined
              ? `${expression} = ${formatExpressionValue(value, precision)}${unit ?? ''}`
              : undefined
          }
          onFocus={() => setFocused(true)}
          onValueChange={(text) => {
            if (inputRef.current) consumeEscapeBlurCommitSuppression(inputRef.current);
            setDraft(text);
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
          Enter a number or an expression (numbers, parameters, + - * /).
        </span>
      ) : null}
    </div>
  );
}
