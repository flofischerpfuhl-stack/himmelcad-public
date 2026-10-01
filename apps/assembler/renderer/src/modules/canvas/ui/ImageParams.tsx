/**
 * History card of a reference image: its plane and picture, size,
 * position and rotation (expression fields), the opacity slider
 * (`ImageOpacitySlider.tsx`) and Calibrate…. Each commit is one
 * `editFeatureParams` call (one undo step).
 */
import { Ruler } from 'lucide-react';
import { Button } from '@himmelcad/ui';

import type { AssemblerState, FeaturePatch } from '../../../foundation/commands/store.js';
import { ExpressionField } from '../../../platform/widgets/ExpressionField.js';
import cardStyles from '../../../platform/widgets/HistoryCard.module.css';
import { useCanvasStore } from '../canvasStore.js';
import { useImageStore } from '../imageStore.js';
import { imageHeight, type ReferenceImageFeature } from '../referenceImage.js';
import { ImageOpacitySlider } from './ImageOpacitySlider.js';
import styles from './CanvasUi.module.css';

function planeText(feature: ReferenceImageFeature, state: AssemblerState): string {
  const plane = feature.plane;
  if (plane.kind === 'plane') {
    return plane.offset
      ? `${plane.plane} plane, offset ${plane.offset} mm`
      : `${plane.plane} plane`;
  }
  if (plane.kind === 'construction') {
    const datum = state.features.find((f) => f.id === plane.featureId);
    return `On ${datum ? `"${datum.name}"` : 'a construction plane'}`;
  }
  return 'On a planar face';
}

export function ImageParams({
  feature,
  state,
}: {
  feature: ReferenceImageFeature;
  state: AssemblerState;
}): JSX.Element {
  const edit = (patch: Partial<ReferenceImageFeature>) =>
    state.editFeatureParams(feature.id, patch as FeaturePatch);
  const present = useImageStore((s) => s.images.has(feature.imageId));
  return (
    <div className={cardStyles.params}>
      <span className={`${cardStyles.paramNote} ${cardStyles.paramsFull}`}>
        {planeText(feature, state)} · {feature.fileName} ({feature.pixelWidth} ×{' '}
        {feature.pixelHeight} px)
      </span>
      {present ? null : (
        <span className={`${cardStyles.warningMessage} ${cardStyles.paramsFull}`} role="status">
          The picture is missing from this project; the step keeps its place and size.
        </span>
      )}
      <ExpressionField
        label="Width"
        value={feature.width}
        unit="mm"
        onCommit={(v) => {
          if (v > 0) edit({ width: v });
        }}
      />
      <span className={cardStyles.paramNote}>
        Height {Math.round(imageHeight(feature) * 100) / 100} mm (follows the picture)
      </span>
      <ExpressionField
        label="Centre U"
        value={feature.center[0]}
        unit="mm"
        onCommit={(v) => edit({ center: [v, feature.center[1]] })}
      />
      <ExpressionField
        label="Centre V"
        value={feature.center[1]}
        unit="mm"
        onCommit={(v) => edit({ center: [feature.center[0], v] })}
      />
      <ExpressionField
        label="Rotation"
        value={feature.rotation}
        unit="°"
        onCommit={(v) => edit({ rotation: v })}
      />
      <ImageOpacitySlider
        feature={feature}
        state={state}
        className={cardStyles.paramsFull}
        labelClassName={cardStyles.paramLabel}
      />
      <Button
        className={`${styles.cardButton} ${cardStyles.paramsFull}`}
        variant="secondary"
        size="small"
        icon={<Ruler size={13} />}
        onClick={() => useCanvasStore.getState().startCalibration(feature.id)}
      >
        Calibrate…
      </Button>
    </div>
  );
}
