/**
 * Bottom-centre status: CAD-kernel load progress/errors (always shown until
 * the kernel is ready), else the selection summary ("1 face", "2 edges &
 * 1 body") or, while Measure is on, the selected body's W x D x H and exact
 * B-rep volume. Otherwise hidden while a tool is active — the tool pill and
 * prompt take over that space.
 */
import { formatBodyDimensions, selectionSummary } from './format.js';
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
    const bodySelection = state.selection.find((item) => item.kind === 'body');
    if (bodySelection) {
      const body = state.evaluation.bodies.find((b) => b.id === bodySelection.bodyId);
      if (body) {
        return (
          <div className={styles.root} role="status">
            {body.name}: {formatBodyDimensions(body)} ·{' '}
            {Math.round(body.volume).toLocaleString('en-US')} mm³
          </div>
        );
      }
    }
  }

  const summary = selectionSummary(state.selection);
  if (!summary) return null;
  return (
    <div className={styles.root} role="status">
      {summary}
    </div>
  );
}
