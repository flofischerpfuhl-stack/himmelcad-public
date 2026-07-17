import type {
  AlignmentMergeConnection,
  AlignmentMergeCandidateRecord,
  EntityId,
  MergedAlignmentRunRecord,
  PublishedGcpOptimizationEntry,
} from '@himmelcad/data';
import { useEffect, useMemo, useState } from 'react';

import styles from './AlignmentMergePanel.module.css';
import {
  commonControlPointIds,
  compatibleGcpOptimizations,
  completeAlignmentConnections,
} from './alignmentMergeDraft.js';
import { Checkbox, Radio, Select } from '@himmelcad/ui';

export function AlignmentMergePanel({
  candidates,
  merges,
  gcpOptimizations,
  busy,
  onCreate,
  onStart,
}: {
  candidates: readonly AlignmentMergeCandidateRecord[];
  merges: readonly MergedAlignmentRunRecord[];
  gcpOptimizations: readonly PublishedGcpOptimizationEntry[];
  busy: boolean;
  onCreate: (
    name: string,
    alignmentIds: readonly EntityId[],
    optimizationIds: readonly EntityId[],
    connections: readonly AlignmentMergeConnection[],
  ) => void;
  onStart: (mergeEntityId: EntityId) => void;
}): JSX.Element {
  const [name, setName] = useState('');
  const [selected, setSelected] = useState<ReadonlySet<EntityId>>(new Set());
  const [selectedOptimizationIds, setSelectedOptimizationIds] = useState<
    Readonly<Record<string, EntityId>>
  >({});
  const [connectionMode, setConnectionMode] = useState<'overlap' | 'sharedControls'>('overlap');
  const selectedCandidates = useMemo(
    () => candidates.filter((candidate) => selected.has(candidate.entityId)),
    [candidates, selected],
  );
  useEffect(() => {
    setSelectedOptimizationIds((current) => {
      const next: Record<string, EntityId> = {};
      for (const candidate of selectedCandidates) {
        const compatible = compatibleGcpOptimizations(candidate.entityId, gcpOptimizations);
        const currentId = current[candidate.entityId];
        const selectedEntry = compatible.find((entry) => entry.entityId === currentId);
        const fallback = compatible.at(-1);
        if (selectedEntry ?? fallback)
          next[candidate.entityId] = (selectedEntry ?? fallback)!.entityId;
      }
      return next;
    });
  }, [gcpOptimizations, selectedCandidates]);
  const selectedOptimizations = useMemo(
    () =>
      selectedCandidates.flatMap((candidate) => {
        const entityId = selectedOptimizationIds[candidate.entityId];
        const entry = gcpOptimizations.find((candidateEntry) => candidateEntry.entityId === entityId);
        return entry ? [entry] : [];
      }),
    [gcpOptimizations, selectedCandidates, selectedOptimizationIds],
  );
  const commonControlIds = useMemo(
    () => commonControlPointIds(selectedOptimizations),
    [selectedOptimizations],
  );
  const sharedControlsReady =
    selectedCandidates.length >= 2 &&
    selectedOptimizations.length === selectedCandidates.length &&
    commonControlIds.length >= 3;
  return (
    <div className={styles.root}>
      <section className={styles.plan}>
        <div className={styles.sectionTitle}>New merge plan</div>
        <label className={styles.nameField}>
          <span>Name</span>
          <input
            value={name}
            placeholder={`Merged Alignment ${merges.length + 1}`}
            onChange={(event) => setName(event.currentTarget.value)}
          />
        </label>
        <div className={styles.candidates}>
          {candidates.map((candidate) => {
            const compatible = compatibleGcpOptimizations(candidate.entityId, gcpOptimizations);
            return (
              <div className={styles.candidateBlock} key={candidate.entityId}>
                <label>
                  <Checkbox
                    checked={selected.has(candidate.entityId)}
                    onChange={(event) =>
                      setSelected((current) => {
                        const next = new Set(current);
                        if (event.currentTarget.checked) next.add(candidate.entityId);
                        else next.delete(candidate.entityId);
                        return next;
                      })
                    }
                  />
                  <span>
                    <strong>{candidate.name}</strong>
                    <small>
                      {candidate.cameraEntityIds.length} cameras ·{' '}
                      {candidate.calibrationGroups?.length ??
                        candidate.calibrationGroupIds?.length ??
                        0}{' '}
                      frozen intrinsics groups
                    </small>
                  </span>
                </label>
                <details className={styles.lineageDetails}>
                  <summary>Alignment lineage</summary>
                  <small>Job {candidate.jobId}</small>
                  <small>
                    Processing set {candidate.processingSetId ?? 'ad-hoc / project-wide'}
                  </small>
                  {(candidate.calibrationGroups ?? []).map((group) => (
                    <small key={group.groupId}>
                      {group.groupId} · {group.cameraEntityIds.length} images
                    </small>
                  ))}
                </details>
                {connectionMode === 'sharedControls' && selected.has(candidate.entityId) && (
                  <label className={styles.optimizationField}>
                    <span>GCP revision</span>
                    <Select
                      value={selectedOptimizationIds[candidate.entityId] ?? ''}
                      onChange={(event) =>
                        setSelectedOptimizationIds((current) => ({
                          ...current,
                          [candidate.entityId]: event.currentTarget.value as EntityId,
                        }))
                      }
                    >
                      {compatible.length === 0 && <option value="">No converged revision</option>}
                      {compatible.map((entry) => (
                        <option key={entry.entityId} value={entry.entityId}>
                          {entry.optimization.operationId} · snapshot{' '}
                          {entry.optimization.snapshotSha256.slice(0, 12)}
                        </option>
                      ))}
                    </Select>
                  </label>
                )}
              </div>
            );
          })}
        </div>
        <fieldset className={styles.connectionMode}>
          <legend>Connection</legend>
          <label>
            <Radio
              name="alignment-merge-connection"
              checked={connectionMode === 'overlap'}
              onChange={() => setConnectionMode('overlap')}
            />
            <span>
              <strong>Image overlap</strong>
              <small>Cross-run tracks are measured by the joint solve.</small>
            </span>
          </label>
          <label>
            <Radio
              name="alignment-merge-connection"
              checked={connectionMode === 'sharedControls'}
              onChange={() => setConnectionMode('sharedControls')}
            />
            <span>
              <strong>Shared controls</strong>
              <small>
                {sharedControlsReady
                  ? `${commonControlIds.length} common controls in converged optimizations`
                  : 'Needs converged GCP optimizations with at least 3 common controls'}
              </small>
            </span>
          </label>
        </fieldset>
        <button
          type="button"
          disabled={
            busy ||
            selectedCandidates.length < 2 ||
            (connectionMode === 'sharedControls' && !sharedControlsReady)
          }
          onClick={() => {
            const alignmentIds = selectedCandidates.map((candidate) => candidate.entityId);
            const connections = completeAlignmentConnections(
              alignmentIds,
              connectionMode,
              commonControlIds,
            );
            onCreate(
              name.trim() || `Merged Alignment ${merges.length + 1}`,
              alignmentIds,
              connectionMode === 'sharedControls'
                ? selectedOptimizations.map((entry) => entry.entityId)
                : [],
              connections,
            );
            setName('');
            setSelected(new Set());
          }}
        >
          {busy
            ? 'Creating plan…'
            : connectionMode === 'sharedControls'
              ? 'Create shared-control merge plan'
              : 'Create overlap merge plan'}
        </button>
      </section>
      <section className={styles.runs}>
        <div className={styles.sectionTitle}>Merge runs</div>
        {merges.length === 0 ? (
          <p>No merge plans yet.</p>
        ) : (
          merges.map((merge) => (
            <article key={merge.entityId}>
              <div>
                <strong>{merge.name}</strong>
                <span className={merge.state === 'published' ? styles.published : styles.planned}>
                  {merge.state}
                </span>
              </div>
              <small>
                {merge.inputAlignmentEntityIds.length} alignments · {merge.cameraEntityIds.length}{' '}
                cameras
              </small>
              <details className={styles.lineageDetails}>
                <summary>Run lineage and connection evidence</summary>
                {merge.inputAlignmentEntityIds.map((entityId) => (
                  <small key={entityId}>Alignment · {entityId}</small>
                ))}
                {merge.inputGcpOptimizationEntityIds.map((entityId) => (
                  <small key={entityId}>GCP revision · {entityId}</small>
                ))}
                {merge.connections.map((connection) => (
                  <small key={`${connection.alignmentA}:${connection.alignmentB}`}>
                    {connection.alignmentA} ↔ {connection.alignmentB} ·{' '}
                    {connection.kind === 'overlap'
                      ? `${connection.verifiedCrossRunTrackCount} verified cross-run tracks`
                      : `${connection.controlPointIds.length} shared controls`}
                  </small>
                ))}
              </details>
              <code title={merge.lineageSha256}>{merge.lineageSha256.slice(0, 12)}</code>
              {merge.state === 'planned' && (
                <button type="button" disabled={busy} onClick={() => onStart(merge.entityId)}>
                  {busy ? 'Queueing…' : 'Run merge'}
                </button>
              )}
            </article>
          ))
        )}
      </section>
    </div>
  );
}
