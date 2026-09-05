import type { ButtonHTMLAttributes, ReactNode } from 'react';

import styles from './BaseControls.module.css';
import { Spinner } from './Spinner.js';

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'primary' | 'secondary' | 'quiet' | 'danger';
  size?: 'small' | 'medium' | 'large';
  loading?: boolean;
  loadingLabel?: string;
  pressed?: boolean;
  icon?: ReactNode;
}

export function Button({
  variant = 'secondary',
  size = 'medium',
  loading = false,
  loadingLabel = 'Working',
  pressed,
  'aria-pressed': ariaPressed,
  icon,
  disabled,
  children,
  className,
  ...props
}: ButtonProps): JSX.Element {
  return (
    <button
      {...props}
      type={props.type ?? 'button'}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      aria-pressed={pressed ?? ariaPressed}
      className={`${styles.button} ${styles[`button_${variant}`]} ${styles[`button_${size}`]} ${className ?? ''}`.trim()}
    >
      {loading ? <Spinner label={loadingLabel} size="small" /> : icon}
      <span>{children}</span>
    </button>
  );
}
