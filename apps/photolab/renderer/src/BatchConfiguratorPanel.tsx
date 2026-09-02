import type {
  EntityId,
  ObjectHash,
  PhotolabJob,
  ProcessingSetRecord,
  PublishedGcpOptimizationEntry,
} from '@himmelcad/data';
import { FileDown, FileUp, Play, RotateCcw, Workflow } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import {
  alignmentPresetReferenceFromKey,
  alignmentPresetReferenceKey,
  builtInAlignmentPresetReference,
  FACTORY_ALIGNMENT_PRESETS,
  type AlignmentPresetReference,
} from './alignmentPreset.js';
import {
  BATCH_PIPELINE_FORMAT_VERSION,
  BATCH_PIPELINE_SCHEMA,
  decodeBatchProcessingSetValue,
  encodeBatchProcessingSetValue,
  loadBatchPipeline,
  type BatchPipelineFile,
  type BatchPipelineScope,
  type BatchRecipePipelineStep,
} from './batchRecipe.js';
import styles from './BatchConfiguratorPanel.module.css';
import {
  defaultProductConfiguration,
  type ProductOperation,
  type ProductRunConfiguration,
} from './ProductPanel.js';
import { ExpandChevron, Checkbox, Select } from '@himmelcad/ui';

export type BatchPipelineStep = BatchRecipePipelineStep;

export interface BatchArtifactCandidate {
  entityId: EntityId;
  label: string;
  kind: 'dem';
  versionHash: ObjectHash;
}

interface BatchConfiguratorPanelProps {
  busy: boolean;
  canStart: boolean;
  allCameraIds: readonly EntityId[];
  selectedCameraIds: readonly EntityId[];
  processingSets: readonly ProcessingSetRecord[];
  activeProcessingSetId: EntityId | null;
  gcpOptimizations: readonly PublishedGcpOptimizationEntry[];
  artifacts: readonly BatchArtifactCandidate[];
  jobs: readonly PhotolabJob[];
  focusQueue: boolean;
  localMetric: boolean;
  onActivateProcessingSet: (processingSetId: EntityId) => void;
  onClearProcessingSet: () => void;
  onStart: (
    steps: BatchPipelineStep[],
    cameraEntityIds: readonly EntityId[],
    scopeLabel: string,
  ) => void;
  onPreview: (steps: readonly BatchPipelineStep[]) => void;
  onOpenJobs: () => void;
  onError: (message: string) => void;
}

const OPERATIONS: readonly ProductOperation[] = ['depth', 'dense', 'dem', 'ortho', 'mesh', 'splat'];

export function BatchConfiguratorPanel({
  busy,
  canStart,
  allCameraIds,
  selectedCameraIds,
  processingSets,
  activeProcessingSetId,
  gcpOptimizations,
  artifacts,
  jobs,
  focusQueue,
  localMetric,
  onActivateProcessingSet,
  onClearProcessingSet,
  onStart,
  onPreview,
  onOpenJobs,
  onError,
}: BatchConfiguratorPanelProps): JSX.Element {
  const [file, setFile] = useState<BatchPipelineFile>(createDefaultBatch);
  const [expanded, setExpanded] = useState<string | null>('alignment');
  const [batchError, setBatchError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [userPresets, setUserPresets] = useState<Array<{ name: string; path: string }>>([]);
  const queueSectionRef = useRef<HTMLElement | null>(null);
  const scope = scopeValue(file.scope);
  const enabledKinds = useMemo(() => new Set(file.steps.map(stepKey)), [file.steps]);
  const selectedAlignmentReference = alignmentStep(file.steps)?.preset;
  const selectedAlignmentKey = alignmentPresetReferenceKey(
    selectedAlignmentReference ?? builtInAlignmentPresetReference('qualityHybrid'),
  );
  const unlistedUserPreset =
    selectedAlignmentReference?.source === 'userFile' &&
    !userPresets.some((item) => item.path === selectedAlignmentReference.path)
      ? selectedAlignmentReference
      : null;
  const selectedProcessingSet = useMemo(() => {
    const configuredScope = file.scope;
    if (configuredScope?.kind !== 'processingSet') return undefined;
    return processingSets.find(
      (candidate) =>
        candidate.entityId === configuredScope.entityId &&
        candidate.membershipSha256 === configuredScope.membershipSha256,
    );
  }, [file.scope, processingSets]);
  const convergedGcpOptimizations = useMemo(
    () =>
      gcpOptimizations
        .filter((entry) => entry.optimization.artifact.result.converged)
        .sort(
          (left, right) =>
            left.optimization.publicationSequence - right.optimization.publicationSequence ||
            left.entityId.localeCompare(right.entityId),
        ),
    [gcpOptimizations],
  );
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

  const refreshPresets = useCallback(async (): Promise<void> => {
    try {
      setUserPresets((await window.himmelcad?.alignmentPresets.list()) ?? []);
    } catch (error) {
      setBatchError(error instanceof Error ? error.message : String(error));
      setUserPresets([]);
    }
  }, []);

  useEffect(() => {
    void refreshPresets();
  }, [refreshPresets]);

  useEffect(() => {
    if (!activeProcessingSetId) return;
    const processingSet = processingSets.find(
      (candidate) => candidate.entityId === activeProcessingSetId,
    );
    if (!processingSet) return;
    setFile((current) => ({ ...current, scope: processingSetScope(processingSet) }));
  }, [activeProcessingSetId, processingSets]);

  useEffect(() => {
    if (!focusQueue) return;
    queueSectionRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, [focusQueue]);

  const toggle = (key: string, enabled: boolean) => {
    setFile((current) => {
      if (!enabled) {
        return {
          ...current,
          steps: normalizeSteps(current.steps.filter((step) => stepKey(step) !== key)),
        };
      }
      const next = [...current.steps];
      if (key === 'alignment')
        next.push({ kind: 'alignment', preset: builtInAlignmentPresetReference('qualityHybrid') });
      else
        next.push({
          kind: 'product',
          configuration: defaultProductConfiguration(key as ProductOperation),
        });
      return { ...current, steps: normalizeSteps(next) };
    });
  };

  const updateAlignment = (preset: AlignmentPresetReference) => {
    setFile((current) => ({
      ...current,
      steps: current.steps.map((step) => (step.kind === 'alignment' ? { ...step, preset } : step)),
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

  const updateProductGcp = (
    operation: ProductOperation,
    gcpOptimizationEntityId: EntityId | null | undefined,
  ) => {
    setFile((current) => ({
      ...current,
      steps: current.steps.map((step) =>
        step.kind === 'product' && step.configuration.kind === operation
          ? gcpOptimizationEntityId === undefined
            ? omitProductGcpSelection(step)
            : { ...step, gcpOptimizationEntityId }
          : step,
      ),
    }));
  };

  const load = async () => {
    setBatchError(null);
    setNotice(null);
    try {
      const loaded = await window.himmelcad?.batch.load<unknown>();
      if (loaded == null) return;
      const migration = loadBatchPipeline(loaded);
      if (!migration) throw new Error('The batch file does not use a supported PhotoLab format.');
      for (const profile of migration.migratedProfiles) {
        console.info(
          `[PhotoLab] Loaded a legacy batch alignment profile and mapped it to the built-in ${profile} preset.`,
        );
      }
      const normalized: BatchPipelineFile = {
        ...migration.file,
        steps: normalizeSteps(migration.file.steps),
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
      setNotice(migration.notices.join(' · ') || null);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setBatchError(message);
      onError(message);
    }
  };

  const save = async () => {
    setBatchError(null);
    setNotice(null);
    try {
      await window.himmelcad?.batch.save(file);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setBatchError(message);
      onError(message);
    }
  };

  return (
    <div className={styles.root}>
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
        <Select
          value={scope}
          disabled={busy}
          onChange={(event) => {
            const value = event.currentTarget.value;
            setBatchError(null);
            const processingSetId = decodeBatchProcessingSetValue(value);
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
                  value={encodeBatchProcessingSetValue(processingSet.entityId)}
                >
                  {processingSet.name} · {processingSet.cameraEntityIds.length}
                </option>
              ))}
            </optgroup>
          )}
        </Select>
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
      {notice && (
        <div className={styles.notice} role="status">
          {notice}
        </div>
      )}

      <div className={styles.toolbar}>
        <button type="button" disabled={busy} onClick={() => void load()}>
          <FileUp size={14} /> Load
        </button>
        <button type="button" disabled={busy} onClick={() => void save()}>
          <FileDown size={14} /> Save
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={() => {
            setFile(createDefaultBatch());
            setBatchError(null);
            setNotice(null);
            onClearProcessingSet();
          }}
        >
          <RotateCcw size={14} /> Defaults
        </button>
        <button
          type="button"
          disabled={file.steps.length === 0}
          onClick={() => onPreview(file.steps)}
        >
          <Workflow size={14} /> Pipeline preview
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
            <span>Preset</span>
            <Select
              value={selectedAlignmentKey}
              onChange={(event) =>
                updateAlignment(alignmentPresetReferenceFromKey(event.currentTarget.value))
              }
            >
              <optgroup label="Built-in presets">
                {FACTORY_ALIGNMENT_PRESETS.map((item) => (
                  <option key={item.path} value={item.path}>
                    {item.preset.name} · Built-in
                  </option>
                ))}
              </optgroup>
              {(userPresets.length > 0 || unlistedUserPreset) && (
                <optgroup label="User presets">
                  {unlistedUserPreset && (
                    <option value={unlistedUserPreset.path}>Referenced user preset</option>
                  )}
                  {userPresets.map((item) => (
                    <option key={item.path} value={item.path}>
                      {item.name}
                    </option>
                  ))}
                </optgroup>
              )}
            </Select>
          </label>
        </BatchCard>

        <UnavailableBatchCard label="GCP optimization" />

        {OPERATIONS.map((operation) => {
          const step = productStep(file.steps, operation);
          const configuration = step?.configuration ?? defaultProductConfiguration(operation);
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
              <GcpOptimizationField
                entries={convergedGcpOptimizations}
                localMetric={localMetric}
                value={step?.gcpOptimizationEntityId}
                onChange={(value) => updateProductGcp(operation, value)}
              />
              {configuration.kind === 'ortho' && (
                <ExternalDemField
                  configuration={configuration}
                  artifacts={artifacts}
                  onChange={updateProduct}
                />
              )}
              <ProductBatchFields configuration={configuration} onChange={updateProduct} />
            </BatchCard>
          );
        })}
        {(['Export', 'Report'] as const).map((label) => (
          <UnavailableBatchCard key={label} label={label} />
        ))}
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

      <BatchQueueSection
        sectionRef={queueSectionRef}
        jobs={jobs.filter((job) => job.kind === 'batch')}
        onOpenJobs={onOpenJobs}
      />
    </div>
  );
}

function ExternalDemField({
  configuration,
  artifacts,
  onChange,
}: {
  configuration: Extract<ProductRunConfiguration, { kind: 'ortho' }>;
  artifacts: readonly BatchArtifactCandidate[];
  onChange: (configuration: ProductRunConfiguration) => void;
}): JSX.Element {
  const referencedArtifact = artifacts.find(
    (artifact) =>
      artifact.entityId === configuration.sourceDemEntityId &&
      artifact.versionHash === configuration.sourceDemVersionSha256,
  );
  const hasUnavailableReference = Boolean(configuration.sourceDemEntityId && !referencedArtifact);
  return (
    <label className={styles.field}>
      <span>External DEM</span>
      <Select
        value={referencedArtifact?.entityId ?? (hasUnavailableReference ? 'unavailable' : '')}
        onChange={(event) => {
          const artifact = artifacts.find(
            (candidate) => candidate.entityId === event.currentTarget.value,
          );
          if (artifact) {
            onChange({
              ...configuration,
              sourceDemEntityId: artifact.entityId,
              sourceDemVersionSha256: artifact.versionHash,
            });
            return;
          }
          const {
            sourceDemEntityId: _entityId,
            sourceDemVersionSha256: _versionHash,
            ...withoutBinding
          } = configuration;
          onChange(withoutBinding);
        }}
      >
        <option value="">Use a DEM built by this pipeline</option>
        {hasUnavailableReference && (
          <option value="unavailable" disabled>
            Referenced DEM is unavailable
          </option>
        )}
        {artifacts.map((artifact) => (
          <option key={artifact.entityId} value={artifact.entityId}>
            {artifact.label} · {artifact.versionHash.slice(0, 10)}
          </option>
        ))}
      </Select>
    </label>
  );
}

function UnavailableBatchCard({ label }: { label: string }): JSX.Element {
  return (
    <section className={`${styles.card} ${styles.unavailableCard}`} aria-disabled="true">
      <div className={styles.cardHeader}>
        <span className={styles.placeholderCheck} aria-hidden="true" />
        <div className={styles.unavailableContent}>
          <strong>{label}</strong>
          <small>Available with the next release — see plan WP-C6b</small>
        </div>
      </div>
    </section>
  );
}

function BatchQueueSection({
  sectionRef,
  jobs,
  onOpenJobs,
}: {
  sectionRef: React.RefObject<HTMLElement | null>;
  jobs: readonly PhotolabJob[];
  onOpenJobs: () => void;
}): JSX.Element {
  const orderedJobs = [...jobs].sort(
    (left, right) =>
      right.createdAtUnixMs - left.createdAtUnixMs || right.id.localeCompare(left.id),
  );
  return (
    <section ref={sectionRef} className={styles.queueSection} tabIndex={-1}>
      <div className={styles.queueHeader}>
        <div>
          <strong>Queued / running batches</strong>
          <span>
            {orderedJobs.length === 0 ? 'No batch jobs yet' : `${orderedJobs.length} batch jobs`}
          </span>
        </div>
        <button type="button" onClick={onOpenJobs}>
          Open Jobs tab
        </button>
      </div>
      {orderedJobs.length > 0 && (
        <ul className={styles.queueList}>
          {orderedJobs.map((job) => (
            <li key={job.id}>
              <code title={job.id}>{job.id.slice(0, 18)}</code>
              <span>{batchJobStateLabel(job)}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function batchJobStateLabel(job: PhotolabJob): string {
  if (job.state.kind === 'failed') return `Failed · ${job.state.code}`;
  return {
    queued: 'Queued',
    running: 'Running',
    pauseRequested: 'Pause requested',
    paused: 'Paused',
    cancelRequested: 'Cancellation requested',
    cancelled: 'Cancelled',
    completed: 'Completed',
  }[job.state.kind];
}

function omitProductGcpSelection(
  step: Extract<BatchPipelineStep, { kind: 'product' }>,
): Extract<BatchPipelineStep, { kind: 'product' }> {
  const { gcpOptimizationEntityId: _selection, ...rest } = step;
  return rest;
}

function GcpOptimizationField({
  entries,
  localMetric,
  value,
  onChange,
}: {
  entries: readonly PublishedGcpOptimizationEntry[];
  localMetric: boolean;
  value: EntityId | null | undefined;
  onChange: (value: EntityId | null | undefined) => void;
}): JSX.Element {
  const latest = entries.at(-1);
  return (
    <label className={styles.field}>
      <span>GCP optimization</span>
      <Select
        value={value === undefined ? 'latest' : value === null ? 'none' : `revision:${value}`}
        onChange={(event) => {
          const selected = event.currentTarget.value;
          onChange(
            selected === 'latest'
              ? undefined
              : selected === 'none'
                ? null
                : (selected.slice('revision:'.length) as EntityId),
          );
        }}
      >
        <option value="latest">
          {latest
            ? `Latest converged — ${latest.optimization.operationId} · ${latest.optimization.snapshotSha256.slice(0, 8)}`
            : 'Latest converged — none available'}
        </option>
        {entries.map((entry) => (
          <option key={entry.entityId} value={`revision:${entry.entityId}`}>
            {entry.optimization.operationId} · {entry.optimization.snapshotSha256.slice(0, 8)}
          </option>
        ))}
        {localMetric && <option value="none">None (unreferenced)</option>}
      </Select>
    </label>
  );
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
          <Checkbox
            checked={enabled}
            disabled={disabled}
            onChange={(event) => onToggle(event.currentTarget.checked)}
          />
          <span />
        </label>
        <button type="button" className={styles.expand} disabled={!enabled} onClick={onExpand}>
          <ExpandChevron expanded={expanded} size={14} />
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
      <Select value={value} onChange={(event) => onChange(event.currentTarget.value)}>
        {options.map(([key, text]) => (
          <option key={key} value={key}>
            {text}
          </option>
        ))}
      </Select>
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
      <Checkbox checked={checked} onChange={(event) => onChange(event.currentTarget.checked)} />
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
    schema: BATCH_PIPELINE_SCHEMA,
    formatVersion: BATCH_PIPELINE_FORMAT_VERSION,
    name: 'Standard Photogrammetry',
    scope: { kind: 'all' },
    steps: [
      { kind: 'alignment', preset: builtInAlignmentPresetReference('qualityHybrid') },
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
  return encodeBatchProcessingSetValue(scope.entityId);
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
    splat: 'Photorealistic scene representation',
  }[operation];
}
