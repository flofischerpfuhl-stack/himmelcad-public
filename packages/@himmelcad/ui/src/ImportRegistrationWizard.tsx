import type {
  ImportRegistrationState,
  RegistrationPoint,
  RegistrationPointPair,
  RegistrationRecipe,
} from '@himmelcad/app';
import { RotateCcw, Target, X } from 'lucide-react';
import { useMemo, useState, type ReactNode } from 'react';

import styles from './ImportRegistrationWizard.module.css';
import { Select } from './Select.js';

type RegistrationMethodId =
  | 'sourceCoordinates'
  | 'originAndProjectNorth'
  | 'manualPlacement'
  | 'pointPairs'
  | 'icp';

export interface ImportRegistrationWizardProps {
  readonly sourceLabel: string;
  readonly projectLabel: string;
  readonly sourceView?: ReactNode;
  readonly projectView?: ReactNode;
  readonly state?: ImportRegistrationState | null;
  readonly pointPairs?: readonly RegistrationPointPair[];
  readonly busy?: boolean;
  readonly onStage: (recipe: RegistrationRecipe) => void;
  readonly onRequestPick?: (side: 'source' | 'target') => void;
  readonly onPreviewPointPairs?: () => void;
  readonly onPreviewIcp?: () => void;
  readonly onCommit?: () => void;
  readonly onCancel: () => void;
}

/** Shared Builder/PhotoLab registration surface; product hosts supply both live views. */
export function ImportRegistrationWizard({
  sourceLabel,
  projectLabel,
  sourceView,
  projectView,
  state,
  pointPairs = [],
  busy = false,
  onStage,
  onRequestPick,
  onPreviewPointPairs,
  onPreviewIcp,
  onCommit,
  onCancel,
}: ImportRegistrationWizardProps): JSX.Element {
  const [method, setMethod] = useState<RegistrationMethodId>('sourceCoordinates');
  const [sourceOrigin, setSourceOrigin] = useState<RegistrationPoint>(zeroPoint);
  const [targetOrigin, setTargetOrigin] = useState<RegistrationPoint>(zeroPoint);
  const [northDegrees, setNorthDegrees] = useState(0);
  const [manual, setManual] = useState({
    tx: 0,
    ty: 0,
    tz: 0,
    rxRadians: 0,
    ryRadians: 0,
    rzRadians: 0,
    scale: 1,
  });
  const expectedPick: 'source' | 'target' = pointPairs.length % 2 === 0 ? 'source' : 'target';
  const recipe = useMemo<RegistrationRecipe>(() => {
    const recipeId = `builder-${method}`;
    const common = { schemaVersion: 1 as const, recipeId, label: methodLabel(method) };
    switch (method) {
      case 'sourceCoordinates':
        return { ...common, method: { kind: 'sourceCoordinates' } };
      case 'originAndProjectNorth':
        return {
          ...common,
          method: {
            kind: 'originAndProjectNorth',
            sourceOrigin,
            targetOrigin,
            projectNorthDegrees: northDegrees,
            scale: 1,
          },
        };
      case 'manualPlacement':
        return { ...common, method: { kind: 'manualPlacement', transform: manual } };
      case 'pointPairs':
        return {
          ...common,
          method: {
            kind: 'pointPairs',
            model: 'similarity3d',
            robust: {
              maximumIterations: 20,
              huberDeltaMeters: 0.05,
              convergenceEpsilon: 1e-10,
            },
            offerIcpRefinement: true,
          },
        };
      case 'icp':
        return {
          ...common,
          method: {
            kind: 'icp',
            mode: 'pointToPlane',
            options: defaultIcpOptions,
          },
        };
    }
  }, [manual, method, northDegrees, sourceOrigin, targetOrigin]);

  const staged = state !== undefined && state !== null;
  const ready = state?.phase === 'readyToCommit' && state.preview?.accepted === true;
  return (
    <section className={styles.root} aria-label="Import registration">
      <header className={styles.header} data-task-drag-handle>
        <div>
          <span>Import registration</span>
          <small>Preview before canonical commit</small>
        </div>
        <button type="button" className={styles.iconButton} onClick={onCancel} aria-label="Close">
          <X size={16} />
        </button>
      </header>

      <div className={styles.toolbar}>
        <label>
          <span>Placement method</span>
          <Select
            value={method}
            disabled={staged || busy}
            options={methodOptions}
            onChange={(event) => setMethod(event.currentTarget.value as RegistrationMethodId)}
          />
        </label>
        <p>{methodDescription(method)}</p>
      </div>

      <div className={styles.views}>
        <RegistrationView
          title="Importing"
          subtitle={sourceLabel}
          active={staged && expectedPick === 'source' && method === 'pointPairs'}
          {...(onRequestPick ? { onPick: () => onRequestPick('source') } : {})}
        >
          {sourceView}
        </RegistrationView>
        <RegistrationView
          title="Current project"
          subtitle={projectLabel}
          active={staged && expectedPick === 'target' && method === 'pointPairs'}
          {...(onRequestPick ? { onPick: () => onRequestPick('target') } : {})}
        >
          {projectView}
        </RegistrationView>
      </div>

      <div className={styles.parameters}>
        {method === 'originAndProjectNorth' ? (
          <>
            <PointEditor label="Source origin" value={sourceOrigin} onChange={setSourceOrigin} />
            <PointEditor label="Project origin" value={targetOrigin} onChange={setTargetOrigin} />
            <NumberField
              label="Project north (° clockwise)"
              value={northDegrees}
              onChange={setNorthDegrees}
            />
          </>
        ) : null}
        {method === 'manualPlacement' ? (
          <>
            <PointEditor
              label="Translation"
              value={{ x: manual.tx, y: manual.ty, z: manual.tz }}
              onChange={(point) =>
                setManual((value) => ({ ...value, tx: point.x, ty: point.y, tz: point.z }))
              }
            />
            <PointEditor
              label="Rotation (radians)"
              value={{ x: manual.rxRadians, y: manual.ryRadians, z: manual.rzRadians }}
              onChange={(point) =>
                setManual((value) => ({
                  ...value,
                  rxRadians: point.x,
                  ryRadians: point.y,
                  rzRadians: point.z,
                }))
              }
            />
            <NumberField
              label="Uniform scale"
              value={manual.scale}
              minimum={Number.EPSILON}
              onChange={(scale) => setManual((value) => ({ ...value, scale }))}
            />
          </>
        ) : null}
        {method === 'pointPairs' ? (
          <div className={styles.pairStatus}>
            <Target size={16} />
            <span>
              {pointPairs.length} completed pairs · next: {expectedPick}
            </span>
            <button
              type="button"
              disabled={!staged || pointPairs.length < 3 || busy || !onPreviewPointPairs}
              onClick={onPreviewPointPairs}
            >
              Fit preview
            </button>
            <button
              type="button"
              disabled={!state?.preview?.accepted || busy || !onPreviewIcp}
              onClick={onPreviewIcp}
            >
              Refine with ICP
            </button>
          </div>
        ) : null}
        {method === 'icp' ? (
          <div className={styles.pairStatus}>
            <RotateCcw size={16} />
            <span>Use bounded prepared surface samples; coarse placement remains editable.</span>
            <button
              type="button"
              disabled={!staged || busy || !onPreviewIcp}
              onClick={onPreviewIcp}
            >
              Run ICP preview
            </button>
          </div>
        ) : null}
      </div>

      {state?.preview ? <PreviewDiagnostics state={state} /> : null}
      <footer className={styles.footer}>
        <span>{phaseLabel(state?.phase)}</span>
        <div>
          <button type="button" className={styles.secondary} onClick={onCancel}>
            Cancel
          </button>
          {!staged ? (
            <button type="button" disabled={busy} onClick={() => onStage(recipe)}>
              Stage import
            </button>
          ) : (
            <button type="button" disabled={!ready || busy} onClick={onCommit}>
              Commit registered import
            </button>
          )}
        </div>
      </footer>
    </section>
  );
}

function RegistrationView({
  title,
  subtitle,
  active,
  onPick,
  children,
}: {
  readonly title: string;
  readonly subtitle: string;
  readonly active: boolean;
  readonly onPick?: () => void;
  readonly children?: ReactNode;
}): JSX.Element {
  return (
    <div className={styles.view} data-active={active ? 'true' : 'false'}>
      <header>
        <div>
          <strong>{title}</strong>
          <small>{subtitle}</small>
        </div>
        {onPick ? (
          <button type="button" onClick={onPick}>
            Pick here
          </button>
        ) : null}
      </header>
      <div className={styles.viewport}>{children ?? <span>Live product viewport</span>}</div>
    </div>
  );
}

function PointEditor({
  label,
  value,
  onChange,
}: {
  readonly label: string;
  readonly value: RegistrationPoint;
  readonly onChange: (value: RegistrationPoint) => void;
}): JSX.Element {
  return (
    <fieldset className={styles.pointEditor}>
      <legend>{label}</legend>
      {(['x', 'y', 'z'] as const).map((axis) => (
        <NumberField
          key={axis}
          label={axis.toUpperCase()}
          value={value[axis]}
          onChange={(next) => onChange({ ...value, [axis]: next })}
        />
      ))}
    </fieldset>
  );
}

function NumberField({
  label,
  value,
  minimum,
  onChange,
}: {
  readonly label: string;
  readonly value: number;
  readonly minimum?: number;
  readonly onChange: (value: number) => void;
}): JSX.Element {
  return (
    <label className={styles.numberField}>
      <span>{label}</span>
      <input
        type="number"
        step="any"
        min={minimum}
        value={value}
        onChange={(event) => {
          const next = Number(event.currentTarget.value);
          if (Number.isFinite(next) && (minimum === undefined || next >= minimum)) onChange(next);
        }}
      />
    </label>
  );
}

function PreviewDiagnostics({ state }: { readonly state: ImportRegistrationState }): JSX.Element {
  const preview = state.preview!;
  return (
    <div className={styles.diagnostics} data-accepted={preview.accepted ? 'true' : 'false'}>
      <strong>{preview.accepted ? 'Preview accepted' : 'Review required'}</strong>
      <span>RMS {preview.residuals.rmsSpatialMeters.toFixed(4)} m</span>
      <span>Overlap {(preview.overlapRatio * 100).toFixed(1)}%</span>
      <span>{preview.iterations} iterations</span>
      {preview.warnings.map((warning) => (
        <small key={warning}>{warning}</small>
      ))}
    </div>
  );
}

function methodLabel(method: RegistrationMethodId): string {
  return methodOptions.find((option) => option.value === method)?.label ?? method;
}

function methodDescription(method: RegistrationMethodId): string {
  switch (method) {
    case 'sourceCoordinates':
      return 'Keep source coordinates or use the already frozen CRS operation.';
    case 'originAndProjectNorth':
      return 'Place BIM/local geometry from an explicit origin and project-north bearing.';
    case 'manualPlacement':
      return 'Set a coarse translation, rotation and optional uniform scale.';
    case 'pointPairs':
      return 'Pick fresh alternating source/project pairs. Saved recipes never retain old picks.';
    case 'icp':
      return 'Refine a coarse placement from bounded point or surface samples; ICP is optional.';
  }
}

function phaseLabel(phase: ImportRegistrationState['phase'] | undefined): string {
  if (!phase) return 'Choose a method before staging';
  return phase.replace(/([A-Z])/g, ' $1').toLowerCase();
}

const zeroPoint: RegistrationPoint = { x: 0, y: 0, z: 0 };
const defaultIcpOptions = {
  maximumIterations: 30,
  maximumCorrespondenceDistance: 1,
  convergenceTranslationMeters: 0.0001,
  convergenceRotationRadians: 0.00001,
  minimumOverlapRatio: 0.2,
  huberDeltaMeters: 0.05,
} as const;
const methodOptions = [
  { value: 'sourceCoordinates', label: 'Source coordinates / CRS' },
  { value: 'originAndProjectNorth', label: 'Origin + project north' },
  { value: 'manualPlacement', label: 'Manual placement' },
  { value: 'pointPairs', label: 'Point pairs' },
  { value: 'icp', label: 'ICP refinement' },
] as const;
