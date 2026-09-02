import type { InputHTMLAttributes, ReactNode } from 'react';

import styles from './Checkbox.module.css';

export interface CheckboxProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'type'> {
  label?: ReactNode;
}

export function Checkbox({ label, className, checked, ...rest }: CheckboxProps): JSX.Element {
  const rootClassName = className ? `${styles.root} ${className}` : styles.root;
  const control = (
    <>
      <input {...rest} type="checkbox" checked={checked} className={styles.input} />
      <span className={styles.box} data-checked={checked ? 'true' : 'false'} aria-hidden>
        <svg viewBox="0 0 16 16" focusable="false">
          <path d="M3.25 8.15 6.45 11.2 12.75 4.9" />
        </svg>
      </span>
    </>
  );

  return label != null ? (
    <label className={rootClassName}>
      {control}
      <span className={styles.label}>{label}</span>
    </label>
  ) : (
    <span className={rootClassName}>{control}</span>
  );
}
