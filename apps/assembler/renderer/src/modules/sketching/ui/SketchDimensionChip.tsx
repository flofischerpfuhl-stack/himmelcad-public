/**
 * The value chip of a sketch dimension (Shapr3D-style editing polish):
 * - click selects the dimension (Shift adds), so Delete removes it and
 *   "Reference Dimension" can toggle it;
 * - double-click opens the value field (expressions such as `d1 / 2`);
 *   a new dimension opens it right away (`editRequest`);
 * - Shift+drag moves the label (layout only, one undo step on release);
 * - reference (driven) dimensions show their value in parentheses and do
 *   not open for editing.
 * Styled like the shared `DimensionLabel` chip (same CSS module).
 */
import { useEffect, useRef, useState } from 'react';

import { registerEscapeRung } from '@himmelcad/ui';

import type { SuggestionCandidate } from '../../../platform/widgets/expressionSuggest.js';
import { ExpressionSuggestInput } from '../../../platform/widgets/ExpressionSuggestInput.js';
import labelStyles from '../../../platform/viewport/DimensionLabel.module.css';
import styles from './SketchOverlay.module.css';

export interface SketchDimensionChipProps {
  name: string;
  /** Formatted value (`"20"`, `"Ø 6"`, `"30°"`). */
  display: string;
  /** Text the field opens with (the expression or the rounded value). */
  editText: string;
  /** Names the value field completes (other dimensions of the sketch, document parameters). */
  suggestions?: readonly SuggestionCandidate[];
  driven: boolean;
  selected: boolean;
  invalid: boolean;
  x: number;
  y: number;
  /** Opens the field whenever the nonce changes (a newly created dimension). */
  editRequest: number | null;
  onSelect: (additive: boolean) => void;
  onCommitText: (text: string) => void;
  onEditClosed: () => void;
  /** Shift+drag: screen delta while dragging (`done` on release). */
  onMove: (dx: number, dy: number, done: boolean) => void;
}

export function SketchDimensionChip(props: SketchDimensionChipProps): JSX.Element {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  const closingRef = useRef(false);
  const lastRequest = useRef<number | null>(null);
  const drag = useRef<{ id: number; x: number; y: number; moved: boolean } | null>(null);
  const { editRequest, editText, driven, onEditClosed } = props;

  useEffect(() => {
    if (editRequest === null || editRequest === lastRequest.current || driven) return;
    lastRequest.current = editRequest;
    setText(editText);
    setEditing(true);
  }, [editRequest, editText, driven]);

  useEffect(() => {
    if (!editing) return;
    inputRef.current?.focus();
    inputRef.current?.select();
  }, [editing]);

  useEffect(() => {
    if (!editing) {
      closingRef.current = false;
      return;
    }
    return registerEscapeRung('fieldRevert', () => {
      if (document.activeElement !== inputRef.current) return false;
      closingRef.current = true;
      setEditing(false);
      onEditClosed();
      return true;
    });
  }, [editing, onEditClosed]);

  const close = (commit: boolean) => {
    if (commit && text.trim() !== '' && text.trim() !== editText) props.onCommitText(text);
    setEditing(false);
    onEditClosed();
  };

  if (editing) {
    return (
      <label
        onPointerDown={(event) => event.stopPropagation()}
        onDoubleClick={(event) => event.stopPropagation()}
      >
        <span className={styles.srOnly}>{`Dimension ${props.name}`}</span>
        <ExpressionSuggestInput
          ref={inputRef}
          className={labelStyles.input}
          style={{ left: props.x, top: props.y }}
          type="text"
          value={text}
          suggestions={props.suggestions ?? []}
          onValueChange={setText}
          onBlur={() => {
            if (!closingRef.current) close(true);
          }}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault();
              event.stopPropagation();
              close(true);
            } else if (event.key === 'Escape') {
              event.preventDefault();
              closingRef.current = true;
              close(false);
            }
          }}
        />
      </label>
    );
  }

  const shown = props.driven ? `(${props.display})` : props.display;
  return (
    <button
      type="button"
      className={[
        labelStyles.label,
        props.invalid ? labelStyles.invalid : '',
        props.selected ? labelStyles.selected : '',
        props.driven ? styles.dimDriven : '',
      ].join(' ')}
      style={{ left: props.x, top: props.y, cursor: props.driven ? 'default' : 'pointer' }}
      data-dimension={props.name}
      aria-label={`Dimension ${props.name}: ${shown}${props.driven ? ', reference' : ', double-click to edit'}`}
      onPointerDown={(event) => {
        event.stopPropagation();
        if (event.button !== 0) return;
        if (event.shiftKey) {
          drag.current = { id: event.pointerId, x: event.clientX, y: event.clientY, moved: false };
          event.currentTarget.setPointerCapture(event.pointerId);
        }
      }}
      onPointerMove={(event) => {
        const d = drag.current;
        if (!d || d.id !== event.pointerId) return;
        const dx = event.clientX - d.x;
        const dy = event.clientY - d.y;
        if (!d.moved && Math.hypot(dx, dy) < 3) return;
        d.moved = true;
        props.onMove(dx, dy, false);
      }}
      onPointerUp={(event) => {
        const d = drag.current;
        drag.current = null;
        if (d && d.id === event.pointerId && d.moved) {
          props.onMove(event.clientX - d.x, event.clientY - d.y, true);
          return;
        }
        props.onSelect(event.shiftKey);
      }}
      onDoubleClick={(event) => {
        event.stopPropagation();
        if (props.driven) return;
        setText(editText);
        setEditing(true);
      }}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === 'F2') {
          event.preventDefault();
          event.stopPropagation();
          if (props.driven) props.onSelect(false);
          else {
            setText(editText);
            setEditing(true);
          }
        }
      }}
    >
      {shown}
    </button>
  );
}
