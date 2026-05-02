import type { ReactNode } from 'react';

import styles from './StatusBar.module.css';

export interface StatusBarItem {
  id: string;
  content: ReactNode;
  align?: 'left' | 'right';
  title?: string;
}

export interface StatusBarProps {
  items: StatusBarItem[];
}

export function StatusBar({ items }: StatusBarProps): JSX.Element {
  const left = items.filter((i) => (i.align ?? 'left') === 'left');
  const right = items.filter((i) => i.align === 'right');
  return (
    <div className={styles.root} role="status">
      <div className={styles.side}>
        {left.map((i) => (
          <span key={i.id} className={styles.item} title={i.title}>
            {i.content}
          </span>
        ))}
      </div>
      <div className={styles.side}>
        {right.map((i) => (
          <span key={i.id} className={styles.item} title={i.title}>
            {i.content}
          </span>
        ))}
      </div>
    </div>
  );
}
