import { useCallback, useEffect, useRef } from 'react';

import styles from './Splitter.module.css';

interface SplitterProps {
  orientation: 'vertical' | 'horizontal';
  onResize: (deltaPx: number) => void;
}

export function Splitter({ orientation, onResize }: SplitterProps): JSX.Element {
  const startRef = useRef<number | null>(null);

  const onPointerMove = useCallback(
    (e: PointerEvent) => {
      const start = startRef.current;
      if (start === null) return;
      const current = orientation === 'vertical' ? e.clientX : e.clientY;
      onResize(current - start);
      startRef.current = current;
    },
    [orientation, onResize],
  );

  const onPointerUp = useCallback(() => {
    startRef.current = null;
    document.body.style.cursor = '';
    window.removeEventListener('pointermove', onPointerMove);
    window.removeEventListener('pointerup', onPointerUp);
  }, [onPointerMove]);

  useEffect(() => {
    return () => {
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerup', onPointerUp);
    };
  }, [onPointerMove, onPointerUp]);

  return (
    <div
      className={`${styles.root} ${orientation === 'vertical' ? styles.vertical : styles.horizontal}`}
      onPointerDown={(e) => {
        startRef.current = orientation === 'vertical' ? e.clientX : e.clientY;
        document.body.style.cursor = orientation === 'vertical' ? 'col-resize' : 'row-resize';
        window.addEventListener('pointermove', onPointerMove);
        window.addEventListener('pointerup', onPointerUp);
      }}
      role="separator"
      aria-orientation={orientation}
    />
  );
}
