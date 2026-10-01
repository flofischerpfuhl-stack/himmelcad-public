/**
 * Right column: below the viewport-owned view-cube area (kept free —
 * top:12/right:12, ~150x150), a small strip with the Snapping popover +
 * grid-resolution read-out/lock (`SnapMenu.tsx`) and the Display popover (modes, projection,
 * edge/grid/axes toggles, `DisplayMenu.tsx`); below it, the Parameters and History toggles.
 *
 * Phone width (< 600 px, web): the strip would sit in the middle of the model, so it
 * collapses into one "View options" button under the view cube that opens the same
 * controls as a small sheet (tap outside or Esc closes it). Tablet and desktop unchanged.
 */
import { History as HistoryIcon, SlidersHorizontal, Variable } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';

import { Tooltip, registerEscapeRung } from '@himmelcad/ui';

import type { AssemblerState } from '../../foundation/commands/store.js';
import { DisplayMenu } from '../../modules/display/ui/DisplayMenu.js';
import { SnapControls } from './SnapMenu.js';
import styles from './RightDock.module.css';

const PHONE_QUERY = '(max-width: 599px)';

/** `true` while the window is phone-sized (the web build's phone layout). */
function usePhoneWidth(): boolean {
  const [phone, setPhone] = useState(
    () => typeof window !== 'undefined' && (window.matchMedia?.(PHONE_QUERY).matches ?? false),
  );
  useEffect(() => {
    const query = window.matchMedia?.(PHONE_QUERY);
    if (!query) return;
    const update = () => setPhone(query.matches);
    update();
    query.addEventListener('change', update);
    return () => query.removeEventListener('change', update);
  }, []);
  return phone;
}

function PanelToggles({
  state,
  onToggle,
}: {
  state: AssemblerState;
  onToggle?: () => void;
}): JSX.Element {
  return (
    <>
      <Tooltip content="Parameters (Ctrl+Alt+P)">
        <button
          type="button"
          className={`${styles.historyToggle} ${state.panels.parameters ? styles.historyToggleActive : ''}`}
          aria-label="Toggle parameters panel"
          aria-pressed={state.panels.parameters}
          onClick={() => {
            state.togglePanel('parameters');
            onToggle?.();
          }}
        >
          <Variable size={14} />
          Parameters
        </button>
      </Tooltip>
      <Tooltip content="History (Ctrl+Alt+H)">
        <button
          type="button"
          className={`${styles.historyToggle} ${state.panels.history ? styles.historyToggleActive : ''}`}
          aria-label="Toggle history panel"
          aria-pressed={state.panels.history}
          onClick={() => {
            state.togglePanel('history');
            onToggle?.();
          }}
        >
          <HistoryIcon size={14} />
          History
        </button>
      </Tooltip>
    </>
  );
}

function ViewControls({ state }: { state: AssemblerState }): JSX.Element {
  return (
    <div className={styles.group}>
      <span className={styles.label}>Snap · Grid</span>
      <SnapControls state={state} />
      <span className={styles.label}>Display</span>
      <DisplayMenu state={state} />
    </div>
  );
}

/** Phone width: one button under the view cube, opening the view controls as a sheet. */
function PhoneViewOptions({ state }: { state: AssemblerState }): JSX.Element {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  useEffect(() => {
    if (!open) return;
    const unregister = registerEscapeRung('menu', () => {
      setOpen(false);
      buttonRef.current?.focus();
      return true;
    });
    const onPointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node | null)) setOpen(false);
    };
    document.addEventListener('pointerdown', onPointerDown, true);
    return () => {
      unregister();
      document.removeEventListener('pointerdown', onPointerDown, true);
    };
  }, [open]);
  return (
    <div className={styles.phoneRoot} ref={rootRef}>
      <button
        ref={buttonRef}
        type="button"
        className={`${styles.phoneToggle} ${open ? styles.historyToggleActive : ''}`}
        aria-label="View options"
        aria-haspopup="dialog"
        aria-expanded={open}
        title="Snap, grid, display, parameters, history"
        onClick={() => setOpen((v) => !v)}
      >
        <SlidersHorizontal size={18} />
      </button>
      {open ? (
        <div className={styles.sheet} role="dialog" aria-label="View options">
          <ViewControls state={state} />
          <div className={styles.sheetToggles}>
            <PanelToggles state={state} onToggle={() => setOpen(false)} />
          </div>
        </div>
      ) : null}
    </div>
  );
}

export function RightDock({ state }: { state: AssemblerState }): JSX.Element {
  const phone = usePhoneWidth();
  if (phone) return <PhoneViewOptions state={state} />;
  return (
    <div className={styles.root}>
      <ViewControls state={state} />
      <PanelToggles state={state} />
    </div>
  );
}
