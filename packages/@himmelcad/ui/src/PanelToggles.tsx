import {
  PanelBottom,
  PanelBottomClose,
  PanelLeft,
  PanelLeftClose,
  PanelRight,
  PanelRightClose,
} from 'lucide-react';

import styles from './PanelToggles.module.css';
import { useLayoutStore } from './useLayoutStore.js';

/**
 * Compact set of three toggles for left/bottom/right panels. Designed to live
 * in the status bar so users always have a way to bring a collapsed panel
 * back, regardless of where the panel's own header lives.
 */
export function PanelToggles(): JSX.Element {
  const left = useLayoutStore((s) => s.leftPanelCollapsed);
  const bottom = useLayoutStore((s) => s.bottomPanelCollapsed);
  const right = useLayoutStore((s) => s.rightPanelCollapsed);
  const toggleLeft = useLayoutStore((s) => s.toggleLeftPanel);
  const toggleBottom = useLayoutStore((s) => s.toggleBottomPanel);
  const toggleRight = useLayoutStore((s) => s.toggleRightPanel);

  return (
    <div className={styles.root} role="group" aria-label="Panel visibility">
      <button
        type="button"
        className={`${styles.btn} ${!left ? styles.btnActive : ''}`}
        onClick={toggleLeft}
        title={left ? 'Show left panel' : 'Hide left panel'}
        aria-pressed={!left}
      >
        {left ? <PanelLeft size={14} /> : <PanelLeftClose size={14} />}
      </button>
      <button
        type="button"
        className={`${styles.btn} ${!bottom ? styles.btnActive : ''}`}
        onClick={toggleBottom}
        title={bottom ? 'Show console' : 'Hide console'}
        aria-pressed={!bottom}
      >
        {bottom ? <PanelBottom size={14} /> : <PanelBottomClose size={14} />}
      </button>
      <button
        type="button"
        className={`${styles.btn} ${!right ? styles.btnActive : ''}`}
        onClick={toggleRight}
        title={right ? 'Show right panel' : 'Hide right panel'}
        aria-pressed={!right}
      >
        {right ? <PanelRight size={14} /> : <PanelRightClose size={14} />}
      </button>
    </div>
  );
}
