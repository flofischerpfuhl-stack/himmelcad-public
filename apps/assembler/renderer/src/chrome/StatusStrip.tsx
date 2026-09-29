/**
 * Bottom-centre status: CAD-kernel load progress/errors (always shown until
 * the kernel is ready), else the selection summary ("1 face", "2 edges &
 * 1 body") or, while Measure is on, a quick measurement from the kernel's
 * exact B-rep data (body W x D x H and volume, edge length or circle
 * diameter, face area, distance of two parallel planar faces). Hidden while
 * a tool is active — the tool pill and prompt take over that space.
 */
import { withDisplayNames, useItemsStore } from '../model/items.js';
import { measureSelection } from '../model/modeling.js';
import { formatLength, usePreferences, type LengthUnit } from '../model/preferences.js';
import { referenceMeshWorldBounds } from '../model/referenceMesh.js';
import { selectionSummary } from './format.js';
import type { AssemblerState } from '../model/store.js';
import styles from './StatusStrip.module.css';

/** Bounding-box measurement for a single selected reference mesh (it has no B-rep, so only min/max is meaningful — no volume/face/edge measurement). */
function measureMeshSelection(state: AssemblerState, units: LengthUnit): string | null {
  const meshItems = state.selection.filter((s) => s.kind === 'mesh');
  if (meshItems.length !== 1 || meshItems.length !== state.selection.length) return null;
  const mesh = state.referenceMeshes.find((m) => m.id === meshItems[0]!.meshId);
  if (!mesh) return null;
  const { size } = referenceMeshWorldBounds(mesh);
  const [w, d, h] = size.map((v) => formatLength(Math.abs(v), units));
  return `${mesh.name} (reference mesh): ${w} × ${d} × ${h}`;
}

export function StatusStrip({ state }: { state: AssemblerState }): JSX.Element | null {
  const units = usePreferences((p) => p.units);
  const meta = useItemsStore();
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
    const measured =
      measureMeshSelection(state, units) ??
      measureSelection(
        { ...state.evaluation, bodies: withDisplayNames(state.evaluation.bodies, meta) },
        state.selection,
        units,
      );
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
