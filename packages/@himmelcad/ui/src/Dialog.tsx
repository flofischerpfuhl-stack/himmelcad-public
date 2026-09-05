import { useEffect, useId, useRef, type MouseEvent, type ReactNode, type RefObject } from 'react';

import styles from './BaseControls.module.css';
import { registerEscapeRung } from './escapeLadder.js';

export interface DialogProps {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  children: ReactNode;
  actions?: ReactNode;
  initialFocusRef?: RefObject<HTMLElement | null>;
  closeOnBackdrop?: boolean;
}

export function Dialog({
  open,
  onClose,
  title,
  children,
  actions,
  initialFocusRef,
  closeOnBackdrop = false,
}: DialogProps): JSX.Element | null {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const titleId = useId();

  useEffect(() => {
    if (!open) return;
    const previous = document.activeElement as HTMLElement | null;
    const root = rootRef.current;
    queueMicrotask(() => {
      const leastDestructiveAction = root?.querySelector<HTMLElement>(
        'footer button:not(:disabled), footer [href], footer [tabindex]:not([tabindex="-1"])',
      );
      (initialFocusRef?.current ?? leastDestructiveAction ?? focusable(root)[0] ?? root)?.focus();
    });
    return () => previous?.focus();
  }, [initialFocusRef, open]);

  useEffect(() => {
    if (!open) return;
    return registerEscapeRung('modal', () => (onClose(), true));
  }, [onClose, open]);

  if (!open) return null;
  const backdropClick = (event: MouseEvent<HTMLDivElement>): void => {
    if (closeOnBackdrop && event.target === event.currentTarget) onClose();
  };
  return (
    <div className={styles.dialogLayer} onMouseDown={backdropClick}>
      <div
        ref={rootRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        className={styles.dialog}
        onKeyDown={(event) => {
          if (event.key !== 'Tab') return;
          const items = focusable(rootRef.current);
          if (items.length === 0) {
            event.preventDefault();
            rootRef.current?.focus();
            return;
          }
          const first = items[0]!;
          const last = items.at(-1)!;
          if (event.shiftKey && document.activeElement === first) {
            event.preventDefault();
            last.focus();
          } else if (!event.shiftKey && document.activeElement === last) {
            event.preventDefault();
            first.focus();
          }
        }}
      >
        <header className={styles.dialogHeader}>
          <h2 id={titleId}>{title}</h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close dialog"
            className={styles.dialogClose}
          >
            ×
          </button>
        </header>
        <div className={styles.dialogBody}>{children}</div>
        {actions ? <footer className={styles.dialogActions}>{actions}</footer> : null}
      </div>
    </div>
  );
}

function focusable(root: HTMLElement | null): HTMLElement[] {
  if (!root) return [];
  return Array.from(
    root.querySelectorAll<HTMLElement>(
      'button:not(:disabled), [href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])',
    ),
  );
}
