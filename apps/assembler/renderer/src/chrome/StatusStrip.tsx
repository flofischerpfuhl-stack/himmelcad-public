/**
 * Bottom-centre status: selection summary ("1 face", "2 edges & 1 body")
 * or, while Measure is on, the selected body's W x D x H from the mock
 * evaluation. Hidden when there's nothing to say (and while a tool is
 * active — the tool pill/prompt take over that space).
 */
import { formatBodyDimensions, selectionSummary } from './format.js';
import type { AssemblerState } from '../model/store.js';
import styles from './StatusStrip.module.css';

export function StatusStrip({ state }: { state: AssemblerState }): JSX.Element | null {
  if (state.activeTool) return null;

  if (state.viewState.measureEnabled) {
    const bodySelection = state.selection.find((item) => item.kind === 'body');
    if (bodySelection) {
      const body = state.evaluation.bodies.find((b) => b.id === bodySelection.bodyId);
      if (body) {
        return (
          <div className={styles.root} role="status">
            {body.name}: {formatBodyDimensions(body)}
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
