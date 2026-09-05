import { useEffect, type ReactNode } from 'react';

import styles from './BaseControls.module.css';

export type ToastTone = 'info' | 'success' | 'warning' | 'error';

// Visual accent mapping: info -> accent; success/warning/error -> their status tokens.

export interface ToastProps {
  children: ReactNode;
  tone?: ToastTone;
  action?: ReactNode;
  onDismiss?: () => void;
  autoDismiss?: number | false;
}

export function Toast({
  children,
  tone = 'info',
  action,
  onDismiss,
  autoDismiss = 5000,
}: ToastProps): JSX.Element {
  useEffect(() => {
    if (autoDismiss === false || !onDismiss) return;
    const timer = window.setTimeout(onDismiss, Math.max(0, autoDismiss));
    return () => window.clearTimeout(timer);
  }, [autoDismiss, onDismiss]);
  return (
    <div
      className={`${styles.toast} ${styles[`toast_${tone}`]}`}
      role={tone === 'error' ? 'alert' : 'status'}
      aria-live={tone === 'error' ? 'assertive' : 'polite'}
    >
      <div className={styles.toastMessage}>{children}</div>
      {action ? <div className={styles.toastAction}>{action}</div> : null}
      {onDismiss ? (
        <button
          type="button"
          className={styles.toastDismiss}
          onClick={onDismiss}
          aria-label="Dismiss"
        >
          ×
        </button>
      ) : null}
    </div>
  );
}

export function ToastRegion({
  children,
  label = 'Notifications',
}: {
  children: ReactNode;
  label?: string;
}) {
  return (
    <section
      className={styles.toastRegion}
      aria-label={label}
      aria-live="polite"
      aria-relevant="additions"
    >
      {children}
    </section>
  );
}
