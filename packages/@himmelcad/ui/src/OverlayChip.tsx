import type { ButtonHTMLAttributes, HTMLAttributes, ReactNode } from 'react';

import styles from './OverlayChip.module.css';

export interface OverlayChipBaseProps {
  children: ReactNode;
  /** Accent-outline active viewport-chrome state */
  active?: boolean | undefined;
  /** Solid accent border only */
  accent?: boolean | undefined;
  muted?: boolean | undefined;
  className?: string | undefined;
}

export type OverlayChipProps =
  | (OverlayChipBaseProps & { as?: 'div' } & HTMLAttributes<HTMLDivElement>)
  | (OverlayChipBaseProps & { as: 'button' } & ButtonHTMLAttributes<HTMLButtonElement>);

function buildClassName(
  interactive: boolean,
  active?: boolean,
  accent?: boolean,
  muted?: boolean,
  className?: string,
): string {
  return [
    styles.chip,
    interactive ? styles.chipInteractive : '',
    active ? styles.chipActive : '',
    accent ? styles.chipAccent : '',
    muted ? styles.chipMuted : '',
    className ?? '',
  ]
    .filter(Boolean)
    .join(' ');
}

/**
 * Viewport overlay control — coordinates, Frame all, Top-down, image tools.
 * Matches the coordinate readout geometry exactly.
 */
export function OverlayChip(props: OverlayChipProps): JSX.Element {
  if (props.as === 'button') {
    const { children, active, accent, muted, className, as: _as, ...rest } = props;
    return (
      <button
        type="button"
        className={buildClassName(true, active, accent, muted, className)}
        {...rest}
      >
        {children}
      </button>
    );
  }
  const { children, active, accent, muted, className, as: _as, ...rest } = props;
  return (
    <div className={buildClassName(false, active, accent, muted, className)} {...rest}>
      {children}
    </div>
  );
}

export function OverlayAxis({ children }: { children: ReactNode }): JSX.Element {
  return <span className={styles.axis}>{children}</span>;
}

export function OverlayKind({ children }: { children: ReactNode }): JSX.Element {
  return <span className={styles.kind}>{children}</span>;
}
