/**
 * Value chip of a drawing tool (length, width, count, …). Unlike the
 * shared `DimensionLabel`, the typed text is owned by the overlay: digits
 * typed before the field has focus (the chip opens on the first digit) and
 * digits typed into the field update the same text, so nothing typed
 * quickly is lost, and Enter commits whatever was typed. Styled like the
 * shared chip (same CSS module).
 */
import { useEffect, useRef } from 'react';

import { registerEscapeRung } from '@himmelcad/ui';

import labelStyles from '../../viewport/DimensionLabel.module.css';
import styles from './SketchOverlay.module.css';

export interface ToolValueChipProps {
  label: string;
  display: string;
  x: number;
  y: number;
  /** Text being typed (`null` = not editing). */
  text: string | null;
  onText: (text: string | null) => void;
  onCommit: (value: number) => void;
}

export function ToolValueChip(props: ToolValueChipProps): JSX.Element {
  const inputRef = useRef<HTMLInputElement>(null);
  const editing = props.text !== null;
  const { onText } = props;

  useEffect(() => {
    if (!editing) return;
    const input = inputRef.current;
    if (input && document.activeElement !== input) {
      input.focus();
      input.setSelectionRange(input.value.length, input.value.length);
    }
  }, [editing]);

  useEffect(() => {
    if (!editing) return;
    return registerEscapeRung('fieldRevert', () => {
      if (document.activeElement !== inputRef.current) return false;
      onText(null);
      return true;
    });
  }, [editing, onText]);

  const done = useRef(false);
  useEffect(() => {
    if (editing) done.current = false;
  }, [editing]);
  const commit = () => {
    if (done.current) return;
    done.current = true;
    const raw = (props.text ?? '').replace(',', '.').replace(/\s*(mm|°|deg)\s*$/i, '');
    const value = Number(raw);
    props.onText(null);
    if (raw.trim() !== '' && Number.isFinite(value)) props.onCommit(value);
  };

  if (!editing) {
    return (
      <button
        type="button"
        className={labelStyles.label}
        style={{ left: props.x, top: props.y }}
        aria-label={`${props.label}: ${props.display}, click to type a value`}
        onPointerDown={(event) => event.stopPropagation()}
        onClick={() => props.onText('')}
      >
        {props.display}
      </button>
    );
  }
  return (
    <label onPointerDown={(event) => event.stopPropagation()}>
      <span className={styles.srOnly}>{props.label}</span>
      <input
        ref={inputRef}
        className={labelStyles.input}
        style={{ left: props.x, top: props.y }}
        type="text"
        inputMode="decimal"
        value={props.text ?? ''}
        onChange={(event) => props.onText(event.target.value)}
        onBlur={() => commit()}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            event.preventDefault();
            event.stopPropagation();
            commit();
          } else if (event.key === 'Escape') {
            event.preventDefault();
            props.onText(null);
          }
        }}
      />
    </label>
  );
}
