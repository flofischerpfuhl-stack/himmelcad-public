import { SpinnerVisual } from './Spinner.js';
import styles from './DurabilityIndicator.module.css';

export type DurabilityIndicatorState =
  | { readonly kind: 'stored' }
  | { readonly kind: 'storing' }
  | { readonly kind: 'failed'; readonly reason: string };

export function DurabilityIndicator({
  state,
  onRetry,
}: {
  state: DurabilityIndicatorState;
  onRetry?: () => void;
}): JSX.Element {
  if (state.kind === 'storing') {
    return (
      <span className={styles.root}>
        <SpinnerVisual label="Storing changes" size="small" className={styles.spinner} />
        Storing…
      </span>
    );
  }
  if (state.kind === 'failed') {
    return (
      <span className={`${styles.root} ${styles.error}`}>
        <span className={styles.dot} aria-hidden="true" />
        <span>Not stored — {state.reason}</span>
        {onRetry ? (
          <button type="button" className={styles.retry} onClick={onRetry}>
            Retry
          </button>
        ) : null}
      </span>
    );
  }
  return (
    <span className={styles.root}>
      <span className={styles.dot} aria-hidden="true" />
      Stored
    </span>
  );
}
