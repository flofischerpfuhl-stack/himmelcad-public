import type { InputHTMLAttributes, ReactNode } from 'react';

import styles from './Checkbox.module.css';

export interface CheckboxProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'type'> {
  label?: ReactNode;
}

export function Checkbox({ label, className, checked, ...rest }: CheckboxProps): JSX.Element {
  return (
    <label className={className ? `${styles.root} ${className}` : styles.root}>
      <input {...rest} type="checkbox" checked={checked} className={styles.input} />
      <span className={styles.box} data-checked={checked ? 'true' : 'false'} aria-hidden />
      {label != null ? <span className={styles.label}>{label}</span> : null}
    </label>
  );
}
