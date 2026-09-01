import type { ReactNode } from 'react';

import { Checkbox } from './Checkbox.js';
import styles from './CrsTransformPair.module.css';

export interface CrsTransformPairProps {
  /** e.g. "Height transform" / "Horizontal transform" */
  title: string;
  hint?: string;
  /** Left column: current / source system controls */
  source: ReactNode;
  /** Right column: target system controls */
  target: ReactNode;
  /** When true, no transform is applied */
  noTransform: boolean;
  onNoTransformChange: (noTransform: boolean) => void;
  noTransformLabel?: string;
  /** Hide the checkbox when the parent flow already made the transform decision. */
  showNoTransform?: boolean;
  className?: string;
}

/**
 * Shared import transform layout: source left, target right, explicit no-transform.
 * Used by Image import and GCP import so both stay twins.
 */
export function CrsTransformPair({
  title,
  hint,
  source,
  target,
  noTransform,
  onNoTransformChange,
  noTransformLabel = 'No transform — keep source values',
  showNoTransform = true,
  className,
}: CrsTransformPairProps): JSX.Element {
  return (
    <section className={className ? `${styles.root} ${className}` : styles.root}>
      <div className={styles.header}>
        <div className={styles.title}>{title}</div>
        {showNoTransform ? (
          <Checkbox
            className={styles.noTransform}
            checked={noTransform}
            onChange={(e) => onNoTransformChange(e.target.checked)}
            label={noTransformLabel}
          />
        ) : null}
      </div>
      {hint ? <p className={styles.hint}>{hint}</p> : null}
      <div className={styles.columns} data-disabled={noTransform ? 'true' : 'false'}>
        <div className={styles.column}>
          <div className={styles.columnLabel}>Current / source</div>
          {source}
        </div>
        <div className={styles.column}>
          <div className={styles.columnLabel}>Target</div>
          {target}
        </div>
      </div>
    </section>
  );
}
