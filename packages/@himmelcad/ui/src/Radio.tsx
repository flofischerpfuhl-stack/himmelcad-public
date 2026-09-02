import type { InputHTMLAttributes, ReactNode } from 'react';

import styles from './Radio.module.css';

export interface RadioProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'type'> {
  label?: ReactNode;
}

export function Radio({ label, className, checked, ...rest }: RadioProps): JSX.Element {
  const rootClassName = className ? `${styles.root} ${className}` : styles.root;
  const control = (
    <>
      <input {...rest} type="radio" checked={checked} className={styles.input} />
      <span className={styles.dot} data-checked={checked ? 'true' : 'false'} aria-hidden />
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
