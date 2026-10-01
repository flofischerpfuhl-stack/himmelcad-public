/**
 * History card of a construction plane/axis: its definition, the numeric
 * values (as expression fields) and Flip; each edit is one
 * `editFeatureParams` call (one undo step).
 */
import { Select } from '@himmelcad/ui';

import type { AssemblerState, FeaturePatch } from '../../../foundation/commands/store.js';
import { ExpressionField } from '../../../platform/widgets/ExpressionField.js';
import styles from '../../../platform/widgets/HistoryCard.module.css';
import { AXIS_DEF_LABEL, PLANE_DEF_LABEL, type ConstructionFeature } from '../construction.js';

export function ConstructionParams({
  feature,
  state,
}: {
  feature: ConstructionFeature;
  state: AssemblerState;
}): JSX.Element {
  const edit = (patch: Record<string, unknown>) =>
    state.editFeatureParams(feature.id, patch as FeaturePatch);
  const def = feature.definition;
  const label =
    feature.kind === 'constructionPlane'
      ? PLANE_DEF_LABEL[feature.definition.kind]
      : AXIS_DEF_LABEL[feature.definition.kind];
  return (
    <div className={styles.params}>
      <span className={styles.paramNote}>{label}</span>
      {def.kind === 'offset' ? (
        <ExpressionField
          label="Offset"
          value={def.distance}
          unit="mm"
          onCommit={(v) => edit({ definition: { ...def, distance: v } })}
        />
      ) : null}
      {def.kind === 'angle' || def.kind === 'tangent' ? (
        <ExpressionField
          label="Angle"
          value={def.angle}
          unit="°"
          onCommit={(v) => edit({ definition: { ...def, angle: v } })}
        />
      ) : null}
      <div>
        <span className={styles.paramLabel}>Direction</span>
        <Select
          aria-label={`${feature.name} direction`}
          value={feature.flip ? 'flipped' : 'normal'}
          options={[
            { value: 'normal', label: 'Normal' },
            { value: 'flipped', label: 'Flipped' },
          ]}
          onChange={(event) => edit({ flip: event.currentTarget.value === 'flipped' })}
        />
      </div>
    </div>
  );
}
