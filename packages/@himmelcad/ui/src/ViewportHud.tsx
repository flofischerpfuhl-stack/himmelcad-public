import type { CSSProperties } from 'react';
import styles from './ViewportHud.module.css';

export interface ViewportHudProps {
  readonly p95: number | null;
  readonly p50: number | null;
  readonly points: number | null;
  readonly targetMs: number;
  /** Supplied by the governor; null means no tier has been reported. */
  readonly quality: string | null;
  readonly budget: string;
  readonly backlog: number | null;
  readonly style?: CSSProperties;
}

export function ViewportHud({
  p95,
  p50,
  points,
  targetMs,
  quality,
  budget,
  backlog,
  style,
}: ViewportHudProps): JSX.Element {
  const tone =
    p95 !== null && p95 > 2 * targetMs
      ? 'error'
      : p95 !== null && p95 > targetMs
        ? 'warning'
        : 'normal';
  return (
    <output className={styles.hud} style={style} aria-label="Viewport diagnostics">
      <div>
        {p95 === null ? (
          <span>Idle — no frames presented</span>
        ) : (
          <>
            <span className={styles.number} data-tone={tone}>
              {p95.toFixed(1)}
            </span>{' '}
            ms p95 · <span className={styles.number}>{p50?.toFixed(1) ?? '—'}</span> ms p50 ·{' '}
            <span className={styles.number}>
              {points === null ? '—' : (points / 1_000_000).toFixed(1)}
            </span>{' '}
            M pts
          </>
        )}
      </div>
      <div>
        quality <span className={styles.quality}>{quality ?? '—'}</span> · budget:{' '}
        <span className={styles.budget}>{budget}</span> · backlog{' '}
        <span className={styles.backlog}>{backlog ?? '—'}</span>
      </div>
    </output>
  );
}
