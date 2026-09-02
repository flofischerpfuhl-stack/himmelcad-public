import { AlertTriangle, X } from 'lucide-react';
import { useId } from 'react';

import styles from './ConfirmationDialog.module.css';

export function ConfirmationDialog({
  title,
  message,
  confirmLabel,
  busyLabel = 'Working…',
  busy = false,
  secondaryLabel,
  onSecondary,
  confirmTone = 'danger',
  onConfirm,
  onCancel,
}: {
  title: string;
  message: string;
  confirmLabel: string;
  busyLabel?: string;
  busy?: boolean;
  secondaryLabel?: string;
  onSecondary?: () => void;
  confirmTone?: 'danger' | 'primary';
  onConfirm: () => void;
  onCancel: () => void;
}): JSX.Element {
  const titleId = useId();
  return (
    <div className={styles.dialog} role="dialog" aria-modal="true" aria-labelledby={titleId}>
      <header data-task-drag-handle>
        <div>
          <span>Confirmation</span>
          <h2 id={titleId}>{title}</h2>
        </div>
        <button type="button" onClick={onCancel} disabled={busy} aria-label="Close">
          <X size={17} />
        </button>
      </header>
      <div className={styles.content}>
        <AlertTriangle size={19} />
        <p>{message}</p>
      </div>
      <footer>
        <button type="button" onClick={onCancel} disabled={busy}>
          Cancel
        </button>
        {secondaryLabel && onSecondary && (
          <button type="button" className={styles.danger} onClick={onSecondary} disabled={busy}>
            {secondaryLabel}
          </button>
        )}
        <button
          type="button"
          className={confirmTone === 'primary' ? styles.primary : styles.danger}
          onClick={onConfirm}
          disabled={busy}
        >
          {busy ? busyLabel : confirmLabel}
        </button>
      </footer>
    </div>
  );
}
