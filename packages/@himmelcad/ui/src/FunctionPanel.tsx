import type { ReactNode } from 'react';

import styles from './FunctionPanel.module.css';

export interface FunctionPanelProps {
  activeFunctionId: string | null;
  title?: string | undefined;
  children?: ReactNode;
}

export function FunctionPanel({ activeFunctionId, title, children }: FunctionPanelProps): JSX.Element {
  if (!activeFunctionId) {
    return (
      <div className={styles.empty}>
        <div className={styles.emptyTitle}>No active function</div>
        <div className={styles.emptyHint}>
          Activate a function from the ribbon. Its parameters appear here.
        </div>
      </div>
    );
  }
  return (
    <div className={styles.root}>
      <div className={styles.header}>{title ?? activeFunctionId}</div>
      <div className={styles.body}>{children}</div>
    </div>
  );
}
