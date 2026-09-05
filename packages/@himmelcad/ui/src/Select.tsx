import {
  Children,
  isValidElement,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactElement,
  type ReactNode,
  type SelectHTMLAttributes,
} from 'react';
import { ChevronDown } from 'lucide-react';

import styles from './Select.module.css';

export interface SelectOption {
  value: string;
  label: string;
  disabled?: boolean;
}

export interface SelectProps extends Omit<SelectHTMLAttributes<HTMLSelectElement>, 'children'> {
  wrapClassName?: string | undefined;
  /** Preferred: explicit options. Falls back to parsing <option> children. */
  options?: readonly SelectOption[] | undefined;
  children?: ReactNode;
}

function optionsFromChildren(children: ReactNode): SelectOption[] {
  const out: SelectOption[] = [];
  Children.forEach(children, (child) => {
    if (!isValidElement(child)) return;
    const el = child as ReactElement<{
      value?: string | number;
      children?: ReactNode;
      disabled?: boolean;
    }>;
    const typeName =
      typeof el.type === 'string' ? el.type : ((el.type as { name?: string }).name ?? '');
    if (typeName !== 'option' && typeName !== 'Option') {
      // Nested fragments
      if (el.props.children) out.push(...optionsFromChildren(el.props.children));
      return;
    }
    const value = el.props.value != null ? String(el.props.value) : flattenLabel(el.props.children);
    const label = flattenLabel(el.props.children) || value;
    out.push({ value, label, disabled: Boolean(el.props.disabled) });
  });
  return out;
}

function flattenLabel(node: ReactNode): string {
  if (node == null || typeof node === 'boolean') return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(flattenLabel).join('');
  if (isValidElement(node)) {
    return flattenLabel((node.props as { children?: ReactNode }).children);
  }
  return '';
}

/**
 * Custom dropdown — no native OS select popup.
 * Accepts either `options` or classic `<option>` children for drop-in use.
 */
export function Select({
  wrapClassName,
  className,
  children,
  options: optionsProp,
  value,
  defaultValue,
  disabled,
  onChange,
  'aria-label': ariaLabel,
  id,
  name,
}: SelectProps): JSX.Element {
  const listId = useId();
  const rootRef = useRef<HTMLDivElement | null>(null);
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  const [open, setOpen] = useState(false);
  const [menuStyle, setMenuStyle] = useState<CSSProperties | undefined>();
  const [internal, setInternal] = useState(String(defaultValue ?? ''));

  const options = useMemo(
    () =>
      optionsProp && optionsProp.length > 0 ? [...optionsProp] : optionsFromChildren(children),
    [optionsProp, children],
  );

  const controlled = value !== undefined;
  const current = controlled ? String(value) : internal;
  const selected = options.find((o) => o.value === current) ?? options[0];
  const label = selected?.label ?? (current || '—');

  useLayoutEffect(() => {
    if (!open || !buttonRef.current) return;
    const rect = buttonRef.current.getBoundingClientRect();
    const maxHeight = Math.min(280, window.innerHeight - rect.bottom - 12);
    setMenuStyle({
      position: 'fixed',
      top: rect.bottom + 4,
      left: rect.left,
      minWidth: Math.max(rect.width, 140),
      maxHeight: Math.max(120, maxHeight),
      zIndex: 'var(--hc-z-popover)',
    });
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent): void => {
      const t = e.target as Node | null;
      if (!t) return;
      if (rootRef.current?.contains(t)) return;
      // menu is portaled-like fixed inside root, so root contains it
      setOpen(false);
    };
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDoc);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const pick = (next: string): void => {
    if (!controlled) setInternal(next);
    if (onChange) {
      const event = {
        target: { value: next, name: name ?? '' },
        currentTarget: { value: next, name: name ?? '' },
      } as unknown as React.ChangeEvent<HTMLSelectElement>;
      onChange(event);
    }
    setOpen(false);
  };

  return (
    <div
      ref={rootRef}
      className={wrapClassName ? `${styles.wrap} ${wrapClassName}` : styles.wrap}
      data-open={open ? 'true' : 'false'}
      data-disabled={disabled ? 'true' : 'false'}
    >
      <button
        ref={buttonRef}
        id={id}
        type="button"
        className={className ? `${styles.trigger} ${className}` : styles.trigger}
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={listId}
        aria-label={ariaLabel}
        onClick={() => {
          if (!disabled) setOpen((v) => !v);
        }}
      >
        <span className={styles.value}>{label}</span>
        <ChevronDown size={14} className={styles.chevron} aria-hidden />
      </button>
      {name ? <input type="hidden" name={name} value={current} readOnly /> : null}
      {open && !disabled ? (
        <ul id={listId} className={styles.menu} style={menuStyle} role="listbox" tabIndex={-1}>
          {options.map((opt) => {
            const active = opt.value === current;
            return (
              <li key={opt.value} role="presentation">
                <button
                  type="button"
                  role="option"
                  aria-selected={active}
                  disabled={opt.disabled}
                  className={active ? `${styles.option} ${styles.optionActive}` : styles.option}
                  onClick={() => {
                    if (!opt.disabled) pick(opt.value);
                  }}
                >
                  {opt.label}
                </button>
              </li>
            );
          })}
          {options.length === 0 ? <li className={styles.empty}>No options</li> : null}
        </ul>
      ) : null}
    </div>
  );
}
