import type {
  ImportRegistrationState,
  JsonValue,
  RegistrationPoint,
  RegistrationPointPair,
  RegistrationRecipe,
  RegistrationSimilarity3d,
} from '@himmelcad/app';
import { FileUp, Save, Target } from 'lucide-react';
import { useMemo, useState, type ReactNode } from 'react';

import { CrsTransformPair } from './CrsTransformPair.js';
import { Button } from './Button.js';
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
} from './importRegistrationProfile.js';

export type ImportTransformMode = 'none' | 'file' | 'separate' | 'combined';
type CombinedMethod = 'coordinateSystems' | 'pointPairs' | 'originAndNorth' | 'parameters';
type PointPairModel = 'translation3D' | 'rigid3D' | 'similarity3D';

export interface LoadedImportTransform {
  readonly label: string;
  readonly sourceSha256: string;
  readonly transform: RegistrationSimilarity3d;
  readonly warnings?: readonly string[];
}

export interface ImportRegistrationWizardProps {
  readonly sourceLabel: string;
  readonly projectLabel: string;
  readonly format?: ImportRegistrationFormatContext | null;
  readonly probeError?: string | null;
  readonly operationError?: string | null;
  readonly semanticLosses?: readonly string[];
  readonly sourceView?: ReactNode;
  readonly projectView?: ReactNode;
  readonly state?: ImportRegistrationState | null;
  readonly pointPairs?: readonly RegistrationPointPair[];
  readonly nextPickSide?: 'source' | 'target';
  readonly sourcePickReady?: boolean;
  readonly targetPickReady?: boolean;
  readonly busy?: boolean;
  readonly placementSummary?: string | null;
  readonly onChangePlacement?: () => void;
  readonly onStage: (recipe: RegistrationRecipe, providerOptions: JsonValue) => void;
  readonly onLoadTransform?: () => Promise<LoadedImportTransform | null>;
  readonly onSaveTransform?: (transform: RegistrationSimilarity3d) => Promise<string | null>;
  readonly onAcceptSemanticLosses?: () => void;
  readonly onRequestPick?: (side: 'source' | 'target') => void;
  readonly onPreviewPointPairs?: () => void;
  readonly onPreviewIcp?: () => void;
  readonly onCommit?: () => void;
  readonly onCancel: () => void;
}

/** Shared PhotoLab-style import chat; hosts provide live views and file bridges. */
export function ImportRegistrationWizard({
  sourceLabel,
  projectLabel,
  format = null,
  probeError = null,
  operationError = null,
  semanticLosses = [],
  sourceView,
  projectView,
  state,
  pointPairs = [],
  nextPickSide = 'source',
  sourcePickReady = false,
  targetPickReady = false,
  busy = false,
  placementSummary = null,
  onChangePlacement,
  onStage,
  onLoadTransform,
  onSaveTransform,
  onAcceptSemanticLosses,
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
  const [mode, setMode] = useState<ImportTransformMode | null>(null);
  const [combinedMethod, setCombinedMethod] = useState<CombinedMethod | null>(null);
  const [separateStep, setSeparateStep] = useState<'height' | 'horizontal' | 'ready'>('height');
  const [pointPairModel, setPointPairModel] = useState<PointPairModel>('rigid3D');
  const [loadedTransform, setLoadedTransform] = useState<LoadedImportTransform | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  const [fileBusy, setFileBusy] = useState(false);
  const [savedTransformPath, setSavedTransformPath] = useState<string | null>(null);
  const [rasterInterpretation, setRasterInterpretation] = useState<
    'auto' | 'rasterImage' | 'elevationSurface'
  >('auto');
  const [maximumHeightJump, setMaximumHeightJump] = useState('');
  const [sceneLayerId, setSceneLayerId] = useState('');
  const [sourceOrigin, setSourceOrigin] = useState<RegistrationPoint>(zeroPoint);
  const [targetOrigin, setTargetOrigin] = useState<RegistrationPoint>(zeroPoint);
  const [northDegrees, setNorthDegrees] = useState(0);
  const [manual, setManual] = useState<RegistrationSimilarity3d>(identityTransform);
  const [crs, setCrs] = useState({
    sourceHorizontal: '',
    targetHorizontal: '',
    sourceVertical: '',
    targetVertical: '',
    geoid: '',
  });
  const staged = state !== undefined && state !== null;
  const providerOptions = useMemo<JsonValue>(() => {
    const formatId = format?.formatId ?? '';
    if (formatId.startsWith('geotiff@')) {
      const parsed = maximumHeightJump.trim().length > 0 ? Number(maximumHeightJump) : null;
      return {
        interpretation: rasterInterpretation,
        maximumHeightJump:
          parsed !== null && Number.isFinite(parsed) && parsed >= 0 ? parsed : null,
      };
    }
    if (formatId.startsWith('slpk-')) {
      const parsed = sceneLayerId.trim().length > 0 ? Number(sceneLayerId) : null;
      return {
        layerId: parsed !== null && Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null,
      };
    }
    return {};
  }, [format?.formatId, maximumHeightJump, rasterInterpretation, sceneLayerId]);
  const activeMethod = resolveMethod(mode, combinedMethod);
  const recipe = useMemo<RegistrationRecipe | null>(() => {
    const common = {
      schemaVersion: 1 as const,
      recipeId: `import-${profile.family}-${mode ?? 'unset'}-${combinedMethod ?? 'default'}`,
    };
    if (mode === 'none') {
      return { ...common, label: 'Keep source coordinates', method: { kind: 'sourceCoordinates' } };
    }
    if (mode === 'file' && loadedTransform) {
      return {
        ...common,
        label: `Loaded transform · ${loadedTransform.label}`,
        method: { kind: 'manualPlacement', transform: loadedTransform.transform },
      };
    }
    if (mode === 'separate' && separateStep === 'ready') {
      return null;
    }
    if (mode !== 'combined') return null;
    switch (combinedMethod) {
      case 'coordinateSystems':
        return null;
      case 'pointPairs':
        return {
          ...common,
          label: `Point pairs · ${pointPairModel}`,
          method: {
            kind: 'pointPairs',
            model: pointPairModel,
            robust: defaultRobustOptions,
            offerIcpRefinement: true,
          },
        };
      case 'originAndNorth':
        return {
          ...common,
          label: 'Origin and project north',
          method: {
            kind: 'originAndProjectNorth',
            sourceOrigin,
            targetOrigin,
            projectNorthDegrees: northDegrees,
            scale: 1,
          },
        };
      case 'parameters':
        return {
          ...common,
          label: 'Transformation parameters',
          method: { kind: 'manualPlacement', transform: manual },
        };
      case null:
        return null;
    }
  }, [
    combinedMethod,
    loadedTransform,
    manual,
    mode,
    northDegrees,
    pointPairModel,
    profile.family,
    separateStep,
    sourceOrigin,
    targetOrigin,
  ]);

  const ready = state?.phase === 'readyToCommit' && state.preview?.accepted === true;
  const pickMode = staged && activeMethod === 'pointPairs';
  const loadTransform = async (): Promise<void> => {
    if (!onLoadTransform) return;
    setFileBusy(true);
    setFileError(null);
    try {
      setLoadedTransform(await onLoadTransform());
    } catch (error: unknown) {
      setLoadedTransform(null);
      setFileError(error instanceof Error ? error.message : String(error));
    } finally {
      setFileBusy(false);
    }
  };
  const saveTransform = async (): Promise<void> => {
    const transform = state?.preview?.transform;
    if (!transform || !onSaveTransform) return;
    setFileBusy(true);
    setFileError(null);
    try {
      setSavedTransformPath(await onSaveTransform(transform));
    } catch (error: unknown) {
      setFileError(error instanceof Error ? error.message : String(error));
    } finally {
      setFileBusy(false);
    }
  };
  const selectMode = (id: string): void => {
    const selectedMode = id as ImportTransformMode;
    setMode(selectedMode);
    setCombinedMethod(null);
    setSeparateStep('height');
    setLoadedTransform(null);
    setFileError(null);
    if (selectedMode === 'none') {
      onStage(
        {
          schemaVersion: 1,
          recipeId: `import-${profile.family}-none-default`,
          label: 'Keep source coordinates',
          method: { kind: 'sourceCoordinates' },
        },
        providerOptions,
      );
    }
  };

  return (
    <ImportChatRoot
      title="Import"
      closeLabel="Close import"
      onClose={onCancel}
      busy={busy || fileBusy}
      layout={pickMode ? 'wide' : 'default'}
      footer={
        <ChatFooter>
          <span className={styles.phase}>{phaseLabel(state?.phase)}</span>
          <ChatFooterSpacer />
          <button type="button" className={styles.secondary} onClick={onCancel}>
            Cancel
          </button>
          {!staged && mode !== 'none' ? (
            <button
              type="button"
              disabled={busy || fileBusy || !format || Boolean(probeError) || recipe === null}
              onClick={() => recipe && onStage(recipe, providerOptions)}
            >
              Check placement
            </button>
          ) : staged ? (
            <button type="button" disabled={!ready || busy} onClick={onCommit}>
              Import
            </button>
          ) : operationError && mode === 'none' && recipe ? (
            <button type="button" disabled={busy} onClick={() => onStage(recipe, providerOptions)}>
              Retry import
            </button>
          ) : null}
        </ChatFooter>
      }
    >
      <ImportChatStream
        scrollKey={[
          format?.formatId ?? 'probe',
          mode ?? '',
          combinedMethod ?? '',
          separateStep,
          state?.phase ?? '',
          pointPairs.length,
          nextPickSide,
          fileBusy,
        ].join(':')}
      >
        {probeError ? (
          <ChatBubble tone="error" title="I could not identify this file" detail={probeError} />
        ) : format ? (
          <ChatBubble
            tone="ok"
            title={`${profile.label} detected`}
            detail={`${sourceLabel} · ${format.displayName}`}
          />
        ) : (
          <ChatBubble title="Checking file">
            <ProgressBar
              value={0}
              ariaLabel="Checking file"
              indeterminate
              indeterminateLabel="Checking…"
            />
          </ChatBubble>
        )}

        {operationError ? (
          <ChatBubble tone="error" title="Import could not continue" detail={operationError} />
        ) : null}

        {state && placementSummary ? (
          <ChatCard title="Placement">
            <div className={styles.placementRow}>
              <span>{placementSummary}</span>
              {onChangePlacement ? (
                <Button
                  variant="secondary"
                  disabled={busy}
                  onClick={() => {
                    setMode(null);
                    setCombinedMethod(null);
                    onChangePlacement();
                  }}
                >
                  Change…
                </Button>
              ) : null}
            </div>
          </ChatCard>
        ) : null}

        {format && !staged ? (
          <FormatOptions
            formatId={format.formatId}
            rasterInterpretation={rasterInterpretation}
            maximumHeightJump={maximumHeightJump}
            sceneLayerId={sceneLayerId}
            disabled={busy}
            onRasterInterpretation={setRasterInterpretation}
            onMaximumHeightJump={setMaximumHeightJump}
            onSceneLayerId={setSceneLayerId}
          />
        ) : null}

        {semanticLosses.length > 0 ? (
          <ChatCard title="Unsupported content found">
            <p className={styles.lossSummary}>{semanticLossLabel(semanticLosses.length)}</p>
            <div className={styles.actions}>
              <button type="button" disabled={busy} onClick={onAcceptSemanticLosses}>
                Accept and continue
              </button>
            </div>
          </ChatCard>
        ) : null}

        {format && !staged ? (
          <>
            <ChatBubble title="Transform coordinates?" />
            <ChatChoices
              options={transformModeOptions}
              resolvedId={mode}
              disabled={busy || fileBusy}
              onSelect={selectMode}
              onRevert={mode ? () => setMode(null) : undefined}
              revertDisabled={busy || fileBusy}
            />
            {mode ? <ChatBubble role="user">{transformModeLabel(mode)}</ChatBubble> : null}
          </>
        ) : null}

        {mode === 'file' && !staged ? (
          <ChatCard title="Transformation file">
            <div className={styles.fileRow}>
              <FileUp size={16} />
              <span>{loadedTransform?.label ?? 'No file selected'}</span>
              <button type="button" disabled={fileBusy || !onLoadTransform} onClick={loadTransform}>
                Choose…
              </button>
            </div>
            {loadedTransform ? <TransformMetrics transform={loadedTransform.transform} /> : null}
            {loadedTransform?.warnings?.map((warning) => (
              <p className={styles.warning} key={warning}>
                {warning}
              </p>
            ))}
            {fileError ? <p className={styles.error}>{fileError}</p> : null}
          </ChatCard>
        ) : null}

        {mode === 'separate' && !staged ? (
          <SeparateCoordinateSetup
            step={separateStep}
            value={crs}
            disabled={busy}
            onChange={setCrs}
            onContinue={() =>
              setSeparateStep((current) => (current === 'height' ? 'horizontal' : 'ready'))
            }
            onBack={() => setSeparateStep('height')}
          />
        ) : null}

        {mode === 'combined' && !staged ? (
          <>
            <ChatBubble title="Choose method" />
            <ChatChoices
              options={combinedMethodOptions}
              resolvedId={combinedMethod}
              disabled={busy}
              onSelect={(id) => setCombinedMethod(id as CombinedMethod)}
              onRevert={combinedMethod ? () => setCombinedMethod(null) : undefined}
              revertDisabled={busy}
            />
            {combinedMethod ? (
              <ChatBubble role="user">{combinedMethodLabel(combinedMethod)}</ChatBubble>
            ) : null}
          </>
        ) : null}

        {mode === 'combined' && combinedMethod === 'coordinateSystems' && !staged ? (
          <CombinedCoordinateSetup value={crs} disabled={busy} onChange={setCrs} />
        ) : null}

        {!staged &&
        ((mode === 'separate' && separateStep === 'ready') ||
          (mode === 'combined' &&
            combinedMethod === 'coordinateSystems' &&
            horizontalComplete(crs) &&
            verticalComplete(crs))) ? (
          <ChatBubble
            tone="warn"
            title="This file cannot yet be reprojected"
            detail="Use common points or parameters for a reviewed placement."
          />
        ) : null}

        {mode === 'combined' && combinedMethod === 'pointPairs' && !staged ? (
          <ChatCard title="Point-pair model">
            <ChatChoices
              options={pointPairModelOptions}
              resolvedId={pointPairModel}
              disabled={busy}
              lockResolved={false}
              onSelect={(id) => setPointPairModel(id as PointPairModel)}
            />
          </ChatCard>
        ) : null}

        {mode === 'combined' && combinedMethod === 'originAndNorth' && !staged ? (
          <ChatCard title="Origin and north">
            <div className={styles.parameters}>
              <PointEditor label="Source origin" value={sourceOrigin} onChange={setSourceOrigin} />
              <PointEditor label="Project origin" value={targetOrigin} onChange={setTargetOrigin} />
              <NumberField label="North (°)" value={northDegrees} onChange={setNorthDegrees} />
            </div>
          </ChatCard>
        ) : null}

        {mode === 'combined' && combinedMethod === 'parameters' && !staged ? (
          <ManualTransformEditor value={manual} onChange={setManual} />
        ) : null}

        {state && mode !== 'none' ? (
          <ChatBubble
            tone="ok"
            title="Preview ready"
            detail={`${state.sourceEntityCount} ${state.sourceEntityCount === 1 ? 'entity' : 'entities'}`}
          />
        ) : null}

        {pickMode ? (
          <PointPairWorkspace
            sourceLabel={sourceLabel}
            projectLabel={projectLabel}
            sourceView={sourceView}
            projectView={projectView}
            pointPairs={pointPairs}
            nextPickSide={nextPickSide}
            sourcePickReady={sourcePickReady}
            targetPickReady={targetPickReady}
            busy={busy}
            state={state}
            model={pointPairModel}
            {...(onRequestPick ? { onRequestPick } : {})}
            {...(onPreviewPointPairs ? { onPreviewPointPairs } : {})}
            {...(onPreviewIcp ? { onPreviewIcp } : {})}
          />
        ) : null}

        {state?.preview && mode !== 'none' ? (
          <>
            <PreviewDiagnostics state={state} />
            {state.preview.accepted && onSaveTransform ? (
              <ChatCard title="Reuse this transformation">
                <div className={styles.fileRow}>
                  <Save size={16} />
                  <span>
                    {savedTransformPath ?? 'Save the calculated parameters without picks'}
                  </span>
                  <button type="button" disabled={fileBusy} onClick={saveTransform}>
                    Save…
                  </button>
                </div>
                {fileError ? <p className={styles.error}>{fileError}</p> : null}
              </ChatCard>
            ) : null}
          </>
        ) : null}
      </ImportChatStream>
    </ImportChatRoot>
  );
}

function FormatOptions({
  formatId,
  rasterInterpretation,
  maximumHeightJump,
  sceneLayerId,
  disabled,
  onRasterInterpretation,
  onMaximumHeightJump,
  onSceneLayerId,
}: {
  readonly formatId: string;
  readonly rasterInterpretation: 'auto' | 'rasterImage' | 'elevationSurface';
  readonly maximumHeightJump: string;
  readonly sceneLayerId: string;
  readonly disabled: boolean;
  readonly onRasterInterpretation: (value: 'auto' | 'rasterImage' | 'elevationSurface') => void;
  readonly onMaximumHeightJump: (value: string) => void;
  readonly onSceneLayerId: (value: string) => void;
}): JSX.Element | null {
  if (formatId.startsWith('geotiff@')) {
    return (
      <ChatCard title="Raster type">
        <ChatChoices
          options={rasterInterpretationOptions}
          resolvedId={rasterInterpretation}
          disabled={disabled}
          lockResolved={false}
          onSelect={(id) =>
            onRasterInterpretation(id as 'auto' | 'rasterImage' | 'elevationSurface')
          }
        />
        {rasterInterpretation === 'elevationSurface' ? (
          <label className={styles.compactField}>
            <span>Maximum height jump</span>
            <input
              type="number"
              min="0"
              step="any"
              value={maximumHeightJump}
              disabled={disabled}
              placeholder="No limit"
              onChange={(event) => onMaximumHeightJump(event.currentTarget.value)}
            />
          </label>
        ) : null}
      </ChatCard>
    );
  }
  if (formatId.startsWith('slpk-')) {
    return (
      <ChatCard title="Scene layer">
        <label className={styles.compactField}>
          <span>Layer ID (only for multi-layer packages)</span>
          <input
            type="number"
            min="0"
            step="1"
            value={sceneLayerId}
            disabled={disabled}
            placeholder="Automatic"
            onChange={(event) => onSceneLayerId(event.currentTarget.value)}
          />
        </label>
      </ChatCard>
    );
  }
  return null;
}

function SeparateCoordinateSetup({
  step,
  value,
  disabled,
  onChange,
  onContinue,
  onBack,
}: {
  readonly step: 'height' | 'horizontal' | 'ready';
  readonly value: CrsFields;
  readonly disabled: boolean;
  readonly onChange: (value: CrsFields) => void;
  readonly onContinue: () => void;
  readonly onBack: () => void;
}): JSX.Element {
  return (
    <>
      <ChatBubble title={step === 'height' ? 'Height system' : 'Horizontal system'} />
      {step === 'height' ? (
        <ChatCard title="Height">
          <CrsTransformPair
            title=""
            noTransform={false}
            onNoTransformChange={() => undefined}
            showNoTransform={false}
            source={
              <CrsField
                label="Source height system"
                value={value.sourceVertical}
                disabled={disabled}
                onChange={(sourceVertical) => onChange({ ...value, sourceVertical })}
              />
            }
            target={
              <CrsField
                label="Target height system"
                value={value.targetVertical}
                disabled={disabled}
                onChange={(targetVertical) => onChange({ ...value, targetVertical })}
              />
            }
          />
          <CrsField
            label="Geoid / vertical grid (optional)"
            value={value.geoid}
            disabled={disabled}
            onChange={(geoid) => onChange({ ...value, geoid })}
          />
          <div className={styles.actions}>
            <button
              type="button"
              disabled={disabled || !verticalComplete(value)}
              onClick={onContinue}
            >
              Continue
            </button>
          </div>
        </ChatCard>
      ) : (
        <ChatCard title="Horizontal coordinates" onRevert={onBack} revertDisabled={disabled}>
          <CrsTransformPair
            title=""
            noTransform={false}
            onNoTransformChange={() => undefined}
            showNoTransform={false}
            source={
              <CrsField
                label="Source coordinate system"
                value={value.sourceHorizontal}
                disabled={disabled}
                onChange={(sourceHorizontal) => onChange({ ...value, sourceHorizontal })}
              />
            }
            target={
              <CrsField
                label="Target coordinate system"
                value={value.targetHorizontal}
                disabled={disabled}
                onChange={(targetHorizontal) => onChange({ ...value, targetHorizontal })}
              />
            }
          />
          {step === 'horizontal' ? (
            <div className={styles.actions}>
              <button
                type="button"
                disabled={disabled || !horizontalComplete(value)}
                onClick={onContinue}
              >
                Continue
              </button>
            </div>
          ) : null}
        </ChatCard>
      )}
      {step === 'ready' ? (
        <ChatBubble role="user">Height and horizontal configured</ChatBubble>
      ) : null}
    </>
  );
}

function CombinedCoordinateSetup({
  value,
  disabled,
  onChange,
}: {
  readonly value: CrsFields;
  readonly disabled: boolean;
  readonly onChange: (value: CrsFields) => void;
}): JSX.Element {
  return (
    <ChatCard title="Coordinate and height systems">
      <div className={styles.crsStack}>
        <CrsTransformPair
          title="Horizontal"
          noTransform={false}
          onNoTransformChange={() => undefined}
          showNoTransform={false}
          source={
            <CrsField
              label="Source"
              value={value.sourceHorizontal}
              disabled={disabled}
              onChange={(sourceHorizontal) => onChange({ ...value, sourceHorizontal })}
            />
          }
          target={
            <CrsField
              label="Target"
              value={value.targetHorizontal}
              disabled={disabled}
              onChange={(targetHorizontal) => onChange({ ...value, targetHorizontal })}
            />
          }
        />
        <CrsTransformPair
          title="Height"
          noTransform={false}
          onNoTransformChange={() => undefined}
          showNoTransform={false}
          source={
            <CrsField
              label="Source"
              value={value.sourceVertical}
              disabled={disabled}
              onChange={(sourceVertical) => onChange({ ...value, sourceVertical })}
            />
          }
          target={
            <CrsField
              label="Target"
              value={value.targetVertical}
              disabled={disabled}
              onChange={(targetVertical) => onChange({ ...value, targetVertical })}
            />
          }
        />
        <CrsField
          label="Geoid / vertical grid (optional)"
          value={value.geoid}
          disabled={disabled}
          onChange={(geoid) => onChange({ ...value, geoid })}
        />
      </div>
    </ChatCard>
  );
}

function PointPairWorkspace({
  sourceLabel,
  projectLabel,
  sourceView,
  projectView,
  pointPairs,
  nextPickSide,
  sourcePickReady,
  targetPickReady,
  busy,
  state,
  model,
  onRequestPick,
  onPreviewPointPairs,
  onPreviewIcp,
}: {
  readonly sourceLabel: string;
  readonly projectLabel: string;
  readonly sourceView?: ReactNode;
  readonly projectView?: ReactNode;
  readonly pointPairs: readonly RegistrationPointPair[];
  readonly nextPickSide: 'source' | 'target';
  readonly sourcePickReady: boolean;
  readonly targetPickReady: boolean;
  readonly busy: boolean;
  readonly state: ImportRegistrationState;
  readonly model: PointPairModel;
  readonly onRequestPick?: (side: 'source' | 'target') => void;
  readonly onPreviewPointPairs?: () => void;
  readonly onPreviewIcp?: () => void;
}): JSX.Element {
  const minimumPairs = model === 'translation3D' ? 1 : 3;
  return (
    <>
      <ChatBubble
        title={nextPickSide === 'source' ? 'Pick source point' : 'Pick matching project point'}
        detail={`${pointPairs.length} complete ${pointPairs.length === 1 ? 'pair' : 'pairs'}`}
      />
      <ChatCard title="Point pairs">
        <div className={styles.views}>
          <RegistrationView
            title="Source"
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
            title="Project"
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
          <span>{pointPairs.length} pairs</span>
          <button
            type="button"
            disabled={pointPairs.length < minimumPairs || busy || !onPreviewPointPairs}
            onClick={onPreviewPointPairs}
          >
            Fit
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
  );
}

function ManualTransformEditor({
  value,
  onChange,
}: {
  readonly value: RegistrationSimilarity3d;
  readonly onChange: (value: RegistrationSimilarity3d) => void;
}): JSX.Element {
  return (
    <ChatCard title="Transformation parameters">
      <div className={styles.parameters}>
        <PointEditor
          label="Translation"
          value={{ x: value.tx, y: value.ty, z: value.tz }}
          onChange={(point) => onChange({ ...value, tx: point.x, ty: point.y, tz: point.z })}
        />
        <PointEditor
          label="Rotation (rad)"
          value={{ x: value.rxRadians, y: value.ryRadians, z: value.rzRadians }}
          onChange={(point) =>
            onChange({
              ...value,
              rxRadians: point.x,
              ryRadians: point.y,
              rzRadians: point.z,
            })
          }
        />
        <NumberField
          label="Scale"
          value={value.scale}
          minimum={Number.EPSILON}
          onChange={(scale) => onChange({ ...value, scale })}
        />
      </div>
    </ChatCard>
  );
}

function TransformMetrics({
  transform,
}: {
  readonly transform: RegistrationSimilarity3d;
}): JSX.Element {
  return (
    <Metrics>
      <Metric
        label="Translation"
        value={`${compact(transform.tx)}, ${compact(transform.ty)}, ${compact(transform.tz)}`}
      />
      <Metric
        label="Rotation"
        value={`${compact(transform.rxRadians)}, ${compact(transform.ryRadians)}, ${compact(transform.rzRadians)}`}
      />
      <Metric label="Scale" value={compact(transform.scale)} />
    </Metrics>
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
            Use point
          </button>
        ) : (
          <span className={styles.waiting}>{active ? 'Point at geometry' : 'Waiting'}</span>
        )}
      </header>
      <div className={styles.viewport}>{children ?? <span>Viewport</span>}</div>
    </div>
  );
}

function CrsField({
  label,
  value,
  disabled,
  onChange,
}: {
  readonly label: string;
  readonly value: string;
  readonly disabled: boolean;
  readonly onChange: (value: string) => void;
}): JSX.Element {
  return (
    <label className={styles.crsField}>
      <span>{label}</span>
      <input
        value={value}
        disabled={disabled}
        placeholder="e.g. EPSG:25832"
        onChange={(event) => onChange(event.currentTarget.value)}
      />
    </label>
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
    <ChatCard title={preview.accepted ? 'Transformation accepted' : 'Review'}>
      <Metrics>
        <Metric
          label="RMS 3D"
          value={`${preview.residuals.rmsSpatialMeters.toFixed(4)} m`}
          warning={!preview.accepted}
        />
        <Metric label="Overlap" value={`${(preview.overlapRatio * 100).toFixed(1)}%`} />
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

function resolveMethod(
  mode: ImportTransformMode | null,
  combinedMethod: CombinedMethod | null,
): CombinedMethod | 'sourceCoordinates' | 'file' | null {
  if (mode === 'none' || mode === 'separate') return 'sourceCoordinates';
  if (mode === 'file') return 'file';
  return combinedMethod;
}

function transformModeLabel(mode: ImportTransformMode): string {
  return transformModeOptions.find((option) => option.id === mode)?.label ?? mode;
}

function combinedMethodLabel(method: CombinedMethod): string {
  return combinedMethodOptions.find((option) => option.id === method)?.label ?? method;
}

function phaseLabel(phase: ImportRegistrationState['phase'] | undefined): string {
  if (!phase) return 'Not imported';
  return phase.replace(/([A-Z])/g, ' $1').toLowerCase();
}

function verticalComplete(value: CrsFields): boolean {
  return value.sourceVertical.trim().length > 0 && value.targetVertical.trim().length > 0;
}

function horizontalComplete(value: CrsFields): boolean {
  return value.sourceHorizontal.trim().length > 0 && value.targetHorizontal.trim().length > 0;
}

function compact(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toPrecision(6);
}

function semanticLossLabel(count: number): string {
  return `${count} ${count === 1 ? 'case needs' : 'cases need'} explicit approval.`;
}

interface CrsFields {
  readonly sourceHorizontal: string;
  readonly targetHorizontal: string;
  readonly sourceVertical: string;
  readonly targetVertical: string;
  readonly geoid: string;
}

const zeroPoint: RegistrationPoint = { x: 0, y: 0, z: 0 };
const identityTransform: RegistrationSimilarity3d = {
  tx: 0,
  ty: 0,
  tz: 0,
  rxRadians: 0,
  ryRadians: 0,
  rzRadians: 0,
  scale: 1,
};
const defaultRobustOptions = {
  maximumIterations: 20,
  huberDeltaMeters: 0.05,
  convergenceEpsilon: 1e-10,
} as const;
const transformModeOptions = [
  { id: 'none', label: 'No transformation', primary: true },
  { id: 'file', label: 'Load transformation file' },
  { id: 'separate', label: 'Horizontal and height separately' },
  { id: 'combined', label: 'Horizontal and height together' },
] as const;
const combinedMethodOptions = [
  { id: 'coordinateSystems', label: 'Coordinate + height systems', primary: true },
  { id: 'pointPairs', label: 'Common points' },
  { id: 'originAndNorth', label: 'Origin + north' },
  { id: 'parameters', label: 'Parameters' },
] as const;
const pointPairModelOptions = [
  { id: 'rigid3D', label: 'Rigid · scale locked', primary: true },
  { id: 'translation3D', label: 'Translation only' },
  { id: 'similarity3D', label: 'Similarity · calculate scale' },
] as const;
const rasterInterpretationOptions = [
  { id: 'auto', label: 'Automatic', primary: true },
  { id: 'rasterImage', label: 'Raster image' },
  { id: 'elevationSurface', label: 'Elevation surface' },
] as const;
