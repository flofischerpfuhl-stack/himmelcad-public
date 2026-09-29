/**
 * Right column: below the viewport-owned view-cube area (kept free —
 * top:12/right:12, ~150x150), a small strip with the snap-to-grid toggle +
 * grid-step readout and the Shaded/Wireframe/X-Ray display-mode menu;
 * below it, the History panel toggle.
 */
import { History as HistoryIcon, Magnet } from 'lucide-react';

import { Select, Tooltip } from '@himmelcad/ui';

import type { AssemblerState, DisplayMode } from '../model/store.js';
import styles from './RightDock.module.css';

const GRID_STEPS = [1, 2, 5, 10, 20, 50];

const DISPLAY_MODE_OPTIONS: { value: DisplayMode; label: string }[] = [
  { value: 'shaded', label: 'Shaded' },
  { value: 'wireframe', label: 'Wireframe' },
  { value: 'xray', label: 'X-Ray' },
];

export function RightDock({ state }: { state: AssemblerState }): JSX.Element {
  return (
    <div className={styles.root}>
      <div className={styles.group}>
        <span className={styles.label}>Grid</span>
        <div className={styles.row}>
          <Tooltip content={state.viewState.snapToGrid ? 'Snap to grid: on' : 'Snap to grid: off'}>
            <button
              type="button"
              className={`${styles.snapButton} ${state.viewState.snapToGrid ? styles.snapButtonActive : ''}`}
              aria-label="Toggle snap to grid"
              aria-pressed={state.viewState.snapToGrid}
              onClick={() => state.setSnapToGrid(!state.viewState.snapToGrid)}
            >
              <Magnet size={14} />
            </button>
          </Tooltip>
          <Select
            wrapClassName={styles.select}
            aria-label="Grid step"
            value={String(state.viewState.gridStep)}
            options={GRID_STEPS.map((step) => ({ value: String(step), label: `${step} mm` }))}
            onChange={(event) => state.setGridStep(Number(event.currentTarget.value))}
          />
        </div>
        <span className={styles.label}>Display mode</span>
        <Select
          wrapClassName={styles.select}
          aria-label="Display mode"
          value={state.viewState.displayMode}
          options={DISPLAY_MODE_OPTIONS}
          onChange={(event) => state.setDisplayMode(event.currentTarget.value as DisplayMode)}
        />
      </div>
      <Tooltip content="History (Ctrl+Alt+H)">
        <button
          type="button"
          className={`${styles.historyToggle} ${state.panels.history ? styles.historyToggleActive : ''}`}
          aria-label="Toggle history panel"
          aria-pressed={state.panels.history}
          onClick={() => state.togglePanel('history')}
        >
          <HistoryIcon size={14} />
          History
        </button>
      </Tooltip>
    </div>
  );
}
