import type { GcpCollectionRecord, GcpRole } from '@himmelcad/data';
import { CheckCircle2, CircleGauge, Info, Shuffle } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';

import styles from './GcpOptimizationPanel.module.css';

export interface GcpOptimizationSelection {
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
  collection: GcpCollectionRecord | null;
  cameras: readonly GcpOptimizationCameraReference[];
  busy: boolean;
  onStart: (selection: GcpOptimizationSelection) => void;
}

export function GcpOptimizationPanel({
  collection,
  cameras,
  busy,
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
  const [included, setIncluded] = useState<Set<string>>(new Set());
  const [roles, setRoles] = useState<Record<string, GcpRole>>({});
  const [cameraReferences, setCameraReferences] = useState<Set<number>>(new Set());

  useEffect(() => {
    const usable = points.filter((point) => (observationCounts.get(point.id) ?? 0) >= 2);
    const nextRoles = Object.fromEntries(usable.map((point) => [point.id, point.role])) as Record<
      string,
      GcpRole
    >;
    if (!usable.some((point) => point.role.startsWith('checkpoint')) && usable.length >= 5) {
      for (const id of spatialCheckpointIds(usable)) {
        nextRoles[id] = asCheckpoint(nextRoles[id] ?? 'controlXyz');
      }
    }
    setIncluded(
      new Set(usable.filter((point) => point.role !== 'disabled').map((point) => point.id)),
    );
    setRoles(nextRoles);
  }, [observationCounts, points]);

  useEffect(() => setCameraReferences(new Set()), [cameras]);

  const selected = points.filter((point) => included.has(point.id));
  const controls = selected.filter((point) =>
    (roles[point.id] ?? point.role).startsWith('control'),
  );
  const checkpoints = selected.filter((point) =>
    (roles[point.id] ?? point.role).startsWith('checkpoint'),
  );
  const canStart = controls.length > 0 && selected.length > 0 && !busy;

  return (
    <div className={styles.root}>
      <section className={styles.intro}>
        <CircleGauge size={18} />
        <div>
          <strong>GCP-assisted alignment</strong>
          <p>
            Every selection is stored as an immutable snapshot. Camera reference positions are
            excluded from optimization by default.
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

      {points.length === 0 ? (
        <div className={styles.empty}>
          Import GCPs first and measure each one in at least two images.
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
                  <input
                    type="checkbox"
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
                <select
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
                </select>
              </div>
            );
          })}
        </div>
      )}

      <div className={styles.hint}>
        <Shuffle size={14} />
        <span>Spatially distributed points are suggested when no checkpoints are assigned.</span>
      </div>
      <details>
        <summary>Camera reference priors · none selected by default</summary>
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
                <input
                  type="checkbox"
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
            pointIds: selected.map((point) => point.id),
            roleOverrides: Object.fromEntries(
              selected.map((point) => [point.id, roles[point.id] ?? point.role]),
            ),
            cameraReferenceImageIds: [...cameraReferences].sort((left, right) => left - right),
          })
        }
      >
        <CheckCircle2 size={16} />
        {busy ? 'Starting optimization…' : 'Create snapshot and optimize'}
      </button>
    </div>
  );
}

function asCheckpoint(role: GcpRole): GcpRole {
  if (role === 'controlXy') return 'checkpointXy';
  if (role === 'controlZ') return 'checkpointZ';
  return 'checkpointXyz';
}

function spatialCheckpointIds(points: GcpCollectionRecord['points'][number]['point'][]): string[] {
  const target = Math.max(1, Math.min(10, Math.round(points.length * 0.2)));
  const sorted = [...points].sort(
    (left, right) =>
      left.coordinate.eastMeters - right.coordinate.eastMeters ||
      left.coordinate.northMeters - right.coordinate.northMeters ||
      left.coordinate.heightMeters - right.coordinate.heightMeters ||
      left.id.localeCompare(right.id),
  );
  if (target === 1) return [sorted[Math.floor(sorted.length / 2)]?.id ?? ''].filter(Boolean);
  return Array.from(
    { length: target },
    (_, index) => sorted[Math.round((index * (sorted.length - 1)) / (target - 1))]?.id,
  ).filter((id): id is string => id != null);
}
