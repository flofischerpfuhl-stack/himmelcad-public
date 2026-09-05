import {
  useEffect,
  useId,
  useRef,
  useState,
  type FocusEvent,
  type InputHTMLAttributes,
} from 'react';

import styles from './BaseControls.module.css';
import {
  consumeEscapeBlurCommitSuppression,
  registerEscapeRung,
  revertEscapeField,
} from './escapeLadder.js';

export interface NumberInputProps extends Omit<
  InputHTMLAttributes<HTMLInputElement>,
  'type' | 'value' | 'defaultValue' | 'onChange'
> {
  value?: number;
  defaultValue?: number;
  onCommit?: (value: number) => void;
  onValueChange?: (value: number | null) => void;
  unit?: string;
  precision?: number;
  invalidMessage?: string;
}

export function NumberInput({
  value,
  defaultValue = 0,
  onCommit,
  onValueChange,
  unit,
  precision,
  step = 1,
  min,
  max,
  invalidMessage = 'Enter a valid number.',
  className,
  onFocus,
  onBlur,
  ...props
}: NumberInputProps): JSX.Element {
  const controlled = value !== undefined;
  const [committed, setCommitted] = useState(value ?? defaultValue);
  const [draft, setDraft] = useState(formatNumber(value ?? defaultValue, precision));
  const [focused, setFocused] = useState(false);
  const [invalid, setInvalid] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const messageId = useId();
  const unitId = useId();

  useEffect(() => {
    if (!controlled || value === committed) return;
    setCommitted(value);
    if (!focused) setDraft(formatNumber(value, precision));
  }, [committed, controlled, focused, precision, value]);

  useEffect(() => {
    if (!focused) return;
    return registerEscapeRung('fieldRevert', () => {
      const input = inputRef.current;
      if (!input || document.activeElement !== input) return false;
      const restored = formatNumber(committed, precision);
      revertEscapeField(input, restored);
      setDraft(restored);
      setInvalid(false);
      return true;
    });
  }, [committed, focused, precision]);

  const commit = (): boolean => {
    const parsed = parseDraft(draft, min, max);
    if (parsed === null) {
      setInvalid(true);
      return false;
    }
    const next = roundNumber(parsed, precision);
    setInvalid(false);
    if (!controlled) setCommitted(next);
    else setCommitted(value);
    setDraft(formatNumber(next, precision));
    onValueChange?.(next);
    onCommit?.(next);
    return true;
  };

  const adjust = (direction: 1 | -1): void => {
    const amount = typeof step === 'number' ? step : Number(step) || 1;
    const base = parseDraft(draft, min, max) ?? committed;
    const next = Math.min(
      max == null ? Number.POSITIVE_INFINITY : Number(max),
      Math.max(min == null ? Number.NEGATIVE_INFINITY : Number(min), base + direction * amount),
    );
    const formatted = formatNumber(roundNumber(next, precision), precision);
    setDraft(formatted);
    setInvalid(false);
    onValueChange?.(Number(formatted));
  };

  const describedBy = [props['aria-describedby'], unit ? unitId : null, invalid ? messageId : null]
    .filter(Boolean)
    .join(' ');

  return (
    <div className={styles.numberField}>
      <div className={`${styles.numberWrap} ${invalid ? styles.numberInvalid : ''}`}>
        <input
          {...props}
          ref={inputRef}
          type="text"
          inputMode="decimal"
          role="spinbutton"
          className={`${styles.numberInput} ${className ?? ''}`.trim()}
          value={draft}
          aria-invalid={invalid || undefined}
          aria-valuemin={min == null ? undefined : Number(min)}
          aria-valuemax={max == null ? undefined : Number(max)}
          aria-valuenow={parseDraft(draft, min, max) ?? undefined}
          aria-describedby={describedBy || undefined}
          onChange={(event) => {
            consumeEscapeBlurCommitSuppression(event.currentTarget);
            setDraft(event.currentTarget.value);
            setInvalid(false);
            onValueChange?.(parseDraft(event.currentTarget.value, min, max));
          }}
          onFocus={(event) => {
            setFocused(true);
            onFocus?.(event);
          }}
          onBlur={(event: FocusEvent<HTMLInputElement>) => {
            setFocused(false);
            if (!consumeEscapeBlurCommitSuppression(event.currentTarget)) commit();
            onBlur?.(event);
          }}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault();
              commit();
            } else if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
              event.preventDefault();
              adjust(event.key === 'ArrowUp' ? 1 : -1);
            }
          }}
        />
        {unit ? (
          <span id={unitId} className={styles.numberUnit}>
            {unit}
          </span>
        ) : null}
      </div>
      {invalid ? (
        <span id={messageId} className={styles.fieldMessage} role="alert">
          {invalidMessage}
        </span>
      ) : null}
    </div>
  );
}

export function parseDraft(
  draft: string,
  min: number | string | undefined,
  max: number | string | undefined,
): number | null {
  if (draft.trim() === '') return null;
  const parsed = Number(draft.replace(',', '.'));
  if (!Number.isFinite(parsed)) return null;
  if (min != null && parsed < Number(min)) return null;
  if (max != null && parsed > Number(max)) return null;
  return parsed;
}

function roundNumber(value: number, precision?: number): number {
  if (precision == null) return value;
  const factor = 10 ** Math.max(0, precision);
  return Math.round(value * factor) / factor;
}

function formatNumber(value: number, precision?: number): string {
  return precision == null ? String(value) : value.toFixed(Math.max(0, precision));
}
