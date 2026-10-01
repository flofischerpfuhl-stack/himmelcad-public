import { ScanEye, X } from 'lucide-react';

import styles from './SelectThroughChip.module.css';

/**
 * Visible indicator while Select Through is on (interaction research §6:
 * "Durchgreifen braucht aktiven Indikator"): picks and boxes also reach
 * geometry hidden behind other geometry. Click the × (or Ctrl+Shift+S) to
 * turn it off.
 */
export function SelectThroughChip({ onTurnOff }: { onTurnOff: () => void }): JSX.Element {
  return (
    <div
      className={styles.chip}
      role="status"
      aria-live="polite"
      onPointerDown={(event) => event.stopPropagation()}
      onPointerMove={(event) => event.stopPropagation()}
      onPointerUp={(event) => event.stopPropagation()}
    >
      <ScanEye size={14} aria-hidden className={styles.icon} />
      <span className={styles.label}>Select Through</span>
      <span className={styles.hint}>hidden geometry is pickable</span>
      <button
        type="button"
        className={styles.close}
        aria-label="Turn off Select Through (Ctrl+Shift+S)"
        title="Turn off (Ctrl+Shift+S)"
        onClick={onTurnOff}
      >
        <X size={12} />
      </button>
    </div>
  );
}
