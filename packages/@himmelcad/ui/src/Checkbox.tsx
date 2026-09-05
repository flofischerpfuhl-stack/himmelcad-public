import { useEffect, useRef, type InputHTMLAttributes, type ReactNode } from 'react';

import styles from './Checkbox.module.css';

export interface CheckboxProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'type'> {
  label?: ReactNode;
  indeterminate?: boolean;
}

export function Checkbox({
  label,
  className,
  checked,
  indeterminate = false,
  ...rest
}: CheckboxProps): JSX.Element {
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (inputRef.current) inputRef.current.indeterminate = indeterminate;
  }, [indeterminate]);
  const rootClassName = className ? `${styles.root} ${className}` : styles.root;
  const control = (
    <>
      <input
        {...rest}
        ref={inputRef}
        type="checkbox"
        checked={checked}
        aria-checked={indeterminate ? 'mixed' : checked}
        className={styles.input}
      />
      <span
        className={styles.box}
        data-checked={checked ? 'true' : 'false'}
        data-indeterminate={indeterminate ? 'true' : 'false'}
        aria-hidden
      >
        <svg viewBox="0 0 16 16" focusable="false">
          <path d="M3.25 8.15 6.45 11.2 12.75 4.9" />
          <path className={styles.mixed} d="M3.5 8h9" />
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
