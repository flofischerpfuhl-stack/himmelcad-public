/**
 * Right column: below the viewport-owned view-cube area (kept free —
 * top:12/right:12, ~150x150), a small strip with the Snapping popover +
 * grid-resolution read-out/lock (`SnapMenu.tsx`) and the Display popover (modes, edge/grid/axes toggles,
 * `DisplayMenu.tsx`); below it, the History panel toggle.
 */
import { History as HistoryIcon, Variable } from 'lucide-react';

import { Tooltip } from '@himmelcad/ui';

import type { AssemblerState } from '../model/store.js';
import { DisplayMenu } from './DisplayMenu.js';
import { SnapControls } from './SnapMenu.js';
import styles from './RightDock.module.css';

export function RightDock({ state }: { state: AssemblerState }): JSX.Element {
  return (
    <div className={styles.root}>
      <div className={styles.group}>
        <span className={styles.label}>Snap · Grid</span>
        <SnapControls state={state} />
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
