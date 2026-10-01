/**
 * Opacity slider of a reference image (History card and the selected
 * Items row, Shapr3D "image items with opacity slider"): the viewport
 * previews the value while it is dragged; releasing it (pointer, key or
 * blur) commits one `editFeatureParams` call (one undo step).
 */
import { useState } from 'react';

import { Slider } from '@himmelcad/ui';

import type { AssemblerState, FeaturePatch } from '../../../foundation/commands/store.js';
import { useCanvasStore } from '../canvasStore.js';
import { clampOpacity, type ReferenceImageFeature } from '../referenceImage.js';
import styles from './CanvasUi.module.css';

export function ImageOpacitySlider({
  feature,
  state,
  className,
  labelClassName,
}: {
  feature: ReferenceImageFeature;
  state: Pick<AssemblerState, 'editFeatureParams'>;
  className?: string | undefined;
  labelClassName?: string | undefined;
}): JSX.Element {
  const [draft, setDraft] = useState<number | null>(null);
  const percent = Math.round((draft ?? feature.opacity) * 100);
  const commit = () => {
    if (draft === null) return;
    useCanvasStore.getState().setOpacityPreview(null);
    setDraft(null);
    if (Math.abs(draft - feature.opacity) > 1e-9) {
      state.editFeatureParams(feature.id, { opacity: clampOpacity(draft) } as FeaturePatch);
    }
  };
  return (
    <label className={`${styles.slider} ${className ?? ''}`}>
      <span className={labelClassName}>Opacity {percent} %</span>
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
        onPointerUp={commit}
        onKeyUp={commit}
        onBlur={commit}
        onClick={(event) => event.stopPropagation()}
        onPointerDown={(event) => event.stopPropagation()}
      />
    </label>
  );
}
