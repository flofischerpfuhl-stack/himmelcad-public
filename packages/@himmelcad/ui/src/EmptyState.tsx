import type { ReactNode } from 'react';

import styles from './EmptyState.module.css';

export interface EmptyStateProps {
  title: string;
  hint?: string;
  meta?: ReactNode;
  className?: string;
}

/** Console-family empty pane — matches bottom Console density. */
export function EmptyState({ title, hint, meta, className }: EmptyStateProps): JSX.Element {
  return (
    <div className={className ? `${styles.root} ${className}` : styles.root} role="status">
      <div className={styles.title}>{title}</div>
      {hint ? <div className={styles.hint}>{hint}</div> : null}
      {meta ? <div className={styles.meta}>{meta}</div> : null}
    </div>
  );
}
