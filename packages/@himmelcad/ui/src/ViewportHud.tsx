import type { CSSProperties, Ref } from 'react';
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
  readonly backend?: string | null;
  readonly style?: CSSProperties;
  readonly outputRef?: Ref<HTMLOutputElement>;
}

export function ViewportHud({
  p95,
  p50,
  points,
  targetMs,
  quality,
  budget,
  backlog,
  backend,
  style,
  outputRef,
}: ViewportHudProps): JSX.Element {
  const tone =
    p95 !== null && p95 > 2 * targetMs
      ? 'error'
      : p95 !== null && p95 > targetMs
        ? 'warning'
        : 'normal';
  return (
    <output ref={outputRef} className={styles.hud} style={style} aria-label="Viewport diagnostics">
      <div>
        <span data-hud-idle hidden={p95 !== null}>
          Idle — no frames presented
        </span>
        <span data-hud-metrics hidden={p95 === null}>
          <span className={styles.number} data-hud-p95 data-tone={tone}>
            {p95?.toFixed(1) ?? '—'}
          </span>{' '}
          ms p95 ·{' '}
          <span className={styles.number} data-hud-p50>
            {p50?.toFixed(1) ?? '—'}
          </span>{' '}
          ms p50 ·{' '}
          <span className={styles.number} data-hud-points>
            {points === null ? '—' : (points / 1_000_000).toFixed(1)}
          </span>{' '}
          M pts
        </span>
      </div>
      <div>
        quality{' '}
        <span className={styles.quality} data-hud-quality>
          {quality ?? '—'}
        </span>{' '}
        · budget:{' '}
        <span className={styles.budget} data-hud-budget>
          {budget}
        </span>{' '}
        · backlog{' '}
        <span className={styles.backlog} data-hud-backlog>
          {backlog ?? '—'}
        </span>
      </div>
      <div>
        backend <span data-hud-backend>{backend ?? '—'}</span>
      </div>
    </output>
  );
}
