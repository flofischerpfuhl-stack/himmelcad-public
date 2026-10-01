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
import { registerEscapeRung } from './escapeLadder.js';

export interface SelectOption {
  value: string;
  label: string;
  disabled?: boolean;
  /** Plain-language explanation rendered as a tooltip for disabled options. */
  description?: string;
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
 * Keyboard step of an open (or opening) select list, as a native select
 * behaves: arrows move over enabled options, Home/End jump, Enter/Space
 * pick. Returns the next active index, `'pick'` or `null` (key not handled).
 */
export function selectKeyStep(
  key: string,
  active: number,
  options: readonly Pick<SelectOption, 'disabled'>[],
): number | 'pick' | null {
  const enabled = options.map((o, i) => (o.disabled ? -1 : i)).filter((i) => i >= 0);
  if (enabled.length === 0) return null;
  if (key === 'Enter' || key === ' ') return 'pick';
  if (key === 'Home') return enabled[0]!;
  if (key === 'End') return enabled[enabled.length - 1]!;
  if (key === 'ArrowDown') return enabled.find((i) => i > active) ?? enabled[enabled.length - 1]!;
  if (key === 'ArrowUp') {
    const before = enabled.filter((i) => i < active);
    return before.length > 0 ? before[before.length - 1]! : enabled[0]!;
  }
  return null;
}

/**
 * Custom dropdown — no native OS select popup.
 * Accepts either `options` or classic `<option>` children for drop-in use.
 *
 * Intended behaviour (checked in Assembler Block 8): a pointer click on the
 * trigger opens and closes the list (like a native select). From the
 * keyboard, Alt+ArrowDown / ArrowDown / ArrowUp open it, arrows move,
 * Enter/Space pick, Tab closes. Escape closes only the list — it is the
 * UIP-D14 `menu` rung, so an open list inside a dialog does not also close
 * the dialog — and returns focus to the trigger.
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

  const [activeIndex, setActiveIndex] = useState(-1);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent): void => {
      const t = e.target as Node | null;
      if (!t) return;
      if (rootRef.current?.contains(t)) return;
      // menu is portaled-like fixed inside root, so root contains it
      setOpen(false);
    };
    const close = (): boolean => {
      setOpen(false);
      buttonRef.current?.focus();
      return true;
    };
    // The open list is the `menu` rung of the shared Escape ladder (apps that install it);
    // the plain listener covers apps without the ladder.
    const unregister = registerEscapeRung('menu', close);
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape' && !e.defaultPrevented) close();
    };
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => {
      unregister();
      document.removeEventListener('mousedown', onDoc);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const openList = (): void => {
    setActiveIndex(selected ? Math.max(0, options.indexOf(selected)) : 0);
    setOpen(true);
  };

  const onTriggerKeyDown = (event: React.KeyboardEvent<HTMLButtonElement>): void => {
    if (disabled) return;
    if (!open) {
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        openList();
      }
      return;
    }
    if (event.key === 'Tab') {
      setOpen(false);
      return;
    }
    const step = selectKeyStep(event.key, activeIndex, options);
    if (step === null) return;
    event.preventDefault();
    if (step === 'pick') {
      const option = options[activeIndex];
      if (option && !option.disabled) pick(option.value);
      else setOpen(false);
      return;
    }
    setActiveIndex(step);
  };

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
          if (disabled) return;
          if (open) setOpen(false);
          else openList();
        }}
        onKeyDown={onTriggerKeyDown}
      >
        <span className={styles.value}>{label}</span>
        <ChevronDown size={14} className={styles.chevron} aria-hidden />
      </button>
      {name ? <input type="hidden" name={name} value={current} readOnly /> : null}
      {open && !disabled ? (
        <ul id={listId} className={styles.menu} style={menuStyle} role="listbox" tabIndex={-1}>
          {options.map((opt, index) => {
            const active = opt.value === current;
            return (
              <li key={opt.value} role="presentation">
                <button
                  type="button"
                  role="option"
                  aria-selected={active}
                  disabled={opt.disabled}
                  title={opt.disabled ? opt.description : undefined}
                  data-keyboard-active={index === activeIndex ? 'true' : undefined}
                  tabIndex={-1}
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
