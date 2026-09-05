import {
  createContext,
  forwardRef,
  useId,
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type CSSProperties,
  type KeyboardEventHandler,
  type PointerEvent as ReactPointerEvent,
  type Ref,
  type ReactNode,
} from 'react';

import styles from './BaseControls.module.css';
import { nextLinearIndex } from './controlInteractions.js';
import { registerEscapeRung } from './escapeLadder.js';

interface MenuContextValue {
  close: () => void;
  markFocused: (item: HTMLButtonElement) => void;
}

const MenuContext = createContext<MenuContextValue | null>(null);

export interface MenuProps {
  children: ReactNode;
  onClose: () => void;
  id?: string;
  ariaLabel?: string;
  className?: string;
  style?: CSSProperties;
  autoFocus?: boolean;
  menuRef?: Ref<HTMLDivElement>;
  onKeyDown?: KeyboardEventHandler<HTMLDivElement>;
}

export function Menu({
  children,
  onClose,
  id,
  ariaLabel = 'Menu',
  className,
  style,
  autoFocus = true,
  menuRef,
  onKeyDown,
}: MenuProps): JSX.Element {
  const ref = useRef<HTMLDivElement | null>(null);

  useEffect(() => registerEscapeRung('menu', () => (onClose(), true)), [onClose]);

  useEffect(() => {
    const onPointerDown = (event: PointerEvent): void => {
      if (!ref.current?.contains(event.target as Node | null)) onClose();
    };
    document.addEventListener('pointerdown', onPointerDown, true);
    return () => document.removeEventListener('pointerdown', onPointerDown, true);
  }, [onClose]);

  useEffect(() => {
    if (!autoFocus) return;
    queueMicrotask(() => {
      const first = menuItems(ref.current)[0];
      if (first) first.tabIndex = 0;
      first?.focus();
    });
  }, [autoFocus]);

  return (
    <MenuContext.Provider
      value={{
        close: onClose,
        markFocused: (item) => markFocusedMenuItem(menuItems(ref.current), item),
      }}
    >
      <div
        ref={(node) => {
          ref.current = node;
          setRef(menuRef, node);
        }}
        role="menu"
        id={id}
        aria-label={ariaLabel}
        className={className ? `${styles.menu} ${className}` : styles.menu}
        style={style}
        onKeyDown={(event) => {
          onKeyDown?.(event);
          if (event.defaultPrevented) return;
          if ((event.target as Element).closest('[role="menu"]') !== event.currentTarget) return;
          const items = menuItems(ref.current);
          if (items.length === 0) return;
          const current = Math.max(0, items.indexOf(document.activeElement as HTMLButtonElement));
          if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
            event.preventDefault();
            const next = nextLinearIndex(
              current,
              items.length,
              event.key as 'ArrowDown' | 'ArrowUp' | 'Home' | 'End',
              'vertical',
            );
            moveMenuFocus(items, next);
          }
        }}
      >
        {children}
      </div>
    </MenuContext.Provider>
  );
}

export interface ContextMenuProps extends MenuProps {
  x: number;
  y: number;
}

export function ContextMenu({ x, y, style, ...props }: ContextMenuProps): JSX.Element {
  return <Menu {...props} style={{ ...style, position: 'fixed', left: x, top: y }} />;
}

export interface MenuItemProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'onSelect'> {
  onSelect?: () => void;
}

export const MenuItem = forwardRef<HTMLButtonElement, MenuItemProps>(function MenuItem(
  { onSelect, onClick, disabled, children, className, onFocus, onBlur, ...props },
  forwardedRef,
) {
  const menu = useContext(MenuContext);
  return (
    <button
      {...props}
      ref={forwardedRef}
      type="button"
      role="menuitem"
      tabIndex={-1}
      disabled={disabled}
      aria-disabled={disabled || undefined}
      className={`${styles.menuItem} ${className ?? ''}`.trim()}
      onFocus={(event) => {
        onFocus?.(event);
        menu?.markFocused(event.currentTarget);
      }}
      onBlur={(event) => {
        onBlur?.(event);
        event.currentTarget.removeAttribute('data-focused');
      }}
      onClick={(event) => {
        onClick?.(event);
        if (event.defaultPrevented || disabled) return;
        onSelect?.();
        menu?.close();
      }}
    >
      {children}
    </button>
  );
});

MenuItem.displayName = 'MenuItem';

export interface MenuSubmenuProps {
  readonly label: ReactNode;
  readonly children: ReactNode;
  readonly ariaLabel: string;
  readonly className?: string;
  readonly defaultOpen?: boolean;
  readonly hoverOpenDelay?: number;
}

/** A menu row whose child menu follows the ARIA menubar keyboard convention. */
export function MenuSubmenu({
  label,
  children,
  ariaLabel,
  className,
  defaultOpen = false,
  hoverOpenDelay = 150,
}: MenuSubmenuProps): JSX.Element {
  const [open, setOpen] = useState(defaultOpen);
  const [position, setPosition] = useState<SubmenuPosition | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const submenuRef = useRef<HTMLDivElement | null>(null);
  const openTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const focusFirstOnOpen = useRef(false);
  const submenuId = useId();

  const clearTimers = (): void => {
    if (openTimer.current !== null) clearTimeout(openTimer.current);
    if (closeTimer.current !== null) clearTimeout(closeTimer.current);
    openTimer.current = null;
    closeTimer.current = null;
  };
  const openSubmenu = (focusFirst: boolean): void => {
    clearTimers();
    focusFirstOnOpen.current ||= focusFirst;
    setOpen(true);
  };
  const closeSubmenu = (restoreFocus: boolean): void => {
    clearTimers();
    focusFirstOnOpen.current = false;
    setOpen(false);
    setPosition(null);
    if (restoreFocus) queueMicrotask(() => triggerRef.current?.focus());
  };

  useEffect(() => clearTimers, []);

  useLayoutEffect(() => {
    if (!open || !triggerRef.current || !submenuRef.current) return;
    setPosition(
      getSubmenuPosition(
        triggerRef.current.getBoundingClientRect(),
        submenuRef.current.getBoundingClientRect(),
        window.innerWidth,
      ),
    );
    if (focusFirstOnOpen.current) {
      focusFirstOnOpen.current = false;
      moveMenuFocus(menuItems(submenuRef.current), 0);
    }
  }, [open]);

  const scheduleOpen = (): void => {
    if (open || openTimer.current !== null) return;
    openTimer.current = setTimeout(() => {
      openTimer.current = null;
      setOpen(true);
    }, hoverOpenDelay);
  };
  const scheduleClose = (event: ReactPointerEvent<HTMLSpanElement>): void => {
    if (event.relatedTarget instanceof Node && event.currentTarget.contains(event.relatedTarget)) {
      return;
    }
    if (openTimer.current !== null) clearTimeout(openTimer.current);
    openTimer.current = null;
    // The submenu overlaps the trigger by two pixels. This grace period also
    // preserves it while the pointer crosses diagonally toward the child menu.
    closeTimer.current = setTimeout(() => closeSubmenu(false), Math.max(hoverOpenDelay, 300));
  };

  return (
    <span
      className={styles.submenuHost}
      onPointerEnter={() => {
        if (closeTimer.current !== null) clearTimeout(closeTimer.current);
        closeTimer.current = null;
        scheduleOpen();
      }}
      onPointerLeave={scheduleClose}
    >
      <MenuItem
        ref={triggerRef}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? submenuId : undefined}
        onClick={(event) => {
          event.preventDefault();
          if (open) closeSubmenu(false);
          else openSubmenu(false);
        }}
        onKeyDown={(event) => {
          if (submenuKeyboardAction(event.key, false) !== 'open') return;
          event.preventDefault();
          event.stopPropagation();
          openSubmenu(true);
        }}
      >
        {label}
      </MenuItem>
      {open ? (
        <Menu
          id={submenuId}
          menuRef={submenuRef}
          onClose={() => closeSubmenu(false)}
          ariaLabel={ariaLabel}
          {...(className ? { className } : {})}
          autoFocus={false}
          style={{
            position: 'fixed',
            left: position?.x ?? 0,
            top: position?.y ?? 0,
            visibility: position ? 'visible' : 'hidden',
          }}
          onKeyDown={(event) => {
            if (submenuKeyboardAction(event.key, true) !== 'close') return;
            event.preventDefault();
            event.stopPropagation();
            closeSubmenu(true);
          }}
        >
          {children}
        </Menu>
      ) : null}
    </span>
  );
}

interface SubmenuRect {
  readonly left: number;
  readonly right: number;
  readonly top: number;
  readonly width: number;
}

export interface SubmenuPosition {
  readonly x: number;
  readonly y: number;
  readonly side: 'left' | 'right';
}

export function getSubmenuPosition(
  parent: SubmenuRect,
  submenu: Pick<SubmenuRect, 'width'>,
  viewportWidth: number,
  overlap = 2,
): SubmenuPosition {
  const rightX = parent.right - overlap;
  return rightX + submenu.width <= viewportWidth
    ? { x: rightX, y: parent.top, side: 'right' }
    : { x: parent.left - submenu.width + overlap, y: parent.top, side: 'left' };
}

export function submenuKeyboardAction(
  key: string,
  insideSubmenu: boolean,
): 'open' | 'close' | null {
  if (!insideSubmenu && key === 'ArrowRight') return 'open';
  if (insideSubmenu && key === 'ArrowLeft') return 'close';
  return null;
}

export function MenuSeparator(): JSX.Element {
  return <div role="separator" className={styles.menuSeparator} />;
}

function menuItems(root: HTMLElement | null): HTMLButtonElement[] {
  if (!root) return [];
  return Array.from(
    root.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not(:disabled)'),
  ).filter((item) => item.closest('[role="menu"]') === root);
}

function setRef<T>(ref: Ref<T> | undefined, value: T | null): void {
  if (typeof ref === 'function') ref(value);
  else if (ref) ref.current = value;
}

type RovingMenuItem = Pick<
  HTMLButtonElement,
  'focus' | 'removeAttribute' | 'setAttribute' | 'tabIndex'
>;

export function moveMenuFocus(items: RovingMenuItem[], next: number): void {
  const nextItem = items[next];
  if (!nextItem) return;
  for (const item of items) {
    item.tabIndex = item === nextItem ? 0 : -1;
    item.removeAttribute('data-focused');
  }
  nextItem.setAttribute('data-focused', 'true');
  nextItem.focus();
}

function markFocusedMenuItem(items: HTMLButtonElement[], focused: HTMLButtonElement): void {
  for (const item of items) {
    if (item === focused) item.setAttribute('data-focused', 'true');
    else item.removeAttribute('data-focused');
  }
}
