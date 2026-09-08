import type { AppJob } from '@himmelcad/app';
import { Button, NumberInput, ProgressBar, Select } from '@himmelcad/ui';
import React from 'react';

import type {
  PointcloudRasterizeParameters,
  PointcloudRasterizeResult,
  PointcloudSampleParameters,
  PointcloudSampleResult,
} from './project.js';
import styles from './PointcloudSamplingPanel.module.css';

export interface PointcloudSamplingPanelProps {
  readonly mode: 'sample' | 'rasterize';
  readonly sourceName: string | null;
  readonly sourcePoints: number | null;
  readonly activeJob: AppJob | null;
  readonly sampleResult: PointcloudSampleResult | null;
  readonly rasterizeResult: PointcloudRasterizeResult | null;
  readonly error: string | null;
  readonly onSample: (parameters: PointcloudSampleParameters) => void;
  readonly onRasterize: (parameters: PointcloudRasterizeParameters) => void;
  readonly onCancel: (jobId: string) => void;
}

const DEFAULT_SAMPLE: PointcloudSampleParameters = {
  method: 'distance',
  spacingM: 0.25,
  percentage: 10,
};

const DEFAULT_RASTERIZE: PointcloudRasterizeParameters = {
  cellSizeM: 1,
  aggregation: 'mean',
  emptyCellPolicy: { kind: 'no_data' },
};

export function PointcloudSamplingPanel({
  mode,
  sourceName,
  sourcePoints,
  activeJob,
  sampleResult,
  rasterizeResult,
  error,
  onSample,
  onRasterize,
  onCancel,
}: PointcloudSamplingPanelProps): JSX.Element {
  const [sample, setSample] = React.useState<PointcloudSampleParameters>(DEFAULT_SAMPLE);
  const [rasterize, setRasterize] =
    React.useState<PointcloudRasterizeParameters>(DEFAULT_RASTERIZE);
  const [previewed, setPreviewed] = React.useState(false);
  const running = Boolean(
    activeJob && !['completed', 'failed', 'cancelled'].includes(activeJob.state),
  );
  const sourceLabel = sourceName ?? 'Select exactly one visible point cloud.';

  return (
    <div className={styles.panel} aria-busy={running}>
      <section className={styles.section}>
        <div className={styles.heading}>Source</div>
        <div className={sourceName ? styles.source : styles.notice}>{sourceLabel}</div>
        <p className={styles.help}>
          The active viewing box and visible classification set are captured when Run starts.
        </p>
      </section>

      {mode === 'sample' ? (
        <SampleFields value={sample} disabled={running} onChange={setSample} />
      ) : (
        <RasterizeFields value={rasterize} disabled={running} onChange={setRasterize} />
      )}

      {activeJob ? (
        <section className={styles.section} aria-live="polite">
          <div className={styles.statusLine}>
            <span>{activeJob.phase}</span>
            <span>{activeJob.state === 'cancelling' ? 'Stopping…' : null}</span>
          </div>
          <ProgressBar
            value={activeJob.fraction ?? 0}
            ariaLabel={`${mode === 'sample' ? 'Sampling' : 'Rasterize'} progress`}
            indeterminate={activeJob.fraction === null}
          />
        </section>
      ) : null}

      {previewed && !sampleResult && !rasterizeResult ? (
        <section className={styles.result} aria-live="polite">
          <strong>Ready to run</strong>
          <span>
            {sourcePoints === null
              ? 'Visible source count resolves at run time'
              : `${compact(sourcePoints)} source points`}
            {' · '}exact output count is computed from the captured visible set
          </span>
        </section>
      ) : null}

      {mode === 'sample' && sampleResult ? (
        <section className={styles.result} aria-live="polite">
          <strong>Sampled cloud created</strong>
          <span>
            Sampled {compact(sampleResult.summary.sampledPoints)} of{' '}
            {compact(sampleResult.summary.scopedPoints)} points ·{' '}
            {sampleResult.summary.method === 'random'
              ? `${sampleResult.summary.percentage?.toFixed(1)} %`
              : `spacing ${sampleResult.summary.spacingM?.toFixed(2)} m`}
          </span>
          <span>SHA-256 {sampleResult.summary.selectionSha256.slice(0, 12)}</span>
        </section>
      ) : null}

      {mode === 'rasterize' && rasterizeResult ? (
        <section className={styles.result} aria-live="polite">
          <strong>
            {rasterizeResult.summary.meshEligible ? 'Height grid created' : 'Count grid created'}
          </strong>
          <span>
            Grid {rasterizeResult.summary.width.toLocaleString()} ×{' '}
            {rasterizeResult.summary.height.toLocaleString()} ·{' '}
            {formatNumber(rasterizeResult.summary.cellSizeM)} m ·{' '}
            {Math.round(rasterizeResult.summary.emptyRatio * 100)} % empty
          </span>
          <span>
            {rasterizeResult.summary.meshEligible
              ? 'Mesh source role · grid_source'
              : 'Count is density, not an elevation source'}
          </span>
        </section>
      ) : null}

      {error ? (
        <div className={styles.error} role="alert">
          {error}
        </div>
      ) : null}

      <div className={styles.actions}>
        {running && activeJob ? (
          <Button
            variant="secondary"
            disabled={!activeJob.cancellation.cancellable}
            onClick={() => onCancel(activeJob.id)}
          >
            Cancel
          </Button>
        ) : (
          <>
            <Button variant="quiet" disabled={!sourceName} onClick={() => setPreviewed(true)}>
              Preview
            </Button>
            <Button
              variant="primary"
              disabled={!sourceName}
              onClick={() => {
                setPreviewed(false);
                if (mode === 'sample') onSample(sample);
                else onRasterize(rasterize);
              }}
            >
              {mode === 'sample' ? 'Sample' : 'Rasterize'}
            </Button>
          </>
        )}
      </div>
    </div>
  );
}

function SampleFields({
  value,
  disabled,
  onChange,
}: {
  readonly value: PointcloudSampleParameters;
  readonly disabled: boolean;
  readonly onChange: (value: PointcloudSampleParameters) => void;
}): JSX.Element {
  return (
    <section className={styles.section}>
      <label className={styles.field}>
        <span>Method</span>
        <Select
          value={value.method}
          disabled={disabled}
          options={[
            { value: 'distance', label: 'Distance' },
            { value: 'grid', label: 'Grid mean' },
            { value: 'random', label: 'Random' },
          ]}
          onChange={(event) =>
            onChange({
              ...value,
              method: event.currentTarget.value as PointcloudSampleParameters['method'],
            })
          }
        />
      </label>
      {value.method === 'random' ? (
        <NumberField label="Percentage" unit="%">
          <NumberInput
            aria-label="Percentage"
            value={value.percentage}
            min={0.01}
            max={100}
            step={1}
            precision={2}
            unit="%"
            disabled={disabled}
            onValueChange={(percentage) =>
              percentage !== null && onChange({ ...value, percentage })
            }
          />
        </NumberField>
      ) : (
        <NumberField label="Spacing" unit="m">
          <NumberInput
            aria-label="Spacing"
            value={value.spacingM}
            min={0.001}
            max={10_000}
            step={0.05}
            precision={3}
            unit="m"
            disabled={disabled}
            onValueChange={(spacingM) => spacingM !== null && onChange({ ...value, spacingM })}
          />
        </NumberField>
      )}
      {value.method === 'grid' ? (
        <OriginFields value={value} disabled={disabled} onChange={onChange} />
      ) : null}
    </section>
  );
}

function RasterizeFields({
  value,
  disabled,
  onChange,
}: {
  readonly value: PointcloudRasterizeParameters;
  readonly disabled: boolean;
  readonly onChange: (value: PointcloudRasterizeParameters) => void;
}): JSX.Element {
  return (
    <section className={styles.section}>
      <label className={styles.field}>
        <span>Method</span>
        <Select
          value="height_grid"
          disabled
          options={[{ value: 'height_grid', label: 'Height grid' }]}
        />
      </label>
      <NumberField label="Cell size" unit="m">
        <NumberInput
          aria-label="Cell size"
          value={value.cellSizeM}
          min={0.01}
          max={100_000}
          step={0.1}
          precision={2}
          unit="m"
          disabled={disabled}
          onValueChange={(cellSizeM) => cellSizeM !== null && onChange({ ...value, cellSizeM })}
        />
      </NumberField>
      <OriginFields value={value} disabled={disabled} onChange={onChange} />
      <label className={styles.field}>
        <span>Aggregation</span>
        <Select
          value={value.aggregation}
          disabled={disabled}
          options={[
            { value: 'mean', label: 'Mean height' },
            { value: 'min', label: 'Minimum height' },
            { value: 'max', label: 'Maximum height' },
            { value: 'count', label: 'Point count' },
          ]}
          onChange={(event) =>
            onChange({
              ...value,
              aggregation: event.currentTarget
                .value as PointcloudRasterizeParameters['aggregation'],
            })
          }
        />
      </label>
      <label className={styles.field}>
        <span>Empty cells</span>
        <Select
          value={value.emptyCellPolicy.kind}
          disabled={disabled}
          options={[
            { value: 'no_data', label: 'NoData' },
            { value: 'fill', label: 'Fill with value' },
          ]}
          onChange={(event) =>
            onChange({
              ...value,
              emptyCellPolicy:
                event.currentTarget.value === 'fill'
                  ? { kind: 'fill', value: 0 }
                  : { kind: 'no_data' },
            })
          }
        />
      </label>
      {value.emptyCellPolicy.kind === 'fill' ? (
        <NumberField label="Empty-cell value" unit={value.aggregation === 'count' ? 'points' : 'm'}>
          <NumberInput
            aria-label="Empty-cell value"
            value={value.emptyCellPolicy.value}
            step={0.1}
            precision={3}
            unit={value.aggregation === 'count' ? 'points' : 'm'}
            disabled={disabled}
            onValueChange={(fill) =>
              fill !== null &&
              onChange({ ...value, emptyCellPolicy: { kind: 'fill', value: fill } })
            }
          />
        </NumberField>
      ) : null}
    </section>
  );
}

function OriginFields<Value extends { readonly originX?: number; readonly originY?: number }>({
  value,
  disabled,
  onChange,
}: {
  readonly value: Value;
  readonly disabled: boolean;
  readonly onChange: (value: Value) => void;
}): JSX.Element {
  return (
    <>
      <NumberField label="Grid origin X" unit="m · optional">
        <div className={styles.originControl}>
          <NumberInput
            aria-label="Grid origin X"
            value={value.originX ?? 0}
            step={1}
            precision={3}
            unit="m"
            disabled={disabled || value.originX === undefined}
            onValueChange={(originX) => originX !== null && onChange({ ...value, originX })}
          />
          <Button
            variant="quiet"
            size="small"
            disabled={disabled}
            onClick={() => {
              if (value.originX === undefined) onChange({ ...value, originX: 0 });
              else {
                const next: Value = { ...value };
                Reflect.deleteProperty(next, 'originX');
                onChange(next);
              }
            }}
          >
            {value.originX === undefined ? 'Set' : 'Auto'}
          </Button>
        </div>
      </NumberField>
      <NumberField label="Grid origin Y" unit="m · optional">
        <div className={styles.originControl}>
          <NumberInput
            aria-label="Grid origin Y"
            value={value.originY ?? 0}
            step={1}
            precision={3}
            unit="m"
            disabled={disabled || value.originY === undefined}
            onValueChange={(originY) => originY !== null && onChange({ ...value, originY })}
          />
          <Button
            variant="quiet"
            size="small"
            disabled={disabled}
            onClick={() => {
              if (value.originY === undefined) onChange({ ...value, originY: 0 });
              else {
                const next: Value = { ...value };
                Reflect.deleteProperty(next, 'originY');
                onChange(next);
              }
            }}
          >
            {value.originY === undefined ? 'Set' : 'Auto'}
          </Button>
        </div>
      </NumberField>
    </>
  );
}

function NumberField({
  label,
  unit,
  children,
}: {
  readonly label: string;
  readonly unit: string;
  readonly children: React.ReactNode;
}): JSX.Element {
  return (
    <label className={styles.parameter}>
      <span>{label}</span>
      <span className={styles.unit}>{unit}</span>
      {children}
    </label>
  );
}

function compact(points: number): string {
  if (points >= 1_000_000) return `${(points / 1_000_000).toFixed(1)} M`;
  if (points >= 1_000) return `${(points / 1_000).toFixed(1)} k`;
  return points.toLocaleString();
}

function formatNumber(value: number): string {
  return Number.isInteger(value) ? value.toFixed(0) : value.toFixed(2);
}
