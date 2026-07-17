import type {
  AlignmentQualityProfile,
  CameraCalibrationGroupRecord,
  CaptureGroupRecord,
  EntityId,
  ProcessingSetRecord,
  ResolvedAlignmentConfig,
} from '@himmelcad/data';

import styles from './AlignmentProfilePanel.module.css';
import { Select } from '@himmelcad/ui';

export interface AlignmentProfilePanelProps {
  profile: AlignmentQualityProfile;
  imageCount: number;
  totalImageCount: number;
  selectedImageCount: number;
  scopeCameraIds: readonly EntityId[];
  scope: 'all' | 'selection';
  processingSets: readonly ProcessingSetRecord[];
  captureGroups: readonly CaptureGroupRecord[];
  calibrationGroups: readonly CameraCalibrationGroupRecord[];
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
  onStart: () => void;
  onSaveProcessingSet: () => void;
  onReviewGroups: () => void;
}

const PROFILE_DESCRIPTION: Record<AlignmentQualityProfile, string> = {
  qualityHybrid: 'Independent neural and classical matching with quality-driven rescue.',
  maximumRobustness: 'Maximum pair coverage and feature budget, including DeDoDe.',
  fast: 'Fast matching with rescue only on diagnosed weak connections.',
};

export function AlignmentProfilePanel({
  profile,
  imageCount,
  totalImageCount,
  selectedImageCount,
  scopeCameraIds,
  scope,
  processingSets,
  captureGroups,
  calibrationGroups,
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
  onStart,
  onSaveProcessingSet,
  onReviewGroups,
}: AlignmentProfilePanelProps): JSX.Element {
  const scopeCameraSet = new Set(scopeCameraIds);
  const scopedCalibrationGroups = calibrationGroups.filter((group) =>
    group.cameraEntityIds.some((entityId) => scopeCameraSet.has(entityId)),
  );
  const coveredImageCount = new Set(
    scopedCalibrationGroups.flatMap((group) =>
      group.cameraEntityIds.filter((entityId) => scopeCameraSet.has(entityId)),
    ),
  ).size;
  const needsReviewCount = captureGroups.filter(
    (group) =>
      group.reviewStatus === 'needsReview' &&
      group.cameraEntityIds.some((entityId) => scopeCameraSet.has(entityId)),
  ).length;
  return (
    <div className={styles.root}>
      <section className={styles.section}>
        <div className={styles.sectionTitle}>Align Photos</div>
        <label className={styles.field}>
          <span>Input Scope</span>
          <Select
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
          </Select>
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
          <Select
            className={styles.control}
            value={profile}
            onChange={(event) =>
              onProfileChange(event.currentTarget.value as AlignmentQualityProfile)
            }
          >
            <option value="qualityHybrid">Quality Hybrid · recommended</option>
            <option value="maximumRobustness">Maximum Robustness</option>
            <option value="fast">Fast · adaptive rescue</option>
          </Select>
        </label>
        <div className={styles.hint}>{PROFILE_DESCRIPTION[profile]}</div>
      </section>

      <section className={styles.section} aria-label="Camera intrinsics sharing plan">
        <div className={styles.sectionTitle}>Camera intrinsics</div>
        <div className={styles.scopeSummary}>
          <strong>
            {scopedCalibrationGroups.length} intrinsics group
            {scopedCalibrationGroups.length === 1 ? '' : 's'} in this scope
          </strong>
          <span>
            {coveredImageCount} of {scopeCameraIds.length} scoped images covered
            {needsReviewCount > 0 ? ` · ${needsReviewCount} capture groups need review` : ''}
          </span>
        </div>
        {scopedCalibrationGroups.slice(0, 8).map((group) => (
          <ResolvedRow
            key={group.entityId}
            label={group.name}
            value={`${group.cameraEntityIds.filter((id) => scopeCameraSet.has(id)).length} images · ${group.groupingBasis}`}
          />
        ))}
        {scopedCalibrationGroups.length > 8 && (
          <div className={styles.hint}>{scopedCalibrationGroups.length - 8} more groups</div>
        )}
        <button className={styles.action} type="button" onClick={onReviewGroups}>
          {needsReviewCount > 0 ? 'Review detected groups' : 'Review groups'}
        </button>
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
      {needsReviewCount > 0 && (
        <div className={styles.error} role="alert">
          Confirm or replace the detected intrinsics groups before alignment. A landing or
          autofocus change must not share camera parameters implicitly.
        </div>
      )}
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
      <button
        className={styles.action}
        type="button"
        disabled={!canStart || needsReviewCount > 0 || resolving || starting}
        onClick={onStart}
      >
        {resolving
          ? 'Validating configuration…'
          : starting
            ? 'Validating and queueing…'
            : 'Start alignment'}
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
        {processingSet.captureGroupIds?.length ?? 0} capture groups ·{' '}
        {processingSet.calibrationGroupIds?.length ?? 0} calibration groups ·{' '}
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
