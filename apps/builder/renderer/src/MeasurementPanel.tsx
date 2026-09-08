import type { MeasurementToolSnapshot } from '@himmelcad/app';
import { measurementAnchorPosition, measurementLabel, measurementValue } from '@himmelcad/app';
import { Button, MeasurementLiveReadout } from '@himmelcad/ui';

import type { BuilderMeasurementSummary } from './project.js';
import styles from './MeasurementPanel.module.css';

const DISPLAY = { lengthUnit: 'm' as const, maximumDecimals: 6 };

export interface MeasurementPanelProps {
  readonly tool: MeasurementToolSnapshot;
  readonly measurements: readonly BuilderMeasurementSummary[];
  readonly selectedId: string | null;
  readonly pixelsPerMetre: number;
  readonly onMetricChange: (metric: 'horizontal' | 'spatial') => void;
  readonly onSelect: (entityId: string) => void;
  readonly onDelete: (entityId: string) => void;
}

export function MeasurementPanel({
  tool,
  measurements,
  selectedId,
  pixelsPerMetre,
  onMetricChange,
  onSelect,
  onDelete,
}: MeasurementPanelProps): JSX.Element {
  const prompt = tool.armed
    ? tool.anchors.length === 0
      ? 'Pick or type start point'
      : 'Pick or type next point'
    : 'Choose Measure point, distance, or height difference.';
  return (
    <div className={styles.root}>
      {tool.kind === 'distance' ? (
        <fieldset className={styles.metric}>
          <legend>Distance metric</legend>
          {(['spatial', 'horizontal'] as const).map((metric) => (
            <label key={metric}>
              <input
                type="radio"
                name="measurement-metric"
                checked={tool.metric === metric}
                onChange={() => onMetricChange(metric)}
              />
              {metric === 'spatial' ? '3D distance' : '2D distance'}
            </label>
          ))}
        </fieldset>
      ) : null}
      <MeasurementLiveReadout
        prompt={prompt}
        value={measurementLabel(tool.liveValue, DISPLAY, pixelsPerMetre, 6)}
        exact
      />
      <div className={styles.binding}>
        <span>Input</span>
        <strong>
          {tool.preview?.binding === 'attached' ? 'Attached to source' : 'Fixed coordinate'}
        </strong>
      </div>
      <div className={styles.listHeader}>
        <span>Measurements</span>
        <span>{measurements.length}</span>
      </div>
      <div className={styles.list} role="list" aria-label="Saved measurements">
        {measurements.length === 0 ? (
          <div className={styles.empty}>No saved measurements</div>
        ) : (
          measurements.map((item) => {
            const value = measurementValue(
              item.measurement.measurementKind,
              item.measurement.metric,
              item.measurement.anchors,
            );
            const selected = selectedId === item.entityId;
            return (
              <div
                key={item.entityId}
                className={`${styles.row} ${selected ? styles.selected : ''}`}
                role="listitem"
              >
                <button
                  type="button"
                  className={styles.rowMain}
                  onClick={() => onSelect(item.entityId)}
                  aria-pressed={selected}
                >
                  <span className={styles.name} title={item.name}>
                    {item.name}
                  </span>
                  <span className={styles.rowValue}>
                    {measurementLabel(value, DISPLAY, pixelsPerMetre, 6)}
                  </span>
                </button>
                <span className={styles.eye} title="Visible" aria-label="Visible">
                  ●
                </span>
                <Button
                  size="small"
                  variant="quiet"
                  aria-label={`Delete ${item.name}`}
                  onClick={() => onDelete(item.entityId)}
                >
                  Delete
                </Button>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}

export function MeasurementProperties({
  measurement,
  pixelsPerMetre,
}: {
  readonly measurement: BuilderMeasurementSummary;
  readonly pixelsPerMetre: number;
}): JSX.Element {
  const value = measurementValue(
    measurement.measurement.measurementKind,
    measurement.measurement.metric,
    measurement.measurement.anchors,
  );
  return (
    <section className={styles.properties} aria-label="Measurement properties">
      <h3>Measurement</h3>
      <Property label="Metric" value={metricLabel(measurement)} />
      <Property label="Value" value={measurementLabel(value, DISPLAY, pixelsPerMetre, 6)} mono />
      <Property label="Layer" value={measurement.measurement.layerId} />
      {measurement.measurement.anchors.map((anchor, index) => {
        const position = measurementAnchorPosition(anchor);
        return (
          <div className={styles.anchorBlock} key={`${measurement.entityId}:${index}`}>
            <strong>Anchor {index + 1}</strong>
            <Property label="Binding" value={anchor.binding === 'fixed' ? 'Fixed' : 'Attached'} />
            <Property
              label="XYZ"
              value={`${position.x}, ${position.y}, ${position.z === null ? '—' : position.z}`}
              mono
            />
            {anchor.binding === 'attached' ? (
              <Property
                label="Source"
                value={`${anchor.entityId} · ${anchor.primitiveAddress}`}
                mono
              />
            ) : null}
          </div>
        );
      })}
    </section>
  );
}

function Property({
  label,
  value,
  mono = false,
}: {
  readonly label: string;
  readonly value: string;
  readonly mono?: boolean;
}): JSX.Element {
  return (
    <div className={styles.property}>
      <span>{label}</span>
      <output className={mono ? styles.mono : undefined}>{value}</output>
    </div>
  );
}

function metricLabel(item: BuilderMeasurementSummary): string {
  if (item.measurement.measurementKind === 'point') return 'Point';
  if (item.measurement.measurementKind === 'heightDifference')
    return 'Height difference · project Z';
  return item.measurement.metric === 'horizontal' ? '2D distance · Plan XY' : '3D distance';
}
