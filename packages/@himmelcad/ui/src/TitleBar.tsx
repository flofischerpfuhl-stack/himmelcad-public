import { useEffect, useState } from 'react';
import { Maximize2, Minimize2, Minus, X } from 'lucide-react';

import styles from './TitleBar.module.css';

export interface WindowControls {
  minimize: () => void;
  maximizeToggle: () => void;
  close: () => void;
  isMaximized: () => Promise<boolean>;
  onMaximizeChange: (cb: (maximized: boolean) => void) => () => void;
}

export interface TitleBarProps {
  appName?: string;
  productLabel?: string;
  projectLabel?: string;
  controls?: WindowControls | null;
  rightSlot?: React.ReactNode;
}

/**
 * Custom frameless titlebar.
 *
 * - Wordmark uses the HC-Wordmark font (Kamikaze) for the brand mark and a
 *   sub-label in the UI font for product / project context.
 * - Drag region is the whole bar except the controls (-webkit-app-region).
 * - When `controls` is null we fall back to no buttons (e.g. browser/WeltView).
 */
export function TitleBar({
  appName = 'HimmelCAD',
  productLabel = 'Builder',
  projectLabel,
  controls,
  rightSlot,
}: TitleBarProps): JSX.Element {
  const [maximized, setMaximized] = useState(false);

  useEffect(() => {
    if (!controls) return;
    let cancelled = false;
    void controls.isMaximized().then((m) => {
      if (!cancelled) setMaximized(m);
    });
    const off = controls.onMaximizeChange(setMaximized);
    return () => {
      cancelled = true;
      off();
    };
  }, [controls]);

  return (
    <div className={styles.root}>
      <div className={styles.left}>
        <CloudMark className={styles.logo} />
        <span className={styles.wordmark}>{appName}</span>
        <span className={styles.product}>{productLabel}</span>
      </div>
      <div className={styles.center}>
        {projectLabel && <span className={styles.project}>{projectLabel}</span>}
      </div>
      <div className={styles.right}>
        {rightSlot}
        {controls && (
          <div className={styles.controls}>
            <button
              type="button"
              className={styles.control}
              onClick={controls.minimize}
              aria-label="Minimize"
              title="Minimize"
            >
              <Minus size={14} strokeWidth={1.6} />
            </button>
            <button
              type="button"
              className={styles.control}
              onClick={controls.maximizeToggle}
              aria-label={maximized ? 'Restore' : 'Maximize'}
              title={maximized ? 'Restore' : 'Maximize'}
            >
              {maximized ? (
                <Minimize2 size={13} strokeWidth={1.6} />
              ) : (
                <Maximize2 size={12} strokeWidth={1.6} />
              )}
            </button>
            <button
              type="button"
              className={`${styles.control} ${styles.close}`}
              onClick={controls.close}
              aria-label="Close"
              title="Close"
            >
              <X size={14} strokeWidth={1.6} />
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

function CloudMark({ className }: { className?: string | undefined }): JSX.Element {
  // Inline so it tints with currentColor / theme without a separate fetch.
  // Original geometry from libs/polyshapev01 (Faceted Cloud Logo).
  return (
    <svg
      viewBox="0 0 256 256"
      width="22"
      height="22"
      className={className}
      aria-hidden="true"
      focusable="false"
    >
      <g transform="translate(18 45)" fillRule="evenodd">
        <polygon fill="#5a6373" points="42 145 85 125 110 165 60 175" />
        <polygon fill="#6b7585" points="110 165 85 125 165 125 145 170" />
        <polygon fill="#5a6373" points="165 125 208 145 190 175 145 170" />
        <polygon fill="#94a0b3" points="15 105 85 125 42 145" />
        <polygon fill="#a4afc1" points="85 125 128 75 165 125" />
        <polygon fill="#828fa3" points="165 125 235 105 208 145" />
        <polygon fill="#e4ecf6" points="50 55 85 125 15 105" />
        <polygon fill="#c8d2e0" points="50 55 95 65 85 125" />
        <polygon fill="#e4ecf6" points="128 15 95 65 128 75 160 65" />
        <polygon fill="#d4dde9" points="95 65 85 125 128 75" />
        <polygon fill="#e4ecf6" points="160 65 200 55 235 105 165 125" />
        <polygon fill="#c8d2e0" points="128 75 165 125 160 65" />
      </g>
    </svg>
  );
}
