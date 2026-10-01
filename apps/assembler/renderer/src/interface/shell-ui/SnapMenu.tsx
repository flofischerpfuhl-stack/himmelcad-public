/**
 * Snap popover and grid-resolution read-out of the right dock (interaction
 * research §5, Shapr3D "Snapping Options" and the unit icon): separate
 * switches for grid, points, midpoints, guidelines and curves, the
 * auto-constraining switch, the text hints — snaps are suggestions, each
 * kind can be turned off — and the grid resolution, which follows the zoom
 * until it is locked. Grid snapping and the resolution are project view
 * state (`viewState`); the other switches are user preferences.
 */
import { Lock, LockOpen, Magnet } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';

import { Checkbox, Radio, Select, Tooltip, registerEscapeRung } from '@himmelcad/ui';

import {
  effectiveGridStep,
  formatGridStep,
  GRID_STEP_SERIES,
} from '../../platform/viewport/gridResolution.js';
import { usePreferences } from '../../platform/input/preferences.js';
import type { AssemblerState } from '../../foundation/commands/store.js';
import { useViewportUi } from '../../platform/viewport/viewportUi.js';

import type { SketchSnapToggles } from '../../platform/input/snapToggles.js';
import menuStyles from '../../modules/display/ui/DisplayMenu.module.css';
import styles from './RightDock.module.css';

const SNAP_ROWS: readonly { key: keyof SketchSnapToggles; label: string; hint: string }[] = [
  { key: 'points', label: 'Points', hint: 'End points, centres, origin' },
  { key: 'midpoints', label: 'Midpoints', hint: 'Middle of lines' },
  { key: 'guidelines', label: 'Guidelines', hint: 'Horizontal, vertical, aligned with points' },
  { key: 'curves', label: 'On curves', hint: 'Points on lines, arcs, circles' },
  { key: 'bodyPoints', label: '3D body points', hint: 'Vertices, edge midpoints, hole centres' },
  {
    key: 'farEdges',
    label: 'Far edges',
    hint: 'Edges away from the sketch plane (orthographic view)',
  },
];

/** Locked-step choices: the series around everyday print sizes. */
const LOCK_STEPS = GRID_STEP_SERIES.filter((s) => s >= 0.1 && s <= 100);

export function SnapControls({ state }: { state: AssemblerState }): JSX.Element {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const prefs = usePreferences();
  const live = useViewportUi((s) => s.liveGridStep);
  const view = state.viewState;
  const step = effectiveGridStep(view, live);
  const anySnap = view.snapToGrid || SNAP_ROWS.some((r) => prefs.snaps[r.key]);

  useEffect(() => {
    if (!open) return;
    const unregister = registerEscapeRung('menu', () => {
      setOpen(false);
      triggerRef.current?.focus();
      return true;
    });
    const onPointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node | null)) setOpen(false);
    };
    document.addEventListener('pointerdown', onPointerDown, true);
    queueMicrotask(() => rootRef.current?.querySelector<HTMLInputElement>('input')?.focus());
    return () => {
      unregister();
      document.removeEventListener('pointerdown', onPointerDown, true);
    };
  }, [open]);

  const setSnap = (key: keyof SketchSnapToggles, value: boolean) =>
    prefs.setPreference('snaps', { ...prefs.snaps, [key]: value });
  const lock = () => {
    state.setGridStep(step);
    state.setGridAuto(false);
  };

  return (
    <div className={menuStyles.host} ref={rootRef}>
      <div className={styles.row}>
        <Tooltip content="Snapping options">
          <button
            ref={triggerRef}
            type="button"
            className={`${styles.snapButton} ${anySnap ? styles.snapButtonActive : ''}`}
            aria-label="Snapping options"
            aria-haspopup="dialog"
            aria-expanded={open}
            onClick={() => setOpen((v) => !v)}
          >
            <Magnet size={14} />
          </button>
        </Tooltip>
        <Tooltip
          content={
            view.gridAuto
              ? `Grid resolution follows the zoom (${formatGridStep(step)}). Click to lock it.`
              : `Grid resolution locked at ${formatGridStep(step)}. Click to follow the zoom.`
          }
        >
          <button
            type="button"
            className={styles.gridReadout}
            aria-label={view.gridAuto ? 'Lock grid resolution' : 'Unlock grid resolution'}
            aria-pressed={!view.gridAuto}
            onClick={() => (view.gridAuto ? lock() : state.setGridAuto(true))}
          >
            <span className={styles.gridValue}>{formatGridStep(step)}</span>
            {view.gridAuto ? <LockOpen size={12} aria-hidden /> : <Lock size={12} aria-hidden />}
          </button>
        </Tooltip>
      </div>
      {open ? (
        <div className={menuStyles.popover} role="dialog" aria-label="Snapping options">
          <div className={menuStyles.sectionTitle}>Snap to</div>
          <div className={menuStyles.toggles}>
            <Checkbox
              label={
                <span className={menuStyles.modeLabel}>
                  <span>Grid</span>
                  <span className={menuStyles.hint}>Grid points ({formatGridStep(step)})</span>
                </span>
              }
              checked={view.snapToGrid}
              onChange={(e) => state.setSnapToGrid(e.currentTarget.checked)}
            />
            {SNAP_ROWS.map((row) => (
              <Checkbox
                key={row.key}
                label={
                  <span className={menuStyles.modeLabel}>
                    <span>{row.label}</span>
                    <span className={menuStyles.hint}>{row.hint}</span>
                  </span>
                }
                checked={prefs.snaps[row.key]}
                onChange={(e) => setSnap(row.key, e.currentTarget.checked)}
              />
            ))}
          </div>
          <div className={menuStyles.separator} role="separator" />
          <div className={menuStyles.toggles}>
            <Checkbox
              label={
                <span className={menuStyles.modeLabel}>
                  <span>Auto-constrain</span>
                  <span className={menuStyles.hint}>
                    Add horizontal, vertical, parallel, perpendicular while drawing
                  </span>
                </span>
              }
              checked={prefs.snaps.autoConstrain}
              onChange={(e) => setSnap('autoConstrain', e.currentTarget.checked)}
            />
            <div className={menuStyles.modeRow}>
              <span className={menuStyles.hint} id="hc-constraint-keep">
                New constraints keep
              </span>
              <Select
                aria-labelledby="hc-constraint-keep"
                value={prefs.constraintKeep}
                options={[
                  { value: 'first', label: 'First selected' },
                  { value: 'last', label: 'Last selected' },
                ]}
                onChange={(e) =>
                  prefs.setPreference(
                    'constraintKeep',
                    e.currentTarget.value === 'last' ? 'last' : 'first',
                  )
                }
              />
            </div>
            <Checkbox
              label="Show snap hints"
              checked={prefs.snapHints}
              onChange={(e) => prefs.setPreference('snapHints', e.currentTarget.checked)}
            />
          </div>
          <div className={menuStyles.separator} role="separator" />
          <div className={menuStyles.sectionTitle} id="hc-grid-resolution">
            Grid resolution
          </div>
          <div role="radiogroup" aria-labelledby="hc-grid-resolution" className={menuStyles.modes}>
            <Radio
              name="hc-grid-resolution"
              label={`Follow zoom (now ${formatGridStep(live ?? view.gridStep)})`}
              checked={view.gridAuto}
              onChange={() => state.setGridAuto(true)}
            />
            <div className={menuStyles.modeRow}>
              <Radio
                name="hc-grid-resolution"
                label="Locked"
                checked={!view.gridAuto}
                onChange={lock}
              />
              <Select
                aria-label="Locked grid resolution"
                value={String(view.gridAuto ? step : view.gridStep)}
                options={[...new Set([...LOCK_STEPS, view.gridStep])]
                  .sort((a, b) => a - b)
                  .map((s) => ({ value: String(s), label: formatGridStep(s) }))}
                onChange={(e) => {
                  state.setGridStep(Number(e.currentTarget.value));
                  state.setGridAuto(false);
                }}
              />
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
