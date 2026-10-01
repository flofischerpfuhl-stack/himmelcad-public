/**
 * Editing logic of the on-screen number keypad (assembler/TOUCH.md "Number
 * keypad"): what a key does to a field's text and caret. Pure; the keypad
 * component (`NumericKeypad.tsx`) writes the result into the focused field
 * as if typed, so the field's own parsing (numbers, `+ - * /` expressions,
 * parameter names, unit suffixes) and commit/revert stay the only rules.
 */

export type KeypadKey =
  | { kind: 'insert'; text: string }
  | { kind: 'backspace' }
  | { kind: 'clear' }
  /** Toggles a leading minus sign of the whole value. */
  | { kind: 'sign' }
  /** Replaces any trailing unit with this one (`mm`, `in`, `°`). */
  | { kind: 'unit'; unit: string };

export interface FieldText {
  value: string;
  /** Selection (caret when equal). */
  start: number;
  end: number;
}

const UNIT_SUFFIX = /\s*(mm|in|"|°|deg)\s*$/i;

export function applyKeypadKey(field: FieldText, key: KeypadKey): FieldText {
  const value = field.value;
  const start = Math.max(0, Math.min(field.start, value.length));
  const end = Math.max(start, Math.min(field.end, value.length));
  switch (key.kind) {
    case 'insert': {
      const next = value.slice(0, start) + key.text + value.slice(end);
      const caret = start + key.text.length;
      return { value: next, start: caret, end: caret };
    }
    case 'backspace': {
      if (start !== end) {
        return { value: value.slice(0, start) + value.slice(end), start, end: start };
      }
      if (start === 0) return { value, start, end };
      return {
        value: value.slice(0, start - 1) + value.slice(start),
        start: start - 1,
        end: start - 1,
      };
    }
    case 'clear':
      return { value: '', start: 0, end: 0 };
    case 'sign': {
      const trimmed = value.trimStart();
      const lead = value.length - trimmed.length;
      if (trimmed.startsWith('-')) {
        const next = value.slice(0, lead) + trimmed.slice(1);
        const caret = Math.max(0, start - 1);
        return { value: next, start: caret, end: caret };
      }
      const next = `${value.slice(0, lead)}-${trimmed}`;
      return { value: next, start: start + 1, end: start + 1 };
    }
    case 'unit': {
      const bare = value.replace(UNIT_SUFFIX, '');
      const next = key.unit === '°' ? `${bare}°` : `${bare} ${key.unit}`;
      return { value: next, start: next.length, end: next.length };
    }
  }
}

/** What a field takes: plain numbers or expressions (operators, brackets, names). */
export type KeypadMode = 'number' | 'expression';

export interface KeypadTarget {
  mode: KeypadMode;
  /** Unit keys offered (empty: none). */
  units: string[];
}

/**
 * Whether an input gets the keypad and which one: inputs that declare
 * `data-hc-keypad` (`number` / `expression`, units in `data-hc-keypad-units`)
 * and plain decimal inputs (`inputmode="decimal"`, numbers only).
 */
export function keypadTargetOf(attributes: {
  keypad: string | null;
  units: string | null;
  inputMode: string | null;
  type: string;
}): KeypadTarget | null {
  if (attributes.type !== 'text' && attributes.type !== 'number' && attributes.type !== '') {
    return null;
  }
  const units = (attributes.units ?? '').split(/\s+/).filter(Boolean);
  if (attributes.keypad === 'expression') return { mode: 'expression', units };
  if (attributes.keypad === 'number') return { mode: 'number', units };
  if (attributes.keypad === 'off') return null;
  if (attributes.inputMode === 'decimal' || attributes.inputMode === 'numeric') {
    return { mode: 'number', units };
  }
  return null;
}
