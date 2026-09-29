/**
 * Bottom-centre status: CAD-kernel load progress/errors (always shown until
 * the kernel is ready), else the selection summary ("1 face", "2 edges &
 * 1 body") or, while Measure is on, a quick measurement from the kernel's
 * exact B-rep data (body W x D x H and volume, edge length or circle
 * diameter, face area, distance of two parallel planar faces). Hidden while
 * a tool is active — the tool pill and prompt take over that space.
 */
import { measureSelection } from '../model/modeling.js';
import { selectionSummary } from './format.js';
import type { AssemblerState } from '../model/store.js';
import styles from './StatusStrip.module.css';

export function StatusStrip({ state }: { state: AssemblerState }): JSX.Element | null {
  if (state.kernelStatus !== 'ready') {
    const progress = state.kernelProgress;
    return (
      <div
        className={`${styles.root} ${state.kernelStatus === 'error' ? styles.error : ''}`}
        role="status"
        aria-live="polite"
      >
        {state.kernelMessage}
        {state.kernelStatus === 'loading' && progress !== null ? (
          <span
            className={styles.progress}
            role="progressbar"
            aria-label="CAD kernel loading"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.round(progress * 100)}
          >
            <span className={styles.progressFill} style={{ width: `${progress * 100}%` }} />
          </span>
        ) : null}
      </div>
    );
  }

  if (state.activeTool) return null;

  if (state.viewState.measureEnabled) {
    const measured = measureSelection(state.evaluation, state.selection);
    return (
      <div className={styles.root} role="status" aria-live="polite">
        {measured ?? 'Measure: select a body, an edge, a face or two parallel faces (Shift adds).'}
      </div>
    );
  }

  const summary = selectionSummary(state.selection);
  if (!summary) return null;
  return (
    <div className={styles.root} role="status">
      {summary}
    </div>
  );
}
