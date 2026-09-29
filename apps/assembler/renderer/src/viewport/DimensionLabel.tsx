import { useEffect, useRef, useState } from 'react';

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
  const lastRequest = useRef<number | null>(props.editRequest?.nonce ?? null);
  const { onBeginEdit } = props;

  useEffect(() => {
    const request = props.editRequest;
    if (!request || request.nonce === lastRequest.current) return;
    lastRequest.current = request.nonce;
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
    setText(formatMm(props.value));
    setSelectAll(true);
    setEditing(true);
    props.onBeginEdit();
  };

  const applyAndClose = () => {
    const parsed = parseExpression(text.replace(/\s*mm\s*$/i, ''));
    if (parsed !== null && Number.isFinite(parsed)) props.onCommit(parsed);
    setEditing(false);
    props.onCancelEdit();
  };

  const revertAndClose = () => {
    setEditing(false);
    props.onCancelEdit();
  };

  // Dimension labels float above the 3D canvas; stop pointer events here so
  // the viewport's own pointer handlers (orbit/pick/tool-drag) never see a
  // click meant for the label/input.
  const stopPointer = (event: React.PointerEvent | React.MouseEvent) => event.stopPropagation();
  const prefix = props.prefix ? `${props.prefix} ` : '';

  if (!editing) {
    return (
      <button
        type="button"
        className={`${styles.label} ${props.invalid ? styles.invalid : ''}`}
        style={{ left: props.x, top: props.y }}
        onClick={beginEdit}
        onPointerDown={stopPointer}
        aria-label={`${props.label}: ${formatMm(props.value)} millimeters, click to edit`}
      >
        {prefix}
        {formatMm(props.value)}
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
        value={text}
        onChange={(event) => setText(event.target.value)}
        onBlur={applyAndClose}
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

function formatMm(value: number): string {
  const rounded = Math.round(value * 100) / 100;
  return `${rounded} mm`;
}
