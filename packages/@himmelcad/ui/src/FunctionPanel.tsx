import type { ReactNode } from 'react';
import { PanelRightClose, Settings2 } from 'lucide-react';

import styles from './FunctionPanel.module.css';
import { useLayoutStore } from './useLayoutStore.js';

export interface FunctionPanelProps {
  activeFunctionId: string | null;
  title?: string | undefined;
  children?: ReactNode;
}

export function FunctionPanel({
  activeFunctionId,
  title,
  children,
}: FunctionPanelProps): JSX.Element {
  const collapseRight = useLayoutStore((s) => s.toggleRightPanel);
  const collapseButton = (
    <button
      type="button"
      className={styles.headerCollapse}
      onClick={collapseRight}
      title="Collapse panel"
      aria-label="Collapse right panel"
    >
      <PanelRightClose size={14} />
    </button>
  );

  if (!activeFunctionId) {
    return (
      <div className={styles.root}>
        <div className={styles.header}>
          <span className={styles.headerLabel}>Function</span>
          <span className={styles.headerName}>—</span>
          {collapseButton}
        </div>
        <div className={styles.empty}>
          <Settings2 size={28} strokeWidth={1.4} color="var(--hc-fg-subtle)" />
          <div className={styles.emptyTitle}>No active function</div>
          <div className={styles.emptyHint}>
            Activate a function from the ribbon. Its parameters appear here.
          </div>
        </div>
      </div>
    );
  }
  return (
    <div className={styles.root}>
      <div className={styles.header}>
        <span className={styles.headerLabel}>Function</span>
        <span className={styles.headerName}>{title ?? activeFunctionId}</span>
        {collapseButton}
      </div>
      <div className={styles.body}>{children}</div>
    </div>
  );
}
