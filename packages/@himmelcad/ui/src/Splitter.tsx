import { useEffect, useRef, type PointerEvent as ReactPointerEvent } from 'react';

import styles from './Splitter.module.css';

interface SplitterProps {
  orientation: 'vertical' | 'horizontal';
  /**
   * Called with the per-event delta in pixels (positive = right/down). Use the
   * functional form of state setters so multiple events compose correctly:
   * `setWidth(prev => prev + delta)`. The Splitter itself never composes the
   * total drag distance.
   */
  onResize: (deltaPx: number) => void;
}

/**
 * Drag-handle splitter using PointerEvents + setPointerCapture, with
 * per-frame rAF batching of the resize callback.
 *
 * Why `setPointerCapture` instead of `window.addEventListener('pointermove')`:
 *   - All move/up events are routed back to the original element regardless
 *     of where the cursor moves, so we don't need to add/remove listeners
 *     on the window and we can't leak listeners on a missed pointerup.
 *   - The cursor + body-class pattern below ensures the resize cursor stays
 *     consistent across iframes / canvas children during the drag.
 *
 * Why rAF batching:
 *   - Pointermove can fire at 240 Hz on high-rate input devices. Each call
 *     into `onResize` triggers a zustand store update → React re-render →
 *     inline style update → ResizeObserver → WebGL backbuffer realloc. That
 *     full chain is 5-15 ms per event, instantly tanking framerate.
 *   - With rAF batching we coalesce all moves in a frame into one delta, so
 *     the heavy resize chain runs at most once per refresh cycle.
 *
 * INVARIANT: when the drag ends (pointerup *or* pointercancel) the body
 * `hc-resizing-*` class is removed; otherwise the entire app would keep the
 * col-resize cursor. The pending rAF is also flushed/cancelled.
 */
export function Splitter({ orientation, onResize }: SplitterProps): JSX.Element {
  // Ref-mirror of the latest onResize so we never call a stale closure during
  // a drag that started before the parent re-rendered with new state.
  const onResizeRef = useRef(onResize);
  onResizeRef.current = onResize;
  const lastPosRef = useRef<number | null>(null);
  const pendingDeltaRef = useRef(0);
  const rafRef = useRef<number | null>(null);

  const bodyClass = orientation === 'vertical' ? 'hc-resizing-col' : 'hc-resizing-row';

  const flush = () => {
    rafRef.current = null;
    const d = pendingDeltaRef.current;
    pendingDeltaRef.current = 0;
    if (d !== 0) onResizeRef.current(d);
  };

  const cancelPending = () => {
    if (rafRef.current !== null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
    pendingDeltaRef.current = 0;
  };

  // Cancel any in-flight rAF on unmount.
  useEffect(() => () => cancelPending(), []);

  const stopDrag = (e: ReactPointerEvent<HTMLDivElement>) => {
    lastPosRef.current = null;
    // Apply any leftover delta before tearing down so the final position is
    // committed even if pointerup arrives between two rAFs.
    if (pendingDeltaRef.current !== 0) flush();
    cancelPending();
    document.body.classList.remove('hc-resizing-col', 'hc-resizing-row');
    try {
      e.currentTarget.releasePointerCapture(e.pointerId);
    } catch {
      /* already released */
    }
  };

  return (
    <div
      className={`${styles.root} ${
        orientation === 'vertical' ? styles.vertical : styles.horizontal
      }`}
      role="separator"
      aria-orientation={orientation}
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        e.preventDefault();
        try {
          e.currentTarget.setPointerCapture(e.pointerId);
        } catch {
          /* ignore */
        }
        lastPosRef.current = orientation === 'vertical' ? e.clientX : e.clientY;
        document.body.classList.add(bodyClass);
      }}
      onPointerMove={(e) => {
        const last = lastPosRef.current;
        if (last === null) return;
        const cur = orientation === 'vertical' ? e.clientX : e.clientY;
        const delta = cur - last;
        if (delta === 0) return;
        lastPosRef.current = cur;
        pendingDeltaRef.current += delta;
        if (rafRef.current === null) {
          rafRef.current = requestAnimationFrame(flush);
        }
      }}
      onPointerUp={stopDrag}
      onPointerCancel={stopDrag}
      onLostPointerCapture={() => {
        lastPosRef.current = null;
        cancelPending();
        document.body.classList.remove('hc-resizing-col', 'hc-resizing-row');
      }}
    />
  );
}
