import type { GcpCollectionRecord, GcpRole } from '@himmelcad/data';
import { Checkbox, Select } from '@himmelcad/ui';
import { CheckCircle2, CircleGauge, Info, Shuffle } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';

import { spatialCheckpointIds } from './gcpCheckpointSuggestion.js';
import styles from './GcpOptimizationPanel.module.css';

export interface GcpOptimizationSelection {
  sourceAlignmentEntityId: string;
  pointIds: string[];
  roleOverrides: Record<string, GcpRole>;
  cameraReferenceImageIds: number[];
}

export interface GcpOptimizationCameraReference {
  imageId: number;
  name: string;
  referenceAvailable: boolean;
  accuracyLabel: string;
}

export interface GcpOptimizationPanelProps {
  alignments: readonly { id: string; label: string }[];
  selectedAlignmentId: string;
  collection: GcpCollectionRecord | null;
  cameras: readonly GcpOptimizationCameraReference[];
  busy: boolean;
  onAlignmentChange: (id: string) => void;
  onStart: (selection: GcpOptimizationSelection) => void;
}

export function GcpOptimizationPanel({
  alignments,
  selectedAlignmentId,
  collection,
  cameras,
  busy,
  onAlignmentChange,
  onStart,
}: GcpOptimizationPanelProps): JSX.Element {
  const points = useMemo(
    () => collection?.points.map((record) => record.point) ?? [],
    [collection],
  );
  const observationCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const observation of collection?.observations ?? []) {
      if (observation.state.state !== 'blocked' && observation.state.state !== 'predicted') {
        counts.set(observation.pointId, (counts.get(observation.pointId) ?? 0) + 1);
      }
    }
    return counts;
  }, [collection]);
  const usable = useMemo(
    () => points.filter((point) => (observationCounts.get(point.id) ?? 0) >= 2),
    [observationCounts, points],
  );
  const importedRoles = useMemo(
    () =>
      Object.fromEntries(usable.map((point) => [point.id, point.role])) as Record<string, GcpRole>,
    [usable],
  );
  const [included, setIncluded] = useState<Set<string>>(new Set());
  const [roles, setRoles] = useState<Record<string, GcpRole>>({});
  const [cameraReferences, setCameraReferences] = useState<Set<number>>(new Set());

  useEffect(() => {
    setIncluded(
      new Set(usable.filter((point) => point.role !== 'disabled').map((point) => point.id)),
    );
    setRoles(importedRoles);
  }, [importedRoles, usable]);

  useEffect(
    () =>
      setCameraReferences(
        points.length === 0
          ? new Set(
              cameras.filter((camera) => camera.referenceAvailable).map((camera) => camera.imageId),
            )
          : new Set(),
      ),
    [cameras, points.length],
  );

  const selected = points.filter((point) => included.has(point.id));
  const controls = selected.filter((point) =>
    (roles[point.id] ?? point.role).startsWith('control'),
  );
  const checkpoints = selected.filter((point) =>
    (roles[point.id] ?? point.role).startsWith('checkpoint'),
  );
  const suggestedCheckpointIds = usable.some((point) =>
    (roles[point.id] ?? point.role).startsWith('checkpoint'),
  )
    ? []
    : spatialCheckpointIds(usable);
  const rolesChanged = usable.some((point) => (roles[point.id] ?? point.role) !== point.role);
  const cameraOnly = controls.length === 0 && cameraReferences.size >= 3;
  const canStart =
    !busy &&
    selectedAlignmentId.length > 0 &&
    ((controls.length > 0 && selected.length > 0) || cameraReferences.size >= 3);

  return (
    <div className={styles.root}>
      <label className={styles.alignmentField}>
        <span>Alignment</span>
        <Select
          value={selectedAlignmentId}
          disabled={busy || alignments.length === 0}
          onChange={(event) => onAlignmentChange(event.currentTarget.value)}
        >
          {alignments.length === 0 && <option value="">No published alignments</option>}
          {alignments.map((alignment) => (
            <option key={alignment.id} value={alignment.id}>
              {alignment.label}
            </option>
          ))}
        </Select>
      </label>
      <section className={styles.intro}>
        <CircleGauge size={18} />
        <div>
          <strong>Alignment optimization</strong>
          <p>
            Every selection is stored as an immutable snapshot. Without GCPs, all valid camera
            reference positions are included automatically and weighted by their uncertainty.
          </p>
        </div>
      </section>

      <div className={styles.summary}>
        <span>
          <b>{controls.length}</b> Control
        </span>
        <span>
          <b>{checkpoints.length}</b> Checkpoints
        </span>
        <span>
          <b>{selected.length}</b> active
        </span>
        <span>
          <b>{cameraReferences.size}</b> camera priors
        </span>
      </div>

      {suggestedCheckpointIds.length > 0 && (
        <div className={styles.suggestion}>
          <Shuffle size={14} />
          <span>
            No check points assigned — suggest {suggestedCheckpointIds.length} spatially
            distributed?
          </span>
          <button
            type="button"
            disabled={busy}
            onClick={() =>
              setRoles((previous) => {
                const next = { ...previous };
                for (const id of suggestedCheckpointIds) {
                  next[id] = asCheckpoint(next[id] ?? importedRoles[id] ?? 'controlXyz');
                }
                return next;
              })
            }
          >
            Apply
          </button>
        </div>
      )}
      {rolesChanged && (
        <div className={styles.revertRow}>
          <span>Role assignments differ from the imported set.</span>
          <button type="button" disabled={busy} onClick={() => setRoles(importedRoles)}>
            Revert
          </button>
        </div>
      )}

      {points.length === 0 ? (
        <div className={styles.empty}>
          {cameraReferences.size >= 3
            ? 'No GCPs loaded · camera references will anchor the optimization.'
            : 'Import GCPs or provide at least three positioned images.'}
        </div>
      ) : (
        <div className={styles.table}>
          <div className={styles.tableHeader}>
            <span>Active</span>
            <span>Point</span>
            <span>Measurements</span>
            <span>Use</span>
          </div>
          {points.map((point) => {
            const count = observationCounts.get(point.id) ?? 0;
            const usable = count >= 2;
            return (
              <div className={`${styles.row} ${!usable ? styles.disabled : ''}`} key={point.id}>
                <label className={styles.check}>
                  <Checkbox
                    aria-label={`Include ${point.name} in GCP optimization`}
                    checked={included.has(point.id)}
                    disabled={!usable || busy}
                    onChange={(event) => {
                      setIncluded((previous) => {
                        const next = new Set(previous);
                        if (event.target.checked) next.add(point.id);
                        else next.delete(point.id);
                        return next;
                      });
                    }}
                  />
                  <span />
                </label>
                <span className={styles.point}>
                  <strong>{point.name}</strong>
                  <small>{point.id}</small>
                </span>
                <span className={styles.count}>{count}</span>
                <Select
                  value={roles[point.id] ?? point.role}
                  disabled={!usable || busy}
                  onChange={(event) =>
                    setRoles((previous) => ({
                      ...previous,
                      [point.id]: event.target.value as GcpRole,
                    }))
                  }
                >
                  <option value="controlXyz">Control · horizontal + height</option>
                  <option value="controlXy">Control · horizontal only</option>
                  <option value="controlZ">Control · height only</option>
                  <option value="checkpointXyz">Checkpoint · horizontal + height</option>
                  <option value="checkpointXy">Checkpoint · horizontal only</option>
                  <option value="checkpointZ">Checkpoint · height only</option>
                  <option value="disabled">Do not use</option>
                </Select>
              </div>
            );
          })}
        </div>
      )}

      <details>
        <summary>
          Camera reference priors ·{' '}
          {points.length === 0 ? 'all valid selected automatically' : 'none selected by default'}
        </summary>
        <div className={styles.table}>
          <div className={styles.tableHeader}>
            <span>Use</span>
            <span>Image</span>
            <span>Reference</span>
            <span>Accuracy</span>
          </div>
          {cameras.map((camera) => (
            <div
              className={`${styles.row} ${!camera.referenceAvailable ? styles.disabled : ''}`}
              key={camera.imageId}
            >
              <label className={styles.check}>
                <Checkbox
                  aria-label={`Use ${camera.name} camera reference`}
                  checked={cameraReferences.has(camera.imageId)}
                  disabled={!camera.referenceAvailable || busy}
                  onChange={(event) => {
                    setCameraReferences((previous) => {
                      const next = new Set(previous);
                      if (event.target.checked) next.add(camera.imageId);
                      else next.delete(camera.imageId);
                      return next;
                    });
                  }}
                />
                <span />
              </label>
              <span className={styles.point}>
                <strong>{camera.name}</strong>
                <small>Image {camera.imageId}</small>
              </span>
              <span>{camera.referenceAvailable ? 'Projected GPS/RTK' : 'Unavailable'}</span>
              <span>{camera.accuracyLabel}</span>
            </div>
          ))}
        </div>
      </details>
      <div className={styles.hint}>
        <Info size={14} />
        <span>Only points with at least two green/orange image measurements can be activated.</span>
      </div>
      <button
        type="button"
        className={styles.start}
        disabled={!canStart}
        onClick={() =>
          onStart({
            sourceAlignmentEntityId: selectedAlignmentId,
            pointIds: cameraOnly ? [] : selected.map((point) => point.id),
            roleOverrides: Object.fromEntries(
              selected.map((point) => [point.id, roles[point.id] ?? point.role]),
            ),
            cameraReferenceImageIds: [...cameraReferences].sort((left, right) => left - right),
          })
        }
      >
        <CheckCircle2 size={16} />
        {busy
          ? 'Starting optimization…'
          : cameraOnly
            ? 'Optimize with camera references'
            : 'Create snapshot and optimize'}
      </button>
    </div>
  );
}

function asCheckpoint(role: GcpRole): GcpRole {
  if (role === 'controlXy') return 'checkpointXy';
  if (role === 'controlZ') return 'checkpointZ';
  return 'checkpointXyz';
}
