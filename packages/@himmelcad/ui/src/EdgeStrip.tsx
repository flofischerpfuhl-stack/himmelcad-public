import {
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
} from 'lucide-react';

import styles from './EdgeStrip.module.css';

export interface EdgeStripProps {
  /** Side of the workspace this strip lives on. Decides chevron + dimensions. */
  side: 'left' | 'right' | 'bottom';
  label: string;
  onExpand: () => void;
}

/**
 * Thin clickable affordance shown where a panel WOULD be when it is
 * collapsed. Solves the "where did my panel go?" problem without forcing
 * the user to remember the status-bar toggles.
 *
 * Visually a flat void-coloured strip the width of the gap, with a tiny
 * chevron in the middle. Hovering brightens the strip and shows the label
 * as a vertical/horizontal hint so the user knows what they're about to
 * expand.
 */
export function EdgeStrip({ side, label, onExpand }: EdgeStripProps): JSX.Element {
  const Chevron = side === 'left' ? ChevronRight : side === 'right' ? ChevronLeft : ChevronUp;
  const ChevronAlt =
    side === 'left' ? ChevronRight : side === 'right' ? ChevronLeft : ChevronDown;
  // ChevronAlt is currently unused but reserved for future "drag me wider"
  // hint; keep destructured to stop TS unused-import noise.
  void ChevronAlt;
  return (
    <button
      type="button"
      className={`${styles.root} ${styles[side]}`}
      onClick={onExpand}
      title={`Show ${label}`}
      aria-label={`Show ${label} panel`}
    >
      <span className={styles.chevron}>
        <Chevron size={14} />
      </span>
      <span className={styles.label}>{label}</span>
    </button>
  );
}
