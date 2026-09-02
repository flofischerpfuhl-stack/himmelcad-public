import { AlertTriangle } from 'lucide-react';
import { useEffect, useId, useRef, type KeyboardEvent } from 'react';

import styles from './CloseBlockedDialog.module.css';

export interface CloseBlockedReport {
  readonly reason: string;
  readonly timedOutJobs: readonly string[];
  readonly timedOutSideOperations: readonly string[];
  readonly durableDescription: string;
}

export function CloseBlockedDialog({
  report,
  onRetry,
  onCancel,
  onForceQuit,
}: {
  report: CloseBlockedReport;
  onRetry: () => void;
  onCancel: () => void;
  onForceQuit: () => void;
}): JSX.Element {
  const titleId = useId();
  const descriptionId = useId();
  const dialogRef = useRef<HTMLElement | null>(null);
  const retryRef = useRef<HTMLButtonElement | null>(null);
  useEffect(() => {
    retryRef.current?.focus();
  }, []);
  const handleKeyDown = (event: KeyboardEvent<HTMLElement>): void => {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      onCancel();
      return;
    }
    if (event.key !== 'Tab' || !dialogRef.current) return;
    const focusable = [...dialogRef.current.querySelectorAll<HTMLButtonElement>('button')];
    const first = focusable[0];
    const last = focusable.at(-1);
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last?.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first?.focus();
    }
  };
  const activeItems = [
    ...report.timedOutJobs.map((id) => `Job: ${id}`),
    ...report.timedOutSideOperations.map((id) => `Side operation: ${id}`),
  ];
  return (
    <section
      ref={dialogRef}
      className={styles.dialog}
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      aria-describedby={descriptionId}
      onKeyDown={handleKeyDown}
    >
      <header data-task-drag-handle>
        <AlertTriangle size={19} />
        <div>
          <span>Project close</span>
          <h2 id={titleId}>PhotoLab could not close safely</h2>
        </div>
      </header>
      <div className={styles.content} id={descriptionId}>
        <p>{report.reason}</p>
        <section className={styles.report} aria-label="Close drain report">
          <h3>Work still active</h3>
          {activeItems.length > 0 ? (
            <ul>
              {activeItems.map((item) => (
                <li key={item}>{item}</li>
              ))}
            </ul>
          ) : (
            <p>Details were not reported. PhotoLab has not recorded a clean shutdown.</p>
          )}
          <h3>Already durable</h3>
          <p>{report.durableDescription}</p>
        </section>
        <p className={styles.forceWarning}>
          Force quit interrupts running work. The project reopens with recovery from the last
          durable state, and a clean shutdown is not recorded.
        </p>
      </div>
      <footer>
        <button ref={retryRef} type="button" className={styles.primary} onClick={onRetry}>
          Retry
        </button>
        <button type="button" onClick={onCancel}>
          Cancel close
        </button>
        <button type="button" className={styles.danger} onClick={onForceQuit}>
          Force quit
        </button>
      </footer>
    </section>
  );
}
