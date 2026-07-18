import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from 'react';

import styles from './FloatingTaskIsland.module.css';

const FOCUSABLE = [
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  'a[href]',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

export function FloatingTaskIsland({
  children,
  modal = false,
  onRequestClose,
}: {
  children: ReactNode;
  modal?: boolean;
  onRequestClose?: () => void;
}): JSX.Element {
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const positioner = useRef<HTMLDivElement | null>(null);
  const drag = useRef<{
    pointerId: number;
    x: number;
    y: number;
    startX: number;
    startY: number;
  } | null>(null);
  const constrain = useCallback((position: { x: number; y: number }) => {
    const maximumX = Math.max(0, window.innerWidth / 2 - 120);
    const maximumY = Math.max(0, window.innerHeight / 2 - 80);
    return {
      x: clamp(position.x, -maximumX, maximumX),
      y: clamp(position.y, -maximumY, maximumY),
    };
  }, []);

  useEffect(() => {
    const keepVisible = (): void => setOffset((current) => constrain(current));
    const resetWithEscape = (event: KeyboardEvent): void => {
      if (event.key === 'Escape' && !drag.current) setOffset({ x: 0, y: 0 });
    };
    window.addEventListener('resize', keepVisible);
    window.addEventListener('keydown', resetWithEscape);
    return () => {
      window.removeEventListener('resize', keepVisible);
      window.removeEventListener('keydown', resetWithEscape);
    };
  }, [constrain]);

  useEffect(() => {
    if (!modal) return;
    const previouslyFocused =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const frame = window.requestAnimationFrame(() => {
      const first = positioner.current?.querySelector<HTMLElement>(FOCUSABLE);
      (first ?? positioner.current)?.focus();
    });
    return () => {
      window.cancelAnimationFrame(frame);
      previouslyFocused?.focus();
    };
  }, [modal]);

  const keepModalFocus = (event: ReactKeyboardEvent<HTMLDivElement>): void => {
    if (!modal) return;
    event.stopPropagation();
    if (event.key === 'Escape' && onRequestClose) {
      event.preventDefault();
      onRequestClose();
      return;
    }
    if (event.key !== 'Tab') return;
    const focusable = [...(positioner.current?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? [])];
    if (focusable.length === 0) {
      event.preventDefault();
      positioner.current?.focus();
      return;
    }
    const first = focusable[0];
    const last = focusable.at(-1);
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last?.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first?.focus();
    }
  };

  const startDrag = (event: ReactPointerEvent<HTMLDivElement>): void => {
    const target = event.target as HTMLElement;
    if (!target.closest('[data-task-drag-handle]') || target.closest('button,input,select')) return;
    drag.current = {
      pointerId: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      startX: offset.x,
      startY: offset.y,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const moveDrag = (event: ReactPointerEvent<HTMLDivElement>): void => {
    const current = drag.current;
    if (current?.pointerId !== event.pointerId) return;
    setOffset(
      constrain({
        x: current.startX + event.clientX - current.x,
        y: current.startY + event.clientY - current.y,
      }),
    );
  };

  const stopDrag = (event: ReactPointerEvent<HTMLDivElement>): void => {
    if (drag.current?.pointerId !== event.pointerId) return;
    drag.current = null;
    event.currentTarget.releasePointerCapture(event.pointerId);
  };

  const resetFromHeader = (event: ReactMouseEvent<HTMLDivElement>): void => {
    if ((event.target as HTMLElement).closest('[data-task-drag-handle]')) setOffset({ x: 0, y: 0 });
  };

  return (
    <div
      className={`${styles.layer} ${modal ? styles.modalLayer : ''}`}
      role="presentation"
      onKeyDown={keepModalFocus}
    >
      <div
        ref={positioner}
        className={styles.positioner}
        tabIndex={modal ? -1 : undefined}
        style={{
          position: 'relative',
          left: Math.round(offset.x),
          top: Math.round(offset.y),
        }}
        onPointerDown={startDrag}
        onPointerMove={moveDrag}
        onPointerUp={stopDrag}
        onPointerCancel={stopDrag}
        onDoubleClick={resetFromHeader}
      >
        {children}
      </div>
    </div>
  );
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value));
}
