import type {
  AlignmentMergeConnection,
  AlignmentMergeCandidateRecord,
  AlignmentMergePreflightResult,
  AlignmentMergeProfileSnapshot,
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
import {
  formatAlignmentLineageLabel,
  formatGcpRevisionLineageLabel,
} from './alignmentMergeLineage.js';
import {
  DEFAULT_FACTORY_ALIGNMENT_PRESET,
  FACTORY_ALIGNMENT_PRESETS,
  factoryAlignmentPresetByPath,
  parseAlignmentPreset,
  type AlignmentPresetFile,
} from './alignmentPreset.js';
import { Checkbox, Radio, Select } from '@himmelcad/ui';

interface UserPresetListItem {
  name: string;
  path: string;
}

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
    mergeProfile: AlignmentMergeProfileSnapshot,
  ) => void;
  onStart: (mergeEntityId: EntityId) => void;
}): JSX.Element {
  const [name, setName] = useState('');
  const [selected, setSelected] = useState<ReadonlySet<EntityId>>(new Set());
  const [selectedOptimizationIds, setSelectedOptimizationIds] = useState<
    Readonly<Record<string, EntityId>>
  >({});
  const [connectionMode, setConnectionMode] = useState<'overlap' | 'sharedControls'>('overlap');
  const [mergePreset, setMergePreset] = useState<AlignmentPresetFile>(
    DEFAULT_FACTORY_ALIGNMENT_PRESET.preset,
  );
  const [mergePresetPath, setMergePresetPath] = useState(DEFAULT_FACTORY_ALIGNMENT_PRESET.path);
  const [userPresets, setUserPresets] = useState<UserPresetListItem[]>([]);
  const [presetError, setPresetError] = useState<string | null>(null);
  const [preflight, setPreflight] = useState<AlignmentMergePreflightResult | null>(null);
  const [preflightBusy, setPreflightBusy] = useState(false);
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
        const entry = gcpOptimizations.find(
          (candidateEntry) => candidateEntry.entityId === entityId,
        );
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
  const selectedAlignmentIds = useMemo(
    () => selectedCandidates.map((candidate) => candidate.entityId).sort(),
    [selectedCandidates],
  );

  useEffect(() => {
    let cancelled = false;
    void window.himmelcad?.alignmentPresets
      .list()
      .then((items) => {
        if (!cancelled) setUserPresets(items);
      })
      .catch((error: unknown) => {
        if (!cancelled) setPresetError(error instanceof Error ? error.message : String(error));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (connectionMode !== 'overlap' || selectedAlignmentIds.length < 2) {
      setPreflight(null);
      setPreflightBusy(false);
      return;
    }
    let cancelled = false;
    setPreflight(null);
    setPreflightBusy(true);
    void window.himmelcad?.sidecar
      .call<AlignmentMergePreflightResult>('photolab.alignmentMerge.preflight', {
        inputEntityIds: selectedAlignmentIds,
      })
      .then((result) => {
        if (!cancelled) setPreflight(result);
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setPreflight({
            schemaVersion: 1,
            inputEntityIds: [...selectedAlignmentIds],
            available: false,
            lowOverlap: false,
            message: error instanceof Error ? error.message : String(error),
          });
        }
      })
      .finally(() => {
        if (!cancelled) setPreflightBusy(false);
      });
    return () => {
      cancelled = true;
    };
  }, [connectionMode, selectedAlignmentIds]);

  const selectMergePreset = async (path: string): Promise<void> => {
    const factory = factoryAlignmentPresetByPath(path);
    if (factory) {
      setMergePreset(factory.preset);
      setMergePresetPath(factory.path);
      setPresetError(null);
      return;
    }
    try {
      const result = await window.himmelcad?.alignmentPresets.loadPath(path);
      if (!result) return;
      const parsed = parseAlignmentPreset(result.preset);
      if (!parsed.ok) throw new Error(parsed.errors.join('\n'));
      setMergePreset(parsed.preset);
      setMergePresetPath(result.path);
      setPresetError(null);
    } catch (error) {
      setPresetError(error instanceof Error ? error.message : String(error));
    }
  };
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
        <label className={styles.nameField}>
          <span>Preset</span>
          <Select
            value={mergePresetPath}
            onChange={(event) => void selectMergePreset(event.currentTarget.value)}
          >
            <optgroup label="Built-in presets">
              {FACTORY_ALIGNMENT_PRESETS.map((item) => (
                <option key={item.path} value={item.path}>
                  {item.preset.name} · Built-in
                </option>
              ))}
            </optgroup>
            {userPresets.length > 0 && (
              <optgroup label="User presets">
                {userPresets.map((item) => (
                  <option key={item.path} value={item.path}>
                    {item.name}
                  </option>
                ))}
              </optgroup>
            )}
          </Select>
        </label>
        <small className={styles.presetSummary}>
          {mergePreset.name} · frozen into this merge plan
        </small>
        {presetError && (
          <div className={styles.error} role="alert">
            {presetError}
          </div>
        )}
        <div className={styles.candidates}>
          {candidates.map((candidate) => {
            const compatible = compatibleGcpOptimizations(candidate.entityId, gcpOptimizations);
            return (
              <div className={styles.candidateBlock} key={candidate.entityId}>
                <label>
                  <Checkbox
                    aria-label={`Merge ${candidate.name}`}
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
                        <option key={entry.entityId} value={entry.entityId} title={entry.entityId}>
                          {formatGcpRevisionLineageLabel(entry.entityId, compatible).text}
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
              aria-label="Image overlap"
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
              aria-label="Shared controls"
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
        {connectionMode === 'overlap' && (
          <>
            <div className={styles.preflight} role="status">
              {preflightBusy
                ? 'Estimating overlap…'
                : preflight?.available
                  ? `≈${preflight.candidateCrossRunPairCount ?? 0} candidate cross-run pairs`
                  : selectedAlignmentIds.length >= 2
                    ? (preflight?.message ?? 'Overlap cannot be estimated without camera positions')
                    : 'Select at least two alignments to estimate overlap.'}
            </div>
            {preflight?.lowOverlap && (
              <div className={styles.warningChip} role="note">
                Low overlap — the joint solve may fail to connect these missions
              </div>
            )}
            <div className={styles.warningChip} role="note">
              Overlap merges solve in an arbitrary frame — run GCP optimization on the merged result
              before building georeferenced products.
            </div>
          </>
        )}
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
              {
                id: mergePreset.id,
                name: mergePreset.name,
                profile: mergePreset.profile,
                overrides: mergePreset.overrides,
              },
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
              <div className={styles.runHeader}>
                <strong>{merge.name}</strong>
                <span className={merge.state === 'published' ? styles.published : styles.planned}>
                  {merge.state}
                </span>
              </div>
              <small>
                {merge.inputAlignmentEntityIds.length} alignments · {merge.cameraEntityIds.length}{' '}
                cameras
              </small>
              <small>
                Merge preset · {merge.mergeProfile?.name ?? 'Quality Hybrid (legacy default)'}
              </small>
              {merge.connections.some((connection) => connection.kind === 'overlap') && (
                <div className={styles.warningChip} role="note">
                  Overlap merges solve in an arbitrary frame — run GCP optimization on the merged
                  result before building georeferenced products.
                </div>
              )}
              <details className={styles.lineageDetails}>
                <summary>Run lineage and connection evidence</summary>
                {merge.inputAlignmentEntityIds.map((entityId) => {
                  const label = formatAlignmentLineageLabel(entityId, candidates);
                  return (
                    <small key={entityId} title={label.title}>
                      Alignment · {label.text}
                    </small>
                  );
                })}
                {merge.inputGcpOptimizationEntityIds.map((entityId) => {
                  const label = formatGcpRevisionLineageLabel(entityId, gcpOptimizations);
                  return (
                    <small key={entityId} title={label.title}>
                      GCP revision · {label.text}
                    </small>
                  );
                })}
                {merge.connections.map((connection) => (
                  <small
                    key={`${connection.alignmentA}:${connection.alignmentB}`}
                    title={`${connection.alignmentA} ↔ ${connection.alignmentB}`}
                  >
                    {formatAlignmentLineageLabel(connection.alignmentA, candidates).text} ↔{' '}
                    {formatAlignmentLineageLabel(connection.alignmentB, candidates).text} ·{' '}
                    {connection.kind === 'overlap'
                      ? `${connection.verifiedCrossRunTrackCount} verified cross-run tracks`
                      : `${connection.controlPointIds.length} shared controls`}
                  </small>
                ))}
              </details>
              {merge.state === 'published' && (
                <ConnectionEvidenceTable merge={merge} candidates={candidates} />
              )}
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

function ConnectionEvidenceTable({
  merge,
  candidates,
}: {
  merge: MergedAlignmentRunRecord;
  candidates: readonly AlignmentMergeCandidateRecord[];
}): JSX.Element {
  return (
    <div className={styles.evidenceBlock}>
      <strong>Connection evidence</strong>
      <table className={styles.evidenceTable}>
        <thead>
          <tr>
            <th>Connection</th>
            <th>Method</th>
            <th>Tracks</th>
            <th>RMS</th>
            <th>Control misclosure E / N / H</th>
          </tr>
        </thead>
        <tbody>
          {merge.connections.map((connection, index) => {
            const evidence = merge.connectionEvidence?.find(
              (item) => item.connectionIndex === index,
            );
            const left = formatAlignmentLineageLabel(connection.alignmentA, candidates);
            const right = formatAlignmentLineageLabel(connection.alignmentB, candidates);
            return (
              <tr key={`${connection.alignmentA}:${connection.alignmentB}`}>
                <td title={`${connection.alignmentA} ↔ ${connection.alignmentB}`}>
                  {left.text} ↔ {right.text}
                </td>
                <td>{connection.kind === 'overlap' ? 'Overlap' : 'Shared controls'}</td>
                <td>{evidence?.kind === 'overlap' ? evidence.crossRunTrackCount : '—'}</td>
                <td>
                  {evidence?.crossRunReprojectionRmsPx == null
                    ? '—'
                    : `${evidence.crossRunReprojectionRmsPx.toFixed(3)} px`}
                </td>
                <td>
                  {evidence?.controlMisclosure
                    ? `${evidence.controlMisclosure.east.toFixed(4)} / ${evidence.controlMisclosure.north.toFixed(4)} / ${evidence.controlMisclosure.height.toFixed(4)} m · ${evidence.controlMisclosure.count} controls`
                    : '—'}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
