/**
 * On-screen number keypad (assembler/TOUCH.md "Number keypad"; Shapr3D:
 * on touch and pen, tapping a dimension opens the field with a numpad, a
 * check mark confirms). Mounted once by the shell; whenever a value field
 * takes focus while the keypad is on (tablet layout, or Settings › Touch and
 * pen › Number keypad), it appears next to the tool side and types into that
 * field exactly like a keyboard: the field's own parsing (numbers, `+ - * /`
 * expressions, parameter names, unit suffixes), Enter commit and Escape
 * revert stay the only rules. The system keyboard is suppressed while it
 * shows (`inputmode="none"`); "abc" hands the field back to it (names).
 *
 * Which fields: `data-hc-keypad="number|expression"` (units in
 * `data-hc-keypad-units`) or plain `inputmode="decimal"` inputs.
 *
 * With the keypad off (mouse), a second click on a value field that already
 * has the focus opens the same keypad as a calculator (Shapr3D: "click the
 * label, then click again for the calculator"); it closes with the field.
 */
import { Check, Delete, Keyboard, X } from 'lucide-react';
import { useCallback, useEffect, useReducer, useRef, useState } from 'react';

import { usePreferences } from '../input/preferences.js';
import { useTabletLayout } from '../input/tabletLayout.js';
import { applyKeypadKey, keypadTargetOf, type KeypadKey, type KeypadTarget } from './keypad.js';
import styles from './NumericKeypad.module.css';

const ORIGINAL_MODE = 'data-hc-keypad-inputmode';

interface Target {
  input: HTMLInputElement;
  spec: KeypadTarget;
}

function specOf(input: HTMLInputElement): KeypadTarget | null {
  return keypadTargetOf({
    keypad: input.getAttribute('data-hc-keypad'),
    units: input.getAttribute('data-hc-keypad-units'),
    inputMode: input.getAttribute(ORIGINAL_MODE) ?? input.getAttribute('inputmode'),
    type: input.type,
  });
}

function releaseInput(input: HTMLInputElement): void {
  const original = input.getAttribute(ORIGINAL_MODE);
  if (original === null) return;
  if (original === '') input.removeAttribute('inputmode');
  else input.setAttribute('inputmode', original);
  input.removeAttribute(ORIGINAL_MODE);
}

function claimInput(input: HTMLInputElement): void {
  if (input.hasAttribute(ORIGINAL_MODE)) return;
  input.setAttribute(ORIGINAL_MODE, input.getAttribute('inputmode') ?? '');
  // No system keyboard over the keypad.
  input.setAttribute('inputmode', 'none');
}

/** Writes a value the way typing does, so React's `onChange` sees it. */
function typeInto(input: HTMLInputElement, value: string, start: number, end: number): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  setter?.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
  try {
    input.setSelectionRange(start, end);
  } catch {
    // Inputs without a selection API.
  }
}

function pressKey(input: HTMLInputElement, key: 'Enter' | 'Escape'): void {
  input.dispatchEvent(
    new KeyboardEvent('keydown', { key, code: key, bubbles: true, cancelable: true }),
  );
}

function labelOf(input: HTMLInputElement): string {
  const label = input.labels?.[0]?.textContent?.trim();
  return label || input.getAttribute('aria-label') || 'Value';
}

export function NumericKeypad(): JSX.Element | null {
  const enabled = useTabletLayout((s) => s.keypad);
  const hand = usePreferences((p) => p.handedness);
  const [target, setTarget] = useState<Target | null>(null);
  const targetRef = useRef<Target | null>(null);
  targetRef.current = target;
  /** A field handed to the system keyboard ("abc") keeps it until it loses focus. */
  const dismissedRef = useRef<HTMLInputElement | null>(null);
  const [, refresh] = useReducer((n: number) => n + 1, 0);

  const close = useCallback(() => {
    const current = targetRef.current;
    if (current) releaseInput(current.input);
    setTarget(null);
  }, []);

  useEffect(() => {
    if (!enabled) close();
    const consider = (element: Element | null) => {
      if (!(element instanceof HTMLInputElement) || element === dismissedRef.current) return;
      const spec = specOf(element);
      if (!spec) return;
      claimInput(element);
      setTarget({ input: element, spec });
    };
    // Keypad on: every value field that takes focus. Off (mouse): a second click on a
    // field that already has the focus opens it as a calculator (Shapr3D, CON-07).
    const onFocusIn = (event: FocusEvent) => {
      if (enabled) consider(event.target as Element | null);
    };
    const onPointerDown = (event: PointerEvent) => {
      if (enabled || event.pointerType === 'touch' || targetRef.current) return;
      const element = event.target;
      if (element instanceof HTMLInputElement && element === document.activeElement) {
        consider(element);
      }
    };
    const onFocusOut = (event: FocusEvent) => {
      if (event.target === dismissedRef.current) dismissedRef.current = null;
      if (targetRef.current && event.target === targetRef.current.input) close();
    };
    // The keypad mirrors the field's text.
    const onInput = (event: Event) => {
      if (targetRef.current && event.target === targetRef.current.input) refresh();
    };
    document.addEventListener('focusin', onFocusIn);
    document.addEventListener('focusout', onFocusOut);
    document.addEventListener('input', onInput, true);
    document.addEventListener('pointerdown', onPointerDown, true);
    if (enabled) consider(document.activeElement);
    return () => {
      document.removeEventListener('focusin', onFocusIn);
      document.removeEventListener('focusout', onFocusOut);
      document.removeEventListener('input', onInput, true);
      document.removeEventListener('pointerdown', onPointerDown, true);
    };
  }, [enabled, close]);

  // A field that unmounts (Enter applied, the tool ended) may not report a blur.
  useEffect(() => {
    if (!target) return;
    const timer = setInterval(() => {
      const input = targetRef.current?.input;
      if (!input || !input.isConnected || document.activeElement !== input) close();
    }, 200);
    return () => clearInterval(timer);
  }, [target, close]);

  if (!target) return null;
  const { input, spec } = target;

  const apply = (key: KeypadKey) => {
    const next = applyKeypadKey(
      {
        value: input.value,
        start: input.selectionStart ?? input.value.length,
        end: input.selectionEnd ?? input.value.length,
      },
      key,
    );
    typeInto(input, next.value, next.start, next.end);
    refresh();
  };
  // Keys never take the focus from the field.
  const keep = (event: React.PointerEvent | React.MouseEvent) => event.preventDefault();
  const key = (
    label: React.ReactNode,
    aria: string,
    action: () => void,
    tone: 'digit' | 'op' | 'action' | 'accent' = 'digit',
    span = 1,
  ) => (
    <button
      key={aria}
      type="button"
      tabIndex={-1}
      className={`${styles.key} ${styles[tone]}`}
      style={span > 1 ? { gridColumn: `span ${span}` } : undefined}
      aria-label={aria}
      onPointerDown={keep}
      onMouseDown={keep}
      onClick={action}
    >
      {label}
    </button>
  );
  const digit = (text: string, span = 1) =>
    key(text, text, () => apply({ kind: 'insert', text }), 'digit', span);
  const op = (label: string, text: string, aria: string) =>
    key(label, aria, () => apply({ kind: 'insert', text }), 'op');
  const sign = key('±', 'Change sign', () => apply({ kind: 'sign' }), 'op');
  const point = key('.', 'Decimal point', () => apply({ kind: 'insert', text: '.' }), 'digit');
  const clear = key('C', 'Clear', () => apply({ kind: 'clear' }), 'op');
  const expression = spec.mode === 'expression';

  return (
    <div
      className={`${styles.keypad} ${hand === 'left' ? styles.right : styles.left}`}
      role="group"
      aria-label="Number keypad"
      data-hc-keypad-panel=""
      onPointerDown={keep}
      onMouseDown={keep}
    >
      <div className={styles.display}>
        <span className={styles.fieldLabel}>{labelOf(input)}</span>
        <output className={styles.value} aria-live="polite">
          {input.value || '\u00a0'}
        </output>
      </div>
      {expression ? (
        <div className={`${styles.grid} ${styles.four}`}>
          {op('(', '(', 'Open bracket')}
          {op(')', ')', 'Close bracket')}
          {op('÷', ' / ', 'Divide')}
          {op('×', ' * ', 'Multiply')}
          {digit('7')}
          {digit('8')}
          {digit('9')}
          {op('−', ' - ', 'Minus')}
          {digit('4')}
          {digit('5')}
          {digit('6')}
          {op('+', ' + ', 'Plus')}
          {digit('1')}
          {digit('2')}
          {digit('3')}
          {clear}
          {digit('0', 2)}
          {point}
          {sign}
        </div>
      ) : (
        <div className={`${styles.grid} ${styles.three}`}>
          {digit('7')}
          {digit('8')}
          {digit('9')}
          {digit('4')}
          {digit('5')}
          {digit('6')}
          {digit('1')}
          {digit('2')}
          {digit('3')}
          {sign}
          {digit('0')}
          {point}
        </div>
      )}
      {spec.units.length > 0 ? (
        <div className={styles.units}>
          {spec.units.map((unit) =>
            key(unit, `Unit ${unit}`, () => apply({ kind: 'unit', unit }), 'op'),
          )}
        </div>
      ) : null}
      <div className={styles.actions}>
        {key(
          <X size={18} />,
          'Cancel',
          () => {
            pressKey(input, 'Escape');
            close();
          },
          'action',
        )}
        {expression
          ? key(
              <Keyboard size={18} />,
              'Use the system keyboard',
              () => {
                dismissedRef.current = input;
                close();
              },
              'action',
            )
          : clear}
        {key(<Delete size={18} />, 'Backspace', () => apply({ kind: 'backspace' }), 'action')}
        {key(<Check size={20} />, 'Apply', () => pressKey(input, 'Enter'), 'accent')}
      </div>
    </div>
  );
}
