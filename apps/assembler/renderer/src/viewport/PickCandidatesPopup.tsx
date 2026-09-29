import { Box, PenSquare, Slash, Square } from 'lucide-react';
import { useEffect, useRef } from 'react';

import { registerEscapeRung } from '@himmelcad/ui';

import type { PickCandidate } from './pickCandidates.js';
import styles from './PickCandidatesPopup.module.css';

export interface PickCandidatesPopupProps {
  /** Anchor in CSS pixels relative to the viewport host. */
  x: number;
  y: number;
  hostWidth: number;
  hostHeight: number;
  candidates: readonly PickCandidate[];
  onHover: (candidate: PickCandidate | null) => void;
  onChoose: (candidate: PickCandidate) => void;
  onClose: () => void;
}

const ICON = { face: Square, edge: Slash, sketchProfile: PenSquare } as const;

/**
 * "Select from overlapping items" list (Shapr3D 5.820): shown when a click
 * could mean several faces, edges or sketch profiles. Hovering a row
 * previews it in the viewport (the store hover), clicking or Enter selects
 * it, Escape or a click elsewhere closes the list.
 */
export function PickCandidatesPopup(props: PickCandidatesPopupProps): JSX.Element {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const { onClose, onHover } = props;

  useEffect(() => registerEscapeRung('menu', () => (onClose(), true)), [onClose]);

  useEffect(() => {
    const onPointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node | null)) onClose();
    };
    document.addEventListener('pointerdown', onPointerDown, true);
    queueMicrotask(() => rootRef.current?.querySelector<HTMLButtonElement>('button')?.focus());
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true);
      onHover(null);
    };
  }, [onClose, onHover]);

  const width = 260;
  const height = 34 + props.candidates.length * 30;
  const left = Math.max(8, Math.min(props.x + 12, props.hostWidth - width - 8));
  const top = Math.max(8, Math.min(props.y + 12, props.hostHeight - height - 8));

  return (
    <div
      ref={rootRef}
      className={styles.popup}
      style={{ left, top, width }}
      role="menu"
      aria-label="Overlapping items"
      onPointerDown={(event) => event.stopPropagation()}
      onPointerMove={(event) => event.stopPropagation()}
      onPointerUp={(event) => event.stopPropagation()}
      onWheel={(event) => event.stopPropagation()}
      onKeyDown={(event) => {
        const items = Array.from(
          rootRef.current?.querySelectorAll<HTMLButtonElement>('button') ?? [],
        );
        const index = items.indexOf(document.activeElement as HTMLButtonElement);
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
          event.preventDefault();
          const next =
            (index + (event.key === 'ArrowDown' ? 1 : items.length - 1)) %
            Math.max(1, items.length);
          items[next]?.focus();
        }
      }}
    >
      <div className={styles.title}>Select from overlapping items</div>
      {props.candidates.map((candidate, index) => {
        const Icon = ICON[candidate.kind] ?? Box;
        return (
          <button
            key={`${candidate.kind}:${index}`}
            type="button"
            role="menuitem"
            className={styles.row}
            onPointerEnter={(event) => {
              // One highlighted row: the pointer moves the focus (which previews the item).
              event.currentTarget.focus();
              props.onHover(candidate);
            }}
            onFocus={() => props.onHover(candidate)}
            onPointerLeave={() => props.onHover(null)}
            onClick={() => props.onChoose(candidate)}
          >
            <Icon size={13} className={styles.icon} aria-hidden />
            <span className={styles.label}>{candidate.label}</span>
            <span className={styles.owner}>
              {candidate.owner}
              {candidate.occluded ? ' · behind' : ''}
            </span>
          </button>
        );
      })}
    </div>
  );
}
