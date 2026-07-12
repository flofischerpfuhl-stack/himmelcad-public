import type { EntityId, ObjectHash, ProcessingSetRecord } from '@himmelcad/data';
import { Check, ChevronDown, ChevronRight, FileDown, FileUp, Play, RotateCcw } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';

import styles from './BatchConfiguratorPanel.module.css';
import {
  defaultProductConfiguration,
  type ProductOperation,
  type ProductRunConfiguration,
} from './ProductPanel.js';

export interface BatchPipelineFile {
  formatVersion: 1;
  name: string;
  steps: BatchPipelineStep[];
  scope?: BatchPipelineScope;
}

export type BatchPipelineScope =
  | { kind: 'all' }
  | { kind: 'currentSelection' }
  | { kind: 'processingSet'; entityId: EntityId; membershipSha256: ObjectHash };

export type BatchPipelineStep =
  | { kind: 'alignment'; profile: 'qualityHybrid' | 'maximumRobustness' | 'fast' }
  | { kind: 'product'; configuration: ProductRunConfiguration };

interface BatchConfiguratorPanelProps {
  busy: boolean;
  canStart: boolean;
  allCameraIds: readonly EntityId[];
  selectedCameraIds: readonly EntityId[];
  processingSets: readonly ProcessingSetRecord[];
  activeProcessingSetId: EntityId | null;
  onActivateProcessingSet: (processingSetId: EntityId) => void;
  onClearProcessingSet: () => void;
  onStart: (
    steps: BatchPipelineStep[],
    cameraEntityIds: readonly EntityId[],
    scopeLabel: string,
  ) => void;
}

const OPERATIONS: readonly ProductOperation[] = ['depth', 'dense', 'dem', 'ortho', 'mesh', 'splat'];

export function BatchConfiguratorPanel({
  busy,
  canStart,
  allCameraIds,
  selectedCameraIds,
  processingSets,
  activeProcessingSetId,
  onActivateProcessingSet,
  onClearProcessingSet,
  onStart,
}: BatchConfiguratorPanelProps): JSX.Element {
  const [file, setFile] = useState<BatchPipelineFile>(createDefaultBatch);
  const [expanded, setExpanded] = useState<string | null>('alignment');
  const [batchError, setBatchError] = useState<string | null>(null);
  const scope = scopeValue(file.scope);
  const enabledKinds = useMemo(() => new Set(file.steps.map(stepKey)), [file.steps]);
  const selectedProcessingSet = useMemo(() => {
    const configuredScope = file.scope;
    if (configuredScope?.kind !== 'processingSet') return undefined;
    return processingSets.find(
      (candidate) =>
        candidate.entityId === configuredScope.entityId &&
        candidate.membershipSha256 === configuredScope.membershipSha256,
    );
  }, [file.scope, processingSets]);
  const processingSetScopeInvalid = file.scope?.kind === 'processingSet' && !selectedProcessingSet;
  const scopedCameraIds =
    scope === 'all'
      ? allCameraIds
      : file.scope?.kind === 'processingSet'
        ? (selectedProcessingSet?.cameraEntityIds ?? [])
        : selectedCameraIds;
  const scopeLabel =
    scope === 'all'
      ? `All images · ${allCameraIds.length}`
      : selectedProcessingSet
        ? `${selectedProcessingSet.name} · saved processing set`
        : processingSetScopeInvalid
          ? 'Processing set unavailable'
          : `Current selection · ${selectedCameraIds.length}`;

  useEffect(() => {
    if (!activeProcessingSetId) return;
    const processingSet = processingSets.find(
      (candidate) => candidate.entityId === activeProcessingSetId,
    );
    if (!processingSet) return;
    setFile((current) => ({ ...current, scope: processingSetScope(processingSet) }));
  }, [activeProcessingSetId, processingSets]);

  const toggle = (key: string, enabled: boolean) => {
    setFile((current) => {
      if (!enabled) {
        return {
          ...current,
          steps: normalizeSteps(current.steps.filter((step) => stepKey(step) !== key)),
        };
      }
      const next = [...current.steps];
      if (key === 'alignment') next.push({ kind: 'alignment', profile: 'qualityHybrid' });
      else
        next.push({
          kind: 'product',
          configuration: defaultProductConfiguration(key as ProductOperation),
        });
      return { ...current, steps: normalizeSteps(next) };
    });
  };

  const updateAlignment = (profile: 'qualityHybrid' | 'maximumRobustness' | 'fast') => {
    setFile((current) => ({
      ...current,
      steps: current.steps.map((step) => (step.kind === 'alignment' ? { ...step, profile } : step)),
    }));
  };

  const updateProduct = (configuration: ProductRunConfiguration) => {
    setFile((current) => ({
      ...current,
      steps: current.steps.map((step) =>
        step.kind === 'product' && step.configuration.kind === configuration.kind
          ? { ...step, configuration }
          : step,
      ),
    }));
  };

  const load = async () => {
    setBatchError(null);
    try {
      const loaded = await window.himmelcad?.batch.load<unknown>();
      if (loaded == null) return;
      if (!isBatchPipelineFile(loaded))
        throw new Error('The batch file does not use a supported PhotoLab format.');
      const normalized: BatchPipelineFile = {
        ...loaded,
        steps: normalizeSteps(loaded.steps),
        scope: loaded.scope ?? { kind: 'all' },
      };
      const loadedScope = normalized.scope;
      if (loadedScope?.kind === 'processingSet') {
        const processingSet = processingSets.find(
          (candidate) => candidate.entityId === loadedScope.entityId,
        );
        if (!processingSet)
          throw new Error('The referenced processing set does not exist in this project.');
        if (processingSet.membershipSha256 !== loadedScope.membershipSha256)
          throw new Error('The processing set does not match its stored membership hash.');
        onActivateProcessingSet(processingSet.entityId);
      } else {
        onClearProcessingSet();
      }
      setFile(normalized);
    } catch (error) {
      setBatchError(error instanceof Error ? error.message : String(error));
    }
  };

  return (
    <div className={styles.root}>
      <section className={styles.intro}>
        <div>
          <strong>Resumable product batch</strong>
          <p>
            Every node is published atomically and saved locally immediately. After cancellation or
            restart, the same batch resumes at the last completed node.
          </p>
        </div>
      </section>

      <label className={styles.name}>
        <span>Configuration</span>
        <input
          value={file.name}
          disabled={busy}
          onChange={(event) =>
            setFile((current) => ({ ...current, name: event.currentTarget.value }))
          }
        />
      </label>
      <label className={styles.name}>
        <span>Image scope</span>
        <select
          value={scope}
          disabled={busy}
          onChange={(event) => {
            const value = event.currentTarget.value;
            setBatchError(null);
            const processingSetId = decodeProcessingSetValue(value);
            if (processingSetId) {
              const processingSet = processingSets.find(
                (candidate) => candidate.entityId === processingSetId,
              );
              if (!processingSet) return;
              setFile((current) => ({ ...current, scope: processingSetScope(processingSet) }));
              onActivateProcessingSet(processingSetId);
            } else {
              setFile((current) => ({
                ...current,
                scope: value === 'selection' ? { kind: 'currentSelection' } : { kind: 'all' },
              }));
              onClearProcessingSet();
            }
          }}
        >
          <option value="all">All images · {allCameraIds.length}</option>
          <option value="selection" disabled={selectedCameraIds.length < 2}>
            Current selection · {selectedCameraIds.length}
          </option>
          {processingSets.length > 0 && (
            <optgroup label="Saved processing sets">
              {processingSets.map((processingSet) => (
                <option
                  key={processingSet.entityId}
                  value={encodeProcessingSetValue(processingSet.entityId)}
                >
                  {processingSet.name} · {processingSet.cameraEntityIds.length}
                </option>
              ))}
            </optgroup>
          )}
        </select>
      </label>
      {selectedProcessingSet && (
        <div className={styles.scopeSummary}>
          <strong>{selectedProcessingSet.name}</strong>
          <span>
            {selectedProcessingSet.cameraEntityIds.length} immutable camera references ·{' '}
            <code title={selectedProcessingSet.membershipSha256}>
              {selectedProcessingSet.membershipSha256.slice(0, 12)}
            </code>
          </span>
        </div>
      )}
      {(batchError !== null || processingSetScopeInvalid) && (
        <div className={styles.error} role="alert">
          {batchError ??
            'The saved processing set is missing or its membership hash does not match.'}
        </div>
      )}

      <div className={styles.toolbar}>
        <button type="button" disabled={busy} onClick={() => void load()}>
          <FileUp size={14} /> Load
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={() => void window.himmelcad?.batch.save(file)}
        >
          <FileDown size={14} /> Save
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={() => {
            setFile(createDefaultBatch());
            setBatchError(null);
            onClearProcessingSet();
          }}
        >
          <RotateCcw size={14} /> Defaults
        </button>
      </div>

      <div className={styles.pipeline}>
        <BatchCard
          label="Align Photos"
          description="Sparse reconstruction and camera poses"
          enabled={enabledKinds.has('alignment')}
          expanded={expanded === 'alignment'}
          disabled={busy}
          onToggle={(enabled) => toggle('alignment', enabled)}
          onExpand={() => setExpanded(expanded === 'alignment' ? null : 'alignment')}
        >
          <label className={styles.field}>
            <span>Profile</span>
            <select
              value={alignmentStep(file.steps)?.profile ?? 'qualityHybrid'}
              onChange={(event) =>
                updateAlignment(
                  event.currentTarget.value as 'qualityHybrid' | 'maximumRobustness' | 'fast',
                )
              }
            >
              <option value="qualityHybrid">Quality Hybrid · recommended</option>
              <option value="maximumRobustness">Maximum Robustness</option>
              <option value="fast">Fast</option>
            </select>
          </label>
        </BatchCard>

        {OPERATIONS.map((operation) => {
          const configuration =
            productStep(file.steps, operation)?.configuration ??
            defaultProductConfiguration(operation);
          return (
            <BatchCard
              key={operation}
              label={productLabel(operation)}
              description={productDescription(operation)}
              enabled={enabledKinds.has(operation)}
              expanded={expanded === operation}
              disabled={busy}
              onToggle={(enabled) => toggle(operation, enabled)}
              onExpand={() => setExpanded(expanded === operation ? null : operation)}
            >
              <ProductBatchFields configuration={configuration} onChange={updateProduct} />
            </BatchCard>
          );
        })}
      </div>

      <div className={styles.note}>
        <Check size={14} />{' '}
        <span>
          {file.steps.length} nodes · automatic save after every node · cancellation remains
          available at all times
        </span>
      </div>
      <button
        className={styles.start}
        type="button"
        disabled={
          busy ||
          !canStart ||
          file.steps.length === 0 ||
          processingSetScopeInvalid ||
          scopedCameraIds.length < 2
        }
        onClick={() => onStart(file.steps, scope === 'all' ? [] : scopedCameraIds, scopeLabel)}
      >
        <Play size={15} /> {busy ? 'Queueing batch…' : 'Start / resume batch'}
      </button>
    </div>
  );
}

const PROCESSING_SET_PREFIX = 'processing-set:';

function encodeProcessingSetValue(entityId: EntityId): string {
  return `${PROCESSING_SET_PREFIX}${entityId}`;
}

function decodeProcessingSetValue(value: string): EntityId | null {
  return value.startsWith(PROCESSING_SET_PREFIX)
    ? (value.slice(PROCESSING_SET_PREFIX.length) as EntityId)
    : null;
}

function BatchCard({
  label,
  description,
  enabled,
  expanded,
  disabled,
  onToggle,
  onExpand,
  children,
}: {
  label: string;
  description: string;
  enabled: boolean;
  expanded: boolean;
  disabled: boolean;
  onToggle: (enabled: boolean) => void;
  onExpand: () => void;
  children: React.ReactNode;
}): JSX.Element {
  return (
    <section className={`${styles.card} ${enabled ? styles.enabled : ''}`}>
      <div className={styles.cardHeader}>
        <label className={styles.check}>
          <input
            type="checkbox"
            checked={enabled}
            disabled={disabled}
            onChange={(event) => onToggle(event.currentTarget.checked)}
          />
          <span />
        </label>
        <button type="button" className={styles.expand} disabled={!enabled} onClick={onExpand}>
          {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
          <span>
            <strong>{label}</strong>
            <small>{description}</small>
          </span>
        </button>
      </div>
      {enabled && expanded ? <div className={styles.fields}>{children}</div> : null}
    </section>
  );
}

function ProductBatchFields({
  configuration,
  onChange,
}: {
  configuration: ProductRunConfiguration;
  onChange: (configuration: ProductRunConfiguration) => void;
}): JSX.Element {
  switch (configuration.kind) {
    case 'depth':
      return (
        <>
          <SelectField
            label="Resolution"
            value={configuration.imageDownscale}
            onChange={(value) =>
              onChange({ ...configuration, imageDownscale: Number(value) as 1 | 2 | 4 | 8 })
            }
            options={[
              [1, 'Original'],
              [2, 'High · 1/2'],
              [4, 'Medium · 1/4'],
              [8, 'Low · 1/8'],
            ]}
          />
          <SelectField
            label="Filter"
            value={configuration.filter}
            onChange={(value) =>
              onChange({ ...configuration, filter: value as 'mild' | 'moderate' | 'aggressive' })
            }
            options={[
              ['mild', 'Mild'],
              ['moderate', 'Moderate'],
              ['aggressive', 'Aggressive'],
            ]}
          />
          <ToggleField
            label="Reuse compatible maps"
            checked={configuration.reuseCompatibleMaps}
            onChange={(checked) => onChange({ ...configuration, reuseCompatibleMaps: checked })}
          />
        </>
      );
    case 'dense':
      return (
        <>
          <SelectField
            label="Resolution"
            value={configuration.imageDownscale}
            onChange={(value) =>
              onChange({ ...configuration, imageDownscale: Number(value) as 1 | 2 | 4 | 8 })
            }
            options={[
              [1, 'Original'],
              [2, 'High · 1/2'],
              [4, 'Medium · 1/4'],
              [8, 'Low · 1/8'],
            ]}
          />
          <NumberField
            label="Minimum views"
            value={configuration.minimumViews}
            min={2}
            max={16}
            step={1}
            onChange={(value) => onChange({ ...configuration, minimumViews: value })}
          />
          <ToggleField
            label="Retain confidence"
            checked={configuration.retainConfidence}
            onChange={(checked) => onChange({ ...configuration, retainConfidence: checked })}
          />
          <ToggleField
            label="Point colors"
            checked={configuration.calculateColors}
            onChange={(checked) => onChange({ ...configuration, calculateColors: checked })}
          />
        </>
      );
    case 'dem':
      return (
        <>
          <SelectField
            label="Surface"
            value={configuration.surface}
            onChange={(value) => onChange({ ...configuration, surface: value as 'dsm' | 'dtm' })}
            options={[
              ['dsm', 'DSM'],
              ['dtm', 'DTM'],
            ]}
          />
          <NumberField
            label="Resolution [m/px]"
            value={configuration.resolutionMetersPerPixel}
            min={0.001}
            max={100}
            step={0.001}
            onChange={(value) => onChange({ ...configuration, resolutionMetersPerPixel: value })}
          />
          <TileField configuration={configuration} onChange={onChange} />
          <ToggleField
            label="Interpolate NoData"
            checked={configuration.interpolateNodata}
            onChange={(checked) => onChange({ ...configuration, interpolateNodata: checked })}
          />
        </>
      );
    case 'ortho':
      return (
        <>
          <NumberField
            label="Resolution [m/px]"
            value={configuration.resolutionMetersPerPixel}
            min={0.001}
            max={100}
            step={0.001}
            onChange={(value) => onChange({ ...configuration, resolutionMetersPerPixel: value })}
          />
          <SelectField
            label="Blending"
            value={configuration.blendMode}
            onChange={(value) =>
              onChange({ ...configuration, blendMode: value as 'mosaic' | 'average' | 'disabled' })
            }
            options={[
              ['mosaic', 'Mosaic'],
              ['average', 'Average'],
              ['disabled', 'None'],
            ]}
          />
          <TileField configuration={configuration} onChange={onChange} />
          <ToggleField
            label="Color correction"
            checked={configuration.colorCorrection}
            onChange={(checked) => onChange({ ...configuration, colorCorrection: checked })}
          />
          <ToggleField
            label="Fill gaps"
            checked={configuration.fillHoles}
            onChange={(checked) => onChange({ ...configuration, fillHoles: checked })}
          />
        </>
      );
    case 'mesh':
      return (
        <>
          <NumberField
            label="Target faces"
            value={configuration.targetFaceCount}
            min={10_000}
            max={500_000_000}
            step={10_000}
            onChange={(value) => onChange({ ...configuration, targetFaceCount: value })}
          />
          <ToggleField
            label="Interpolate holes"
            checked={configuration.interpolateHoles}
            onChange={(checked) => onChange({ ...configuration, interpolateHoles: checked })}
          />
          <ToggleField
            label="Build texture"
            checked={configuration.buildTexture}
            onChange={(checked) => onChange({ ...configuration, buildTexture: checked })}
          />
          <SelectField
            label="Texture atlas"
            value={configuration.textureSize}
            onChange={(value) =>
              onChange({
                ...configuration,
                textureSize: Number(value) as 2048 | 4096 | 8192 | 16384,
              })
            }
            options={[
              [2048, '2048'],
              [4096, '4096'],
              [8192, '8192'],
              [16384, '16384'],
            ]}
          />
        </>
      );
    case 'splat':
      return (
        <>
          <SelectField
            label="Initialization"
            value={configuration.initialization}
            onChange={(value) =>
              onChange({
                ...configuration,
                initialization: value as 'sparseTiePoints',
              })
            }
            options={[['sparseTiePoints', 'Calibrated cameras + sparse tie points']]}
          />
          <NumberField
            label="Iterations"
            value={configuration.iterations}
            min={1_000}
            max={200_000}
            step={1_000}
            onChange={(value) => onChange({ ...configuration, iterations: value })}
          />
          <SelectField
            label="SH degree"
            value={configuration.sphericalHarmonicsDegree}
            onChange={(value) =>
              onChange({
                ...configuration,
                sphericalHarmonicsDegree: Number(value) as 0 | 1 | 2 | 3,
              })
            }
            options={[
              [0, '0'],
              [1, '1'],
              [2, '2'],
              [3, '3'],
            ]}
          />
          <NumberField
            label="Max. Splats"
            value={configuration.maximumSplats}
            min={100_000}
            max={100_000_000}
            step={100_000}
            onChange={(value) => onChange({ ...configuration, maximumSplats: value })}
          />
          <NumberField
            label="Maximum training image edge"
            value={configuration.maximumResolution}
            min={256}
            max={32_768}
            step={128}
            onChange={(value) => onChange({ ...configuration, maximumResolution: value })}
          />
          <ToggleField
            label="Retain checkpoints"
            checked={configuration.retainTrainingCheckpoints}
            onChange={(checked) =>
              onChange({ ...configuration, retainTrainingCheckpoints: checked })
            }
          />
        </>
      );
  }
}

function SelectField({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: string | number;
  options: readonly (readonly [string | number, string])[];
  onChange: (value: string) => void;
}): JSX.Element {
  return (
    <label className={styles.field}>
      <span>{label}</span>
      <select value={value} onChange={(event) => onChange(event.currentTarget.value)}>
        {options.map(([key, text]) => (
          <option key={key} value={key}>
            {text}
          </option>
        ))}
      </select>
    </label>
  );
}
function NumberField({
  label,
  value,
  min,
  max,
  step,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  onChange: (value: number) => void;
}): JSX.Element {
  return (
    <label className={styles.field}>
      <span>{label}</span>
      <input
        type="number"
        value={value}
        min={min}
        max={max}
        step={step}
        onChange={(event) => onChange(Number(event.currentTarget.value))}
      />
    </label>
  );
}
function ToggleField({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
}): JSX.Element {
  return (
    <label className={styles.toggle}>
      <input
        type="checkbox"
        checked={checked}
        onChange={(event) => onChange(event.currentTarget.checked)}
      />
      <span />
      <strong>{label}</strong>
    </label>
  );
}
function TileField({
  configuration,
  onChange,
}: {
  configuration: Extract<ProductRunConfiguration, { kind: 'dem' | 'ortho' }>;
  onChange: (configuration: ProductRunConfiguration) => void;
}): JSX.Element {
  return (
    <SelectField
      label="Tile size"
      value={configuration.tileSizePixels}
      onChange={(value) => onChange({ ...configuration, tileSizePixels: Number(value) as 512 })}
      options={[[512, '512 px · fixed COG/quadtree pyramid']]}
    />
  );
}

export function createDefaultBatch(): BatchPipelineFile {
  return {
    formatVersion: 1,
    name: 'Standard Photogrammetry',
    scope: { kind: 'all' },
    steps: [
      { kind: 'alignment', profile: 'qualityHybrid' },
      { kind: 'product', configuration: defaultProductConfiguration('dense') },
      { kind: 'product', configuration: defaultProductConfiguration('dem') },
      { kind: 'product', configuration: defaultProductConfiguration('ortho') },
    ],
  };
}

function normalizeSteps(steps: BatchPipelineStep[]): BatchPipelineStep[] {
  const rank = (step: BatchPipelineStep) =>
    step.kind === 'alignment' ? 0 : OPERATIONS.indexOf(step.configuration.kind) + 1;
  return [...steps].sort((left, right) => rank(left) - rank(right));
}
function stepKey(step: BatchPipelineStep): string {
  return step.kind === 'alignment' ? 'alignment' : step.configuration.kind;
}
function alignmentStep(
  steps: BatchPipelineStep[],
): Extract<BatchPipelineStep, { kind: 'alignment' }> | undefined {
  return steps.find(
    (step): step is Extract<BatchPipelineStep, { kind: 'alignment' }> => step.kind === 'alignment',
  );
}
function productStep(
  steps: BatchPipelineStep[],
  kind: ProductOperation,
): Extract<BatchPipelineStep, { kind: 'product' }> | undefined {
  return steps.find(
    (step): step is Extract<BatchPipelineStep, { kind: 'product' }> =>
      step.kind === 'product' && step.configuration.kind === kind,
  );
}
function isBatchPipelineFile(value: unknown): value is BatchPipelineFile {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<BatchPipelineFile>;
  return (
    candidate.formatVersion === 1 &&
    typeof candidate.name === 'string' &&
    Array.isArray(candidate.steps) &&
    candidate.steps.every((step) => isBatchStep(step)) &&
    (candidate.scope == null || isBatchPipelineScope(candidate.scope))
  );
}

function isBatchPipelineScope(value: unknown): value is BatchPipelineScope {
  if (!value || typeof value !== 'object') return false;
  const scope = value as Record<string, unknown>;
  if (scope.kind === 'all' || scope.kind === 'currentSelection') return true;
  return (
    scope.kind === 'processingSet' &&
    typeof scope.entityId === 'string' &&
    typeof scope.membershipSha256 === 'string'
  );
}

function processingSetScope(processingSet: ProcessingSetRecord): BatchPipelineScope {
  return {
    kind: 'processingSet',
    entityId: processingSet.entityId,
    membershipSha256: processingSet.membershipSha256,
  };
}

function scopeValue(scope: BatchPipelineScope | undefined): string {
  if (!scope || scope.kind === 'all') return 'all';
  if (scope.kind === 'currentSelection') return 'selection';
  return encodeProcessingSetValue(scope.entityId);
}
function isBatchStep(value: unknown): value is BatchPipelineStep {
  if (!value || typeof value !== 'object') return false;
  const step = value as Record<string, unknown>;
  if (step.kind === 'alignment')
    return (
      step.profile === 'qualityHybrid' ||
      step.profile === 'maximumRobustness' ||
      step.profile === 'fast'
    );
  if (step.kind !== 'product' || !step.configuration || typeof step.configuration !== 'object')
    return false;
  const operation = (step.configuration as { kind?: unknown }).kind;
  return typeof operation === 'string' && OPERATIONS.some((candidate) => candidate === operation);
}
function productLabel(operation: ProductOperation): string {
  return {
    depth: 'Depth Maps',
    dense: 'Dense Point Cloud',
    dem: 'DEM',
    ortho: 'Orthomosaic',
    mesh: 'Textured Mesh',
    splat: 'Gaussian Splat',
  }[operation];
}
function productDescription(operation: ProductOperation): string {
  return {
    depth: 'Depth maps per camera',
    dense: 'Fused measurable geometry',
    dem: 'DSM or DTM raster pyramid',
    ortho: 'Georeferenced map image',
    mesh: 'Tiled textured surface',
    splat: 'Photorealistic offline representation',
  }[operation];
}
