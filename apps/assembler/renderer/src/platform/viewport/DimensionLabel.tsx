import { useEffect, useRef, useState } from 'react';

import { registerEscapeRung } from '@himmelcad/ui';

import { usePreferences } from '../input/preferences.js';
import { parseExpression } from './expr.js';
import styles from './DimensionLabel.module.css';

export interface DimensionLabelProps {
  /** Current value in millimetres. */
  value: number;
  /** Screen-space anchor, in CSS pixels relative to the viewport's host element. */
  x: number;
  y: number;
  label: string;
  /** Short symbol shown before the value, e.g. `"R"` or `"Ø"`. */
  prefix?: string;
  /** Unit shown after the value: millimetres (default), degrees, or none (a count). */
  unit?: 'mm' | '°' | '';
  /** Marks the value as rejected by the kernel (red outline). */
  invalid?: boolean;
  /**
   * Opens the field with `text` pre-filled whenever `nonce` changes — e.g.
   * the user started typing a number while the tool waits for a value
   * (Shapr3D: hover + type opens the dimension).
   */
  editRequest?: { nonce: number; text: string } | null;
  onBeginEdit: () => void;
  onCommit: (value: number) => void;
  onCancelEdit: () => void;
  /** Display text instead of `"<prefix> <value> mm"` (e.g. `"30°"`, `"Ø 20"`). */
  display?: string;
  /** Text the field opens with instead of the formatted value (e.g. a stored expression). */
  editText?: string;
  /**
   * Receives the typed text unparsed (sketch dimensions accept expressions
   * with names, `"d1 / 2"`); when set, `onCommit` is not called.
   */
  onCommitText?: (text: string) => void;
  /** Visual emphasis: selected (accent border). */
  selected?: boolean;
}

/**
 * Editable dimension overlay: shows `"40 mm"`-style text; a click turns it
 * into a real `<input>` that accepts simple `+ - * /` expressions (a
 * trailing `mm` is allowed). Enter applies (parsed against
 * {@link parseExpression}); Esc reverts the field only (per
 * `docs/DESIGN-SYSTEM.md`'s input-consistency rule) without touching the
 * tool's committed value.
 */
export function DimensionLabel(props: DimensionLabelProps): JSX.Element {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState('');
  const [selectAll, setSelectAll] = useState(true);
  const inputRef = useRef<HTMLInputElement>(null);
  /** Set by a revert so the blur that follows does not commit. */
  const closingRef = useRef(false);
  /**
   * The text a click opened the field with (the shown value). Closing with it
   * unchanged commits nothing: a click elsewhere (a tool's menu) only blurs the
   * field and must not rewrite the value — that re-laid out the tool pill under
   * the pointer and swallowed the click. `null` when opened by typing.
   */
  const openedTextRef = useRef<string | null>(null);
  const lastRequest = useRef<number | null>(props.editRequest?.nonce ?? null);
  const { onBeginEdit } = props;
  // Settings › Display units: length values show (and are typed) in inches; stored in mm.
  const displayUnits = usePreferences((p) => p.units);
  const inches = (props.unit ?? 'mm') === 'mm' && displayUnits === 'in' && !props.onCommitText;
  const unit: 'mm' | '°' | '' | 'in' = inches ? 'in' : (props.unit ?? 'mm');
  const shown = inches ? props.value / MM_PER_INCH : props.value;

  useEffect(() => {
    const request = props.editRequest;
    if (!request || request.nonce === lastRequest.current) return;
    lastRequest.current = request.nonce;
    openedTextRef.current = null;
    setText(request.text);
    setSelectAll(false);
    setEditing(true);
    onBeginEdit();
  }, [props.editRequest, onBeginEdit]);

  useEffect(() => {
    if (!editing) return;
    const input = inputRef.current;
    input?.focus();
    if (selectAll) input?.select();
    else input?.setSelectionRange(input.value.length, input.value.length);
  }, [editing, selectAll]);

  const beginEdit = () => {
    const initial = props.editText ?? formatValue(shown, unit);
    openedTextRef.current = initial;
    setText(initial);
    setSelectAll(true);
    setEditing(true);
    props.onBeginEdit();
  };

  const apply = () => {
    if (props.onCommitText) {
      if (text.trim() !== '') props.onCommitText(text);
      return;
    }
    // An explicit "mm" or "in"/'"' suffix wins; bare numbers are in the display unit.
    const explicitMm = /mm\s*$/i.test(text);
    const explicitIn = /(in|")\s*$/i.test(text);
    const parsed = parseExpression(text.replace(/\s*(mm|in|"|°|deg)\s*$/i, ''));
    if (parsed !== null && Number.isFinite(parsed)) {
      const toMm = (inches && !explicitMm) || (explicitIn && unit !== '°');
      props.onCommit(toMm ? parsed * MM_PER_INCH : parsed);
    }
  };

  const applyAndClose = () => {
    // Opened by a click and left untouched: nothing to apply.
    const untouched = openedTextRef.current !== null && text === openedTextRef.current;
    if (!untouched) apply();
    setEditing(false);
    props.onCancelEdit();
  };

  const revertAndClose = () => {
    closingRef.current = true;
    setEditing(false);
    props.onCancelEdit();
  };

  // Escape reverts the field on the shared escape ladder (it runs before the input's own keydown).
  useEffect(() => {
    if (!editing) {
      closingRef.current = false;
      return;
    }
    return registerEscapeRung('fieldRevert', () => {
      if (document.activeElement !== inputRef.current) return false;
      revertAndClose();
      return true;
    });
  });

  // Dimension labels float above the 3D canvas; stop pointer events here so
  // the viewport's own pointer handlers (orbit/pick/tool-drag) never see a
  // click meant for the label/input.
  const stopPointer = (event: React.PointerEvent | React.MouseEvent) => event.stopPropagation();
  const prefix = props.prefix ? `${props.prefix} ` : '';
  const unitName =
    unit === '°' ? 'degrees' : unit === '' ? '' : unit === 'in' ? 'inches' : 'millimeters';

  if (!editing) {
    return (
      <button
        type="button"
        className={`${styles.label} ${props.invalid ? styles.invalid : ''} ${props.selected ? styles.selected : ''}`}
        style={{ left: props.x, top: props.y }}
        onClick={beginEdit}
        onPointerDown={stopPointer}
        aria-label={`${props.label}: ${props.display ?? `${formatValue(shown, '')}${unitName ? ` ${unitName}` : ''}`}, click to edit`}
      >
        {props.display ?? `${prefix}${formatValue(shown, unit)}`}
      </button>
    );
  }

  return (
    <label onPointerDown={stopPointer}>
      <span
        style={{
          position: 'absolute',
          width: 1,
          height: 1,
          overflow: 'hidden',
          clipPath: 'inset(50%)',
        }}
      >
        {props.label}
      </span>
      <input
        ref={inputRef}
        className={styles.input}
        style={{ left: props.x, top: props.y }}
        type="text"
        inputMode="decimal"
        // Touch number keypad: `+ - * /` expressions and the units this field reads.
        data-hc-keypad="expression"
        data-hc-keypad-units={unit === '°' ? '°' : unit === '' ? '' : 'mm in'}
        value={text}
        onChange={(event) => setText(event.target.value)}
        onBlur={() => {
          if (!closingRef.current) applyAndClose();
        }}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            event.preventDefault();
            applyAndClose();
          } else if (event.key === 'Escape') {
            event.preventDefault();
            revertAndClose();
          }
        }}
      />
    </label>
  );
}

const MM_PER_INCH = 25.4;

function formatValue(value: number, unit: 'mm' | '°' | '' | 'in'): string {
  const scale = unit === 'in' ? 1000 : 100;
  const rounded = Math.round(value * scale) / scale;
  if (unit === '°') return `${rounded}°`;
  return unit ? `${rounded} ${unit}` : String(rounded);
}
