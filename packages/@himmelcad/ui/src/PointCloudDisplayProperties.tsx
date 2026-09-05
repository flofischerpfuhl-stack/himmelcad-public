import type { PointCloudColorMode, PointCloudDisplayStyle } from '@himmelcad/app';

import { Checkbox } from './Checkbox.js';
import { Select } from './Select.js';
import { Slider } from './Slider.js';
import styles from './PointCloudDisplayProperties.module.css';

export interface PointCloudDisplayPropertiesProps {
  readonly styles: readonly PointCloudDisplayStyle[];
  readonly disabled?: boolean;
  readonly onChange: (display: PointCloudDisplayStyle) => void;
}

const colorModes = [
  { value: 'rgb', label: 'RGB' },
  { value: 'intensity', label: 'Intensity' },
  { value: 'classification', label: 'Classification' },
  { value: 'elevation', label: 'Elevation' },
] as const;

/** Canonical PC-D11 editor with P9 mixed-state class visibility. */
export function PointCloudDisplayProperties({
  styles: selectedStyles,
  disabled = false,
  onChange,
}: PointCloudDisplayPropertiesProps): JSX.Element | null {
  const first = selectedStyles[0];
  if (!first) return null;
  const sharedPointSize = selectedStyles.every(
    (display) => display.pointSizePixels === first.pointSizePixels,
  );
  const sharedColorMode = selectedStyles.every((display) => display.colorMode === first.colorMode);
  const classes = [
    ...new Map(
      selectedStyles.flatMap((display) => display.classes).map((item) => [item.code, item]),
    ).values(),
  ].sort((left, right) => left.code - right.code);
  const replace = (patch: Partial<PointCloudDisplayStyle>): void =>
    onChange({ ...first, ...patch });

  return (
    <section className={styles.root} aria-label="Point cloud display">
      <div className={styles.heading}>
        <strong>Display</strong>
        <span>Point cloud</span>
      </div>
      <label className={styles.field}>
        <span>Point size</span>
        <output>{sharedPointSize ? `${first.pointSizePixels.toFixed(1)} px` : 'Mixed'}</output>
        <Slider
          aria-label="Point size"
          min={1}
          max={8}
          step={0.5}
          value={first.pointSizePixels}
          valueText={`${first.pointSizePixels.toFixed(1)} pixels`}
          disabled={disabled}
          onValueChange={(pointSizePixels) => replace({ pointSizePixels })}
        />
      </label>
      <label className={styles.field}>
        <span>Color</span>
        <Select
          aria-label="Point cloud color"
          value={sharedColorMode ? first.colorMode : ''}
          options={
            sharedColorMode
              ? colorModes
              : [{ value: '', label: 'Mixed', disabled: true }, ...colorModes]
          }
          disabled={disabled}
          onChange={(event) =>
            replace({ colorMode: event.currentTarget.value as PointCloudColorMode })
          }
        />
      </label>
      <div className={styles.classes}>
        <span className={styles.classesLabel}>Classes</span>
        {classes.map((classification) => {
          const values = selectedStyles.flatMap((display) =>
            display.classes
              .filter((item) => item.code === classification.code)
              .map((item) => item.visible),
          );
          const checked = values.length > 0 && values.every(Boolean);
          const indeterminate = values.some(Boolean) && !checked;
          return (
            <Checkbox
              key={classification.code}
              checked={checked}
              indeterminate={indeterminate}
              disabled={disabled}
              label={
                <span className={styles.classLabel}>
                  <span>{classification.name}</span>
                  <code>{classification.code}</code>
                </span>
              }
              onChange={() =>
                replace({
                  classes: first.classes.map((item) =>
                    item.code === classification.code ? { ...item, visible: !checked } : item,
                  ),
                })
              }
            />
          );
        })}
      </div>
    </section>
  );
}
