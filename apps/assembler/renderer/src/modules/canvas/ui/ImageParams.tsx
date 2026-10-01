/**
 * History card of a reference image: its plane and picture, size,
 * position and rotation (expression fields), the opacity slider (previewed
 * while dragged, one undo step on release) and Calibrate…. Each commit is
 * one `editFeatureParams` call (one undo step).
 */
import { Ruler } from 'lucide-react';
import { useState } from 'react';

import { Button, Slider } from '@himmelcad/ui';

import type { AssemblerState, FeaturePatch } from '../../../foundation/commands/store.js';
import { ExpressionField } from '../../../platform/widgets/ExpressionField.js';
import cardStyles from '../../../platform/widgets/HistoryCard.module.css';
import { useCanvasStore } from '../canvasStore.js';
import { useImageStore } from '../imageStore.js';
import { clampOpacity, imageHeight, type ReferenceImageFeature } from '../referenceImage.js';
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
  const [draft, setDraft] = useState<number | null>(null);
  const percent = Math.round((draft ?? feature.opacity) * 100);
  const commitOpacity = () => {
    if (draft === null) return;
    useCanvasStore.getState().setOpacityPreview(null);
    setDraft(null);
    if (Math.abs(draft - feature.opacity) > 1e-9) edit({ opacity: clampOpacity(draft) });
  };
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
      <label className={`${styles.slider} ${cardStyles.paramsFull}`}>
        <span className={cardStyles.paramLabel}>Opacity {percent} %</span>
        <Slider
          min={5}
          max={100}
          step={5}
          value={percent}
          valueText={`${percent} %`}
          aria-label={`${feature.name} opacity`}
          onValueChange={(next) => {
            const opacity = clampOpacity(next / 100);
            setDraft(opacity);
            useCanvasStore.getState().setOpacityPreview({ featureId: feature.id, opacity });
          }}
          onPointerUp={commitOpacity}
          onKeyUp={commitOpacity}
          onBlur={commitOpacity}
        />
      </label>
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
