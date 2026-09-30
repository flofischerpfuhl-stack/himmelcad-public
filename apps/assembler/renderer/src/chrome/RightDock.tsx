/**
 * Right column: below the viewport-owned view-cube area (kept free —
 * top:12/right:12, ~150x150), a small strip with the snap-to-grid toggle +
 * grid-step readout and the Display popover (modes, edge/grid/axes toggles,
 * `DisplayMenu.tsx`); below it, the History panel toggle.
 */
import { History as HistoryIcon, Magnet, Variable } from 'lucide-react';

import { Select, Tooltip } from '@himmelcad/ui';

import type { AssemblerState } from '../model/store.js';
import { DisplayMenu } from './DisplayMenu.js';
import styles from './RightDock.module.css';

const GRID_STEPS = [1, 2, 5, 10, 20, 50];

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
        <span className={styles.label}>Display</span>
        <DisplayMenu state={state} />
      </div>
      <Tooltip content="Parameters (Ctrl+Alt+P)">
        <button
          type="button"
          className={`${styles.historyToggle} ${state.panels.parameters ? styles.historyToggleActive : ''}`}
          aria-label="Toggle parameters panel"
          aria-pressed={state.panels.parameters}
          onClick={() => state.togglePanel('parameters')}
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
          onClick={() => state.togglePanel('history')}
        >
          <HistoryIcon size={14} />
          History
        </button>
      </Tooltip>
    </div>
  );
}
