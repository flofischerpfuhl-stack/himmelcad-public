import type { AppJob } from '@himmelcad/app';
import { Button, NumberInput, ProgressBar, Select } from '@himmelcad/ui';
import React from 'react';

import type {
  GroundExtractionParameters,
  GroundExtractionResult,
  GroundPreviewResult,
} from './project.js';
import styles from './GroundExtractionPanel.module.css';

type GroundPreset = 'flat' | 'rolling' | 'steep';

const PRESETS: Record<GroundPreset, GroundExtractionParameters> = {
  flat: { cellSizeM: 1, slope: 0.1, maxWindowM: 12, initialDistanceM: 0.35 },
  rolling: { cellSizeM: 1, slope: 0.15, maxWindowM: 18, initialDistanceM: 0.5 },
  steep: { cellSizeM: 1.5, slope: 0.35, maxWindowM: 24, initialDistanceM: 0.8 },
};

export interface GroundExtractionPanelProps {
  readonly sourceName: string | null;
  readonly activeJob: AppJob | null;
  readonly preview: GroundPreviewResult | null;
  readonly result: GroundExtractionResult | null;
  readonly error: string | null;
  readonly onPreview: (parameters: GroundExtractionParameters) => void;
  readonly onExtract: (parameters: GroundExtractionParameters) => void;
  readonly onCancel: (jobId: string) => void;
  readonly onCreateSurface: (entityId: string) => void;
}

export function GroundExtractionPanel({
  sourceName,
  activeJob,
  preview,
  result,
  error,
  onPreview,
  onExtract,
  onCancel,
  onCreateSurface,
}: GroundExtractionPanelProps): JSX.Element {
  const [preset, setPreset] = React.useState<GroundPreset>('rolling');
  const [parameters, setParameters] = React.useState<GroundExtractionParameters>(PRESETS.rolling);
  const running = Boolean(activeJob && !['completed', 'failed', 'cancelled'].includes(activeJob.state));
  const setParameter = <Key extends keyof GroundExtractionParameters>(
    key: Key,
    value: GroundExtractionParameters[Key] | null,
  ): void => {
    if (value === null) return;
    setParameters((current) => ({ ...current, [key]: value }));
  };

  return (
    <div className={styles.panel} aria-busy={running}>
      <section className={styles.section}>
        <div className={styles.heading}>Source</div>
        <div className={sourceName ? styles.source : styles.notice}>
          {sourceName ?? 'Select exactly one visible point cloud.'}
        </div>
        <p className={styles.help}>
          The active viewing box and visible classification set are captured when the job starts.
        </p>
      </section>

      <section className={styles.section}>
        <label className={styles.field}>
          <span>Terrain type</span>
          <Select
            value={preset}
            disabled={running}
            options={[
              { value: 'flat', label: 'Flat' },
              { value: 'rolling', label: 'Rolling' },
              { value: 'steep', label: 'Steep' },
            ]}
            onChange={(event) => {
              const next = event.currentTarget.value as GroundPreset;
              setPreset(next);
              setParameters(PRESETS[next]);
            }}
          />
        </label>
        <ParameterField label="Cell size" unit="m">
          <NumberInput
            aria-label="Cell size"
            value={parameters.cellSizeM}
            min={0.05}
            max={100}
            step={0.1}
            precision={2}
            unit="m"
            disabled={running}
            onValueChange={(value) => setParameter('cellSizeM', value)}
          />
        </ParameterField>
        <ParameterField label="Slope" unit="%">
          <NumberInput
            aria-label="Slope"
            value={parameters.slope * 100}
            min={0.1}
            max={100}
            step={1}
            precision={1}
            unit="%"
            disabled={running}
            onValueChange={(value) => setParameter('slope', value === null ? null : value / 100)}
          />
        </ParameterField>
        <ParameterField label="Maximum window" unit="m">
          <NumberInput
            aria-label="Maximum window"
            value={parameters.maxWindowM}
            min={0.1}
            max={1_000}
            step={1}
            precision={1}
            unit="m"
            disabled={running}
            onValueChange={(value) => setParameter('maxWindowM', value)}
          />
        </ParameterField>
        <ParameterField label="Initial threshold" unit="m">
          <NumberInput
            aria-label="Initial threshold"
            value={parameters.initialDistanceM}
            min={0}
            max={100}
            step={0.05}
            precision={2}
            unit="m"
            disabled={running}
            onValueChange={(value) => setParameter('initialDistanceM', value)}
          />
        </ParameterField>
      </section>

      {activeJob ? (
        <section className={styles.section} aria-live="polite">
          <div className={styles.statusLine}>
            <span>{activeJob.phase}</span>
            <span>{activeJob.state === 'cancelling' ? 'Stopping…' : null}</span>
          </div>
          <ProgressBar
            value={activeJob.fraction ?? 0}
            ariaLabel="Ground extraction progress"
            indeterminate={activeJob.fraction === null}
          />
        </section>
      ) : null}

      {preview ? (
        <section className={styles.result} aria-live="polite">
          <strong>Preview ready</strong>
          <span>
            {preview.preview.groundPoints.toLocaleString()} of{' '}
            {preview.preview.sampledPoints.toLocaleString()} sampled points ·{' '}
            {(preview.preview.ratio * 100).toFixed(1)}% ground
          </span>
          <div className={styles.legend} aria-label="Preview classification legend">
            <span><i data-class="ground" />Ground</span>
            <span><i data-class="non-ground" />Non-ground</span>
            <span><i data-class="unknown" />Unknown / outside scope</span>
          </div>
        </section>
      ) : null}

      {result ? (
        <section className={styles.result} aria-live="polite">
          <strong>Ground cloud created</strong>
          <span>
            Ground points {compactPoints(result.summary.groundPoints)} ({Math.round(result.summary.ratio * 100)} %) · residual σ{' '}
            {result.summary.residuals.standardDeviationM.toFixed(2)} m
          </span>
          <span>
            Deterministic class hash <code>{result.summary.membershipSha256.slice(0, 12)}</code>
          </span>
          <p className={styles.help}>This result is a point cloud, not an inferred DGM.</p>
          <Button variant="secondary" onClick={() => onCreateSurface(result.groundCloud.entityId)}>
            Create surface…
          </Button>
        </section>
      ) : null}

      {error ? <div className={styles.error} role="alert">{error}</div> : null}

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
            <Button
              variant="quiet"
              disabled={!sourceName}
              onClick={() => onPreview(parameters)}
            >
              Preview
            </Button>
            <Button variant="primary" disabled={!sourceName} onClick={() => onExtract(parameters)}>
              Extract ground
            </Button>
          </>
        )}
      </div>
    </div>
  );
}

function compactPoints(points: number): string {
  if (points >= 1_000_000) return `${(points / 1_000_000).toFixed(1)} M`;
  if (points >= 1_000) return `${(points / 1_000).toFixed(1)} k`;
  return points.toLocaleString();
}

function ParameterField({
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
