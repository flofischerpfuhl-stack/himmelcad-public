import { AlertTriangle, X } from 'lucide-react';
import { useEffect, useId, useRef, type KeyboardEvent } from 'react';

import styles from './ConfirmationDialog.module.css';

export function ConfirmationDialog({
  title,
  message,
  confirmLabel,
  busyLabel = 'Working…',
  busy = false,
  onConfirm,
  onCancel,
}: {
  title: string;
  message: string;
  confirmLabel: string;
  busyLabel?: string;
  busy?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}): JSX.Element {
  const titleId = useId();
  const dialogRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    // An aria-modal dialog must move focus inside itself when it opens.
    const dialog = dialogRef.current;
    if (!dialog) return;
    const primary = dialog.querySelector<HTMLElement>('[data-confirmation-primary="true"]');
    const first = primary ?? dialog.querySelector<HTMLElement>('button:not([disabled])');
    first?.focus();
  }, []);
  const trapTab = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'Tab' || !dialogRef.current) return;
    const focusable = [
      ...dialogRef.current.querySelectorAll<HTMLElement>('button:not([disabled])'),
    ];
    if (focusable.length === 0) return;
    const first = focusable[0]!;
    const last = focusable[focusable.length - 1]!;
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };
  return (
    <div
      ref={dialogRef}
      className={styles.dialog}
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      onKeyDown={trapTab}
    >
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
        <button
          data-confirmation-primary="true"
          type="button"
          className={styles.danger}
          onClick={onConfirm}
          disabled={busy}
        >
          {busy ? busyLabel : confirmLabel}
        </button>
      </footer>
    </div>
  );
}
