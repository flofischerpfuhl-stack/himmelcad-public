import styles from './BaseControls.module.css';

export interface ProgressBarProps {
  value: number;
  ariaLabel: string;
  indeterminate?: boolean;
  indeterminateLabel?: string;
}

export function ProgressBar({
  value,
  ariaLabel,
  indeterminate = false,
  indeterminateLabel = 'Working…',
}: ProgressBarProps): JSX.Element {
  const percent = Math.round(Math.max(0, Math.min(1, value)) * 100);
  return (
    <div
      className={styles.progressRow}
      role="progressbar"
      aria-label={ariaLabel.trim() || indeterminateLabel}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={indeterminate ? undefined : percent}
    >
      <div
        className={`${styles.progressTrack} ${indeterminate ? styles.progressIndeterminate : ''}`}
      >
        <span style={indeterminate ? undefined : { width: `${percent}%` }} />
      </div>
      <code>{indeterminate ? indeterminateLabel : `${percent}%`}</code>
    </div>
  );
}
