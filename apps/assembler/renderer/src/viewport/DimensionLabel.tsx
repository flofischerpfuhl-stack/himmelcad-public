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
  onBeginEdit: () => void;
  onCommit: (value: number) => void;
  onCancelEdit: () => void;
}

/**
 * Editable dimension overlay: shows `"40 mm"`-style text; a click turns it
 * into a real `<input>` that accepts simple `+ - * /` expressions. Enter
 * applies (parsed against {@link parseExpression}); Esc reverts the field
 * only (per `docs/DESIGN-SYSTEM.md`'s input-consistency rule) without
 * touching the tool's committed value.
 */
export function DimensionLabel(props: DimensionLabelProps): JSX.Element {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (editing) {
      inputRef.current?.focus();
      inputRef.current?.select();
    }
  }, [editing]);

  const beginEdit = () => {
    setText(formatMm(props.value));
    setEditing(true);
    props.onBeginEdit();
  };

  const applyAndClose = () => {
    const parsed = parseExpression(text);
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

  if (!editing) {
    return (
      <button
        type="button"
        className={styles.label}
        style={{ left: props.x, top: props.y }}
        onClick={beginEdit}
        onPointerDown={stopPointer}
        aria-label={`${props.label}: ${formatMm(props.value)} millimeters, click to edit`}
      >
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
