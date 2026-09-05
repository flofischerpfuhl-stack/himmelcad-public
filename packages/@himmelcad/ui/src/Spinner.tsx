import { useEffect, useState } from 'react';

import styles from './BaseControls.module.css';

export interface SpinnerProps {
  label?: string;
  delay?: number;
  size?: 'small' | 'medium';
  className?: string | undefined;
}

export function Spinner({
  label = 'Working',
  delay = 300,
  size = 'medium',
  className,
}: SpinnerProps): JSX.Element | null {
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    setVisible(false);
    const timer = window.setTimeout(() => setVisible(true), spinnerDelay(delay));
    return () => window.clearTimeout(timer);
  }, [delay]);
  if (!visible) return null;
  return <SpinnerVisual label={label} size={size} className={className} />;
}

/** The post-delay visual state, exported for deterministic semantic fixtures. */
export function SpinnerVisual({
  label,
  size,
  className,
}: Required<Pick<SpinnerProps, 'label' | 'size'>> & Pick<SpinnerProps, 'className'>): JSX.Element {
  return (
    <span
      role="status"
      aria-label={label}
      className={`${styles.spinner} ${styles[`spinner_${size}`]} ${className ?? ''}`.trim()}
    />
  );
}

export function spinnerDelay(requested: number): number {
  return Math.max(300, requested);
}
