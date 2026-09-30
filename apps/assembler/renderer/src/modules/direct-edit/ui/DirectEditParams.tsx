/**
 * History-card parameters of Offset Face and Delete Face: the value is an
 * `ExpressionField`; each edit is one `editFeatureParams` call (one undo step).
 */
import type { AssemblerState, FeaturePatch } from '../../../foundation/commands/store.js';
import { ExpressionField } from '../../../platform/widgets/ExpressionField.js';
import styles from '../../../platform/widgets/HistoryCard.module.css';
import type { DirectEditFeature } from '../kinds.js';
import { OFFSET_FACE_MODE_LABEL } from '../offsetFaceModes.js';

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

export function DirectEditParams({
  feature,
  state,
}: {
  feature: DirectEditFeature;
  state: AssemblerState;
}): JSX.Element {
  const edit = (patch: Record<string, unknown>) =>
    state.editFeatureParams(feature.id, patch as FeaturePatch);
  if (feature.kind === 'deleteFace') {
    return (
      <div className={styles.params}>
        <span className={styles.paramNote}>{plural(feature.faces.length, 'face')} removed</span>
      </div>
    );
  }
  // Radius/Diameter/Total are target values, re-measured on every evaluation (DIR-01);
  // the mode is chosen in the Offset Face tool, where the face geometry is known.
  const mode = feature.mode ?? 'offset';
  return (
    <div className={styles.params}>
      <ExpressionField
        label={mode === 'offset' ? 'Distance' : OFFSET_FACE_MODE_LABEL[mode]}
        value={feature.distance}
        unit="mm"
        onCommit={(v) => edit({ distance: v })}
      />
      <span className={styles.paramNote}>
        {mode === 'offset'
          ? plural(feature.faces.length, 'face')
          : mode === 'total'
            ? 'to the opposite face'
            : `${mode} of the face`}
      </span>
    </div>
  );
}
