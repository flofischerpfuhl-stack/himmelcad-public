import type {
  ImportRegistrationState,
  RegistrationPoint,
  RegistrationPointPair,
  RegistrationRecipe,
} from '@himmelcad/app';
import { RotateCcw, Target } from 'lucide-react';
import { useEffect, useMemo, useState, type ReactNode } from 'react';

import {
  ChatBubble,
  ChatCard,
  ChatChoices,
  ChatFooter,
  ChatFooterSpacer,
  ImportChatRoot,
  ImportChatStream,
  Metric,
  Metrics,
  ProgressBar,
} from './ImportChat.js';
import styles from './ImportRegistrationWizard.module.css';
import {
  importRegistrationProfile,
  type ImportRegistrationFormatContext,
  type RegistrationMethodId,
} from './importRegistrationProfile.js';

export interface ImportRegistrationWizardProps {
  readonly sourceLabel: string;
  readonly projectLabel: string;
  readonly format?: ImportRegistrationFormatContext | null;
  readonly probeError?: string | null;
  readonly sourceView?: ReactNode;
  readonly projectView?: ReactNode;
  readonly state?: ImportRegistrationState | null;
  readonly pointPairs?: readonly RegistrationPointPair[];
  readonly nextPickSide?: 'source' | 'target';
  readonly sourcePickReady?: boolean;
  readonly targetPickReady?: boolean;
  readonly busy?: boolean;
  readonly onStage: (recipe: RegistrationRecipe) => void;
  readonly onRequestPick?: (side: 'source' | 'target') => void;
  readonly onPreviewPointPairs?: () => void;
  readonly onPreviewIcp?: () => void;
  readonly onCommit?: () => void;
  readonly onCancel: () => void;
}

/** Shared chat-led import registration; product hosts supply both live views. */
export function ImportRegistrationWizard({
  sourceLabel,
  projectLabel,
  format = null,
  probeError = null,
  sourceView,
  projectView,
  state,
  pointPairs = [],
  nextPickSide = 'source',
  sourcePickReady = false,
  targetPickReady = false,
  busy = false,
  onStage,
  onRequestPick,
  onPreviewPointPairs,
  onPreviewIcp,
  onCommit,
  onCancel,
}: ImportRegistrationWizardProps): JSX.Element {
  const profile = useMemo(
    () => importRegistrationProfile(format?.formatId ?? 'hcad.generic-3d@1'),
    [format?.formatId],
  );
  const [method, setMethod] = useState<RegistrationMethodId>(profile.recommendedMethod);
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

  const staged = state !== undefined && state !== null;
  useEffect(() => {
    if (!staged) setMethod(profile.recommendedMethod);
  }, [profile.recommendedMethod, staged]);

  const recipe = useMemo<RegistrationRecipe>(() => {
    const common = {
      schemaVersion: 1 as const,
      recipeId: `import-${profile.family}-${method}`,
      label: methodLabel(method),
    };
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
            model: 'similarity3D',
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
  }, [manual, method, northDegrees, profile.family, sourceOrigin, targetOrigin]);

  const ready = state?.phase === 'readyToCommit' && state.preview?.accepted === true;
  const scrollKey = [
    format?.formatId ?? 'probing',
    method,
    state?.phase ?? 'choose',
    pointPairs.length,
    nextPickSide,
    busy,
  ].join(':');

  return (
    <ImportChatRoot
      title="Import dataset"
      closeLabel="Close import"
      onClose={onCancel}
      busy={busy}
      layout="wide"
      footer={
        <ChatFooter>
          <span className={styles.phase}>{phaseLabel(state?.phase)}</span>
          <ChatFooterSpacer />
          <button type="button" className={styles.secondary} onClick={onCancel}>
            Cancel
          </button>
          {!staged ? (
            <button
              type="button"
              disabled={busy || !format || Boolean(probeError)}
              onClick={() => onStage(recipe)}
            >
              Stage import
            </button>
          ) : (
            <button type="button" disabled={!ready || busy} onClick={onCommit}>
              Commit registered import
            </button>
          )}
        </ChatFooter>
      }
    >
      <ImportChatStream scrollKey={scrollKey}>
        <ChatBubble title="Source selected" detail={sourceLabel}>
          I will identify the canonical provider first, then keep the import temporary until you
          review its placement.
        </ChatBubble>

        {probeError ? (
          <ChatBubble tone="error" title="Format detection failed" detail={probeError}>
            The source has not been staged and the project is unchanged.
          </ChatBubble>
        ) : format ? (
          <ChatCard title="Detected format">
            <Metrics>
              <Metric label="Dataset" value={profile.label} />
              <Metric label="Provider" value={format.displayName} />
              <Metric label="Confidence" value={`${format.confidence}%`} />
            </Metrics>
            <p className={styles.summary}>{profile.summary}</p>
            <ul className={styles.capabilities}>
              {profile.specialCapabilities.map((capability) => (
                <li key={capability}>{capability}</li>
              ))}
            </ul>
          </ChatCard>
        ) : (
          <ChatBubble title="Detecting format">
            <ProgressBar value={0} indeterminate indeterminateLabel="Probing…" />
          </ChatBubble>
        )}

        {format ? (
          <>
            <ChatBubble title="How should the dataset be placed?">
              Only methods meaningful for {profile.label.toLowerCase()} are offered. No CRS, unit or
              scale correction happens silently.
            </ChatBubble>
            <ChatChoices
              options={profile.methods.map((candidate) => ({
                id: candidate,
                label: methodLabel(candidate),
                primary: candidate === profile.recommendedMethod,
              }))}
              resolvedId={method}
              lockResolved={staged}
              disabled={busy}
              onSelect={(id) => setMethod(id as RegistrationMethodId)}
            />
            <ChatBubble role="user">{methodLabel(method)}</ChatBubble>
            <ChatBubble detail={methodDescription(method)}>
              {method === profile.recommendedMethod
                ? 'Recommended for this format.'
                : 'Explicit alternative selected.'}
            </ChatBubble>
          </>
        ) : null}

        {method === 'originAndProjectNorth' && !staged ? (
          <ChatCard title="Origin and project north">
            <div className={styles.parameters}>
              <PointEditor label="Source origin" value={sourceOrigin} onChange={setSourceOrigin} />
              <PointEditor label="Project origin" value={targetOrigin} onChange={setTargetOrigin} />
              <NumberField
                label="Project north (° clockwise)"
                value={northDegrees}
                onChange={setNorthDegrees}
              />
            </div>
          </ChatCard>
        ) : null}

        {method === 'manualPlacement' && !staged ? (
          <ChatCard title="Coarse placement">
            <div className={styles.parameters}>
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
            </div>
          </ChatCard>
        ) : null}

        {format && !staged ? (
          <ChatBubble tone="warn" title="Ready to stage">
            Staging may preprocess large data, but it does not mutate the project. Point picks are
            deliberately collected only after the immutable preview is available.
          </ChatBubble>
        ) : null}

        {state ? (
          <ChatBubble tone="ok" title="Import staged">
            {state.sourceEntityCount} source{' '}
            {state.sourceEntityCount === 1 ? 'entity is' : 'entities are'} ready in a temporary
            registration session.
          </ChatBubble>
        ) : null}

        {state && method === 'pointPairs' ? (
          <>
            <ChatBubble
              tone={pointPairs.length >= 3 ? 'ok' : 'default'}
              title={
                nextPickSide === 'source'
                  ? `Pick source point ${pointPairs.length + 1}`
                  : `Pick matching project point ${pointPairs.length + 1}`
              }
              detail={
                profile.family === 'pointCloud'
                  ? 'Point-cloud picks use exact source/world coordinates from the streamed viewer.'
                  : 'Each source pick must be followed by its matching project point.'
              }
            >
              {pointPairs.length} completed {pointPairs.length === 1 ? 'pair' : 'pairs'}; at least
              three non-collinear pairs are required for a similarity fit.
            </ChatBubble>
            <ChatCard title="Point-picking views">
              <div className={styles.views}>
                <RegistrationView
                  title="Importing"
                  subtitle={sourceLabel}
                  active={nextPickSide === 'source'}
                  pickReady={sourcePickReady}
                  {...(onRequestPick && nextPickSide === 'source'
                    ? { onPick: () => onRequestPick('source') }
                    : {})}
                >
                  {sourceView}
                </RegistrationView>
                <RegistrationView
                  title="Current project"
                  subtitle={projectLabel}
                  active={nextPickSide === 'target'}
                  pickReady={targetPickReady}
                  {...(onRequestPick && nextPickSide === 'target'
                    ? { onPick: () => onRequestPick('target') }
                    : {})}
                >
                  {projectView}
                </RegistrationView>
              </div>
              <div className={styles.pairActions}>
                <Target size={16} />
                <span>{pointPairs.length} completed pairs</span>
                <button
                  type="button"
                  disabled={pointPairs.length < 3 || busy || !onPreviewPointPairs}
                  onClick={onPreviewPointPairs}
                >
                  Fit preview
                </button>
                <button
                  type="button"
                  disabled={!state.preview?.accepted || busy || !onPreviewIcp}
                  onClick={onPreviewIcp}
                >
                  Refine with ICP
                </button>
              </div>
            </ChatCard>
          </>
        ) : null}

        {state && method === 'icp' ? (
          <ChatCard title="Bounded ICP preview">
            <div className={styles.pairActions}>
              <RotateCcw size={16} />
              <span>
                ICP uses prepared bounded samples and never scans all source geometry at runtime.
              </span>
              <button type="button" disabled={busy || !onPreviewIcp} onClick={onPreviewIcp}>
                Run ICP preview
              </button>
            </div>
          </ChatCard>
        ) : null}

        {state?.preview ? <PreviewDiagnostics state={state} /> : null}
      </ImportChatStream>
    </ImportChatRoot>
  );
}

function RegistrationView({
  title,
  subtitle,
  active,
  pickReady,
  onPick,
  children,
}: {
  readonly title: string;
  readonly subtitle: string;
  readonly active: boolean;
  readonly pickReady: boolean;
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
          <button type="button" disabled={!pickReady} onClick={onPick}>
            Use current point
          </button>
        ) : (
          <span className={styles.waiting}>{active ? 'Move cursor onto geometry' : 'Waiting'}</span>
        )}
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
    <ChatCard title={preview.accepted ? 'Registration preview accepted' : 'Registration review'}>
      <Metrics>
        <Metric
          label="RMS spatial"
          value={`${preview.residuals.rmsSpatialMeters.toFixed(4)} m`}
          warning={!preview.accepted}
        />
        <Metric label="Overlap" value={`${(preview.overlapRatio * 100).toFixed(1)}%`} />
        <Metric label="Iterations" value={String(preview.iterations)} />
        <Metric label="Matched" value={String(preview.matchedSamples)} />
      </Metrics>
      {preview.warnings.map((warning) => (
        <p className={styles.warning} key={warning}>
          {warning}
        </p>
      ))}
    </ChatCard>
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
      return 'Place local/BIM geometry from an explicit origin and clockwise project-north bearing.';
    case 'manualPlacement':
      return 'Set a coarse translation, rotation and optional uniform scale.';
    case 'pointPairs':
      return 'Pick fresh alternating source/project pairs. Saved recipes never retain old picks.';
    case 'icp':
      return 'Refine a coarse placement from bounded point or surface samples; ICP is never implicit.';
  }
}

function phaseLabel(phase: ImportRegistrationState['phase'] | undefined): string {
  if (!phase) return 'Provider probe · choose placement · stage · review · commit';
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
