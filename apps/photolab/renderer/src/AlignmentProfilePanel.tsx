import type {
  AlignmentQualityProfile,
  EntityId,
  ProcessingSetRecord,
  ResolvedAlignmentConfig,
} from '@himmelcad/data';

import styles from './AlignmentProfilePanel.module.css';

export interface AlignmentProfilePanelProps {
  profile: AlignmentQualityProfile;
  imageCount: number;
  totalImageCount: number;
  selectedImageCount: number;
  scope: 'all' | 'selection';
  processingSets: readonly ProcessingSetRecord[];
  activeProcessingSetId: EntityId | null;
  resolving: boolean;
  starting: boolean;
  savingProcessingSet: boolean;
  canStart: boolean;
  resolved: ResolvedAlignmentConfig | null;
  error: string | null;
  onProfileChange: (profile: AlignmentQualityProfile) => void;
  onScopeChange: (scope: 'all' | 'selection') => void;
  onProcessingSetChange: (processingSetId: EntityId) => void;
  onResolve: () => void;
  onStart: () => void;
  onSaveProcessingSet: () => void;
}

const PROFILE_DESCRIPTION: Record<AlignmentQualityProfile, string> = {
  qualityHybrid:
    'ALIKED/LightGlue and SIFT/LightGlue independently match every candidate pair. Large backends are added where quality diagnostics require them.',
  maximumRobustness:
    'Extended pair graph, higher feature budgets, and DeDoDe on every candidate pair. Dense rescue remains active.',
  fast: 'ALIKED runs first; SIFT and large backends activate only for diagnosed weak edges.',
};

export function AlignmentProfilePanel({
  profile,
  imageCount,
  totalImageCount,
  selectedImageCount,
  scope,
  processingSets,
  activeProcessingSetId,
  resolving,
  starting,
  savingProcessingSet,
  canStart,
  resolved,
  error,
  onProfileChange,
  onScopeChange,
  onProcessingSetChange,
  onResolve,
  onStart,
  onSaveProcessingSet,
}: AlignmentProfilePanelProps): JSX.Element {
  return (
    <div className={styles.root}>
      <section className={styles.section}>
        <div className={styles.sectionTitle}>Align Photos</div>
        <label className={styles.field}>
          <span>Input Scope</span>
          <select
            className={styles.control}
            value={
              scope === 'selection' && activeProcessingSetId
                ? encodeProcessingSetValue(activeProcessingSetId)
                : scope
            }
            onChange={(event) => {
              const value = event.currentTarget.value;
              const processingSetId = decodeProcessingSetValue(value);
              if (processingSetId) onProcessingSetChange(processingSetId);
              else onScopeChange(value as 'all' | 'selection');
            }}
          >
            <option value="all">All images · {totalImageCount}</option>
            <option value="selection" disabled={selectedImageCount < 2}>
              Current selection · {selectedImageCount}
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
        {activeProcessingSetId && (
          <ProcessingSetSummary
            processingSet={
              processingSets.find((candidate) => candidate.entityId === activeProcessingSetId) ??
              null
            }
          />
        )}
        <label className={styles.field}>
          <span>Images</span>
          <input className={styles.control} type="number" value={imageCount} readOnly />
        </label>
        <label className={styles.field}>
          <span>Quality profile</span>
          <select
            className={styles.control}
            value={profile}
            onChange={(event) =>
              onProfileChange(event.currentTarget.value as AlignmentQualityProfile)
            }
          >
            <option value="qualityHybrid">Quality Hybrid · recommended</option>
            <option value="maximumRobustness">Maximum Robustness</option>
            <option value="fast">Fast · adaptive rescue</option>
          </select>
        </label>
        <div className={styles.hint}>{PROFILE_DESCRIPTION[profile]}</div>
        <div className={styles.offline}>● Fully offline · no runtime downloads</div>
      </section>

      {resolved && (
        <section className={styles.resolved} aria-label="Core-resolved configuration">
          <div className={styles.sectionTitle}>Core-validated plan</div>
          <ResolvedRow label="Sparse" value={resolved.sparseBackends.join(' + ')} />
          <ResolvedRow label="SIFT Scope" value={labelScope(resolved.siftScope)} />
          <ResolvedRow
            label="Large backend"
            value={`${resolved.largeBackend} · ${labelScope(resolved.largeBackendScope)}`}
          />
          <ResolvedRow label="Image edge" value={`${resolved.maxImageEdge.toLocaleString()} px`} />
          <ResolvedRow
            label="Features"
            value={`${resolved.keypointsPerMegapixel.toLocaleString()} / Mpx`}
          />
          <ResolvedRow
            label="Checkpoint"
            value={`${resolved.checkpointPairBlockSize} pair work units`}
          />
          <div className={styles.resolvedRow}>
            <span>Config Hash</span>
            <span className={styles.hash} title={resolved.configHash}>
              {resolved.configHash.slice(0, 16)}…
            </span>
          </div>
        </section>
      )}

      {error && <div className={styles.error}>{error}</div>}
      {scope === 'selection' && selectedImageCount >= 2 && (
        <button
          className={styles.action}
          type="button"
          disabled={savingProcessingSet}
          onClick={onSaveProcessingSet}
        >
          {savingProcessingSet ? 'Saving processing set…' : 'Save selection as processing set'}
        </button>
      )}
      <button className={styles.action} type="button" disabled={resolving} onClick={onResolve}>
        {resolving ? 'Core is validating…' : 'Freeze configuration'}
      </button>
      <button
        className={styles.action}
        type="button"
        disabled={!canStart || resolving || starting}
        onClick={onStart}
      >
        {starting ? 'Queueing job…' : 'Start photo alignment'}
      </button>
    </div>
  );
}

function ProcessingSetSummary({
  processingSet,
}: {
  processingSet: ProcessingSetRecord | null;
}): JSX.Element {
  if (!processingSet) return <></>;
  return (
    <div className={styles.scopeSummary}>
      <strong>{processingSet.name}</strong>
      <span>
        Immutable scope · {processingSet.cameraEntityIds.length} cameras ·{' '}
        <code title={processingSet.membershipSha256}>
          {processingSet.membershipSha256.slice(0, 12)}
        </code>
      </span>
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

function ResolvedRow({ label, value }: { label: string; value: string }): JSX.Element {
  return (
    <div className={styles.resolvedRow}>
      <span>{label}</span>
      <span>{value}</span>
    </div>
  );
}

function labelScope(scope: ResolvedAlignmentConfig['siftScope']): string {
  return scope === 'allCandidatePairs' ? 'all candidate pairs' : 'quality-driven';
}
