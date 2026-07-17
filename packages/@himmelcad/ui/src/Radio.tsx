import type { InputHTMLAttributes, ReactNode } from 'react';

import styles from './Radio.module.css';

export interface RadioProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'type'> {
  label?: ReactNode;
}

export function Radio({ label, className, checked, ...rest }: RadioProps): JSX.Element {
  return (
    <label className={className ? `${styles.root} ${className}` : styles.root}>
      <input {...rest} type="radio" checked={checked} className={styles.input} />
      <span className={styles.dot} data-checked={checked ? 'true' : 'false'} aria-hidden />
      {label != null ? <span className={styles.label}>{label}</span> : null}
    </label>
  );
}
