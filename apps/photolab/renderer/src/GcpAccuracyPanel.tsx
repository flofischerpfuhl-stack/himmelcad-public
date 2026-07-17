import { EmptyState } from '@himmelcad/ui';
import { AlertTriangle, CheckCircle2 } from 'lucide-react';

import styles from './GcpAccuracyPanel.module.css';

export type GcpAccuracyRole =
  | 'controlXyz'
  | 'controlXy'
  | 'controlZ'
  | 'checkpointXyz'
  | 'checkpointXy'
  | 'checkpointZ';

export interface GcpAccuracyResidual {
  pointId: string;
  pointName: string;
  role: GcpAccuracyRole;
  eastMeters?: number;
  northMeters?: number;
  heightMeters?: number;
  horizontalMeters?: number;
  spatial3dMeters?: number;
  activeComponentNormMeters: number;
  reprojectionRmsPixels: number;
  reprojectionMaxPixels: number;
  observationCount: number;
}

export interface GcpAccuracyStatistics {
  pointCount: number;
  eastRmsMeters?: number;
  northRmsMeters?: number;
  horizontalRmsMeters?: number;
  heightRmsMeters?: number;
  spatial3dRmsMeters?: number;
  activeComponentRmsMeters: number;
  reprojectionRmsPixels: number;
  maxActiveComponentMeters: number;
  maxReprojectionPixels: number;
}

export interface GcpAccuracyReport {
  label: string;
  processingSetLabel: string;
  alignmentRunLabel: string;
  optimizationSnapshotSha256: string;
  cameraCount: number;
  residuals: readonly GcpAccuracyResidual[];
  control?: GcpAccuracyStatistics;
  checkpoint?: GcpAccuracyStatistics;
}

export interface GcpAccuracyPanelProps {
  report: GcpAccuracyReport | null;
  selectedPointId?: string;
  onSelectPoint?: (pointId: string) => void;
}

/** Accuracy table bound to one immutable processing/alignment/GCP scope. */
export function GcpAccuracyPanel({
  report,
  selectedPointId,
  onSelectPoint,
}: GcpAccuracyPanelProps): JSX.Element {
  if (!report) {
    return (
      <EmptyState
        title="No accuracy report yet"
        hint="Run GCP optimization after measuring each active control in at least two images. Residuals and RMS then appear here."
      />
    );
  }
  return (
    <section className={styles.root} aria-label="GCP accuracy">
      <header className={styles.scope}>
        <div>
          <strong>{report.label}</strong>
          <span>
            {report.processingSetLabel} › {report.alignmentRunLabel} › {report.cameraCount} cameras
          </span>
        </div>
        <code title={report.optimizationSnapshotSha256}>
          Snapshot {report.optimizationSnapshotSha256.slice(0, 12)}
        </code>
      </header>
      <div className={styles.summaryGrid}>
        <SummaryCard kind="control" statistics={report.control} />
        <SummaryCard kind="checkpoint" statistics={report.checkpoint} />
      </div>
      <div className={styles.tableScroll}>
        <table className={styles.table}>
          <thead>
            <tr>
              <th>Point</th>
              <th>Role</th>
              <th className={styles.numeric}>East</th>
              <th className={styles.numeric}>North</th>
              <th className={styles.numeric}>Height</th>
              <th className={styles.numeric}>Horizontal</th>
              <th className={styles.numeric}>3D</th>
              <th className={styles.numeric}>Image RMS</th>
              <th className={styles.numeric}>Max image</th>
              <th className={styles.numeric}>Measurements</th>
            </tr>
          </thead>
          <tbody>
            {report.residuals.map((residual) => (
              <tr
                key={residual.pointId}
                className={selectedPointId === residual.pointId ? styles.selectedRow : undefined}
                onClick={() => onSelectPoint?.(residual.pointId)}
              >
                <td>
                  <strong>{residual.pointName}</strong>
                  <small>{residual.pointId}</small>
                </td>
                <td>
                  <RoleBadge role={residual.role} />
                </td>
                <Metric value={residual.eastMeters} unit="m" signed />
                <Metric value={residual.northMeters} unit="m" signed />
                <Metric value={residual.heightMeters} unit="m" signed />
                <Metric value={residual.horizontalMeters} unit="m" />
                <Metric value={residual.spatial3dMeters} unit="m" />
                <Metric value={residual.reprojectionRmsPixels} unit="px" />
                <Metric value={residual.reprojectionMaxPixels} unit="px" />
                <td className={styles.numeric}>{residual.observationCount}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function SummaryCard({
  kind,
  statistics,
}: {
  kind: 'control' | 'checkpoint';
  statistics: GcpAccuracyStatistics | undefined;
}): JSX.Element {
  const label = kind === 'control' ? 'Control Points' : 'Checkpoints';
  if (!statistics) {
    return (
      <article className={styles.summaryDisabled}>
        <AlertTriangle size={16} />
        <div>
          <strong>{label}</strong>
          <span>Not included in snapshot</span>
        </div>
      </article>
    );
  }
  return (
    <article className={styles.summary}>
      <CheckCircle2 size={16} />
      <div className={styles.summaryContent}>
        <div className={styles.summaryTitle}>
          <strong>{label}</strong>
          <span>{statistics.pointCount} points</span>
        </div>
        <dl>
          <SummaryMetric label="E RMS" value={statistics.eastRmsMeters} unit="m" />
          <SummaryMetric label="N RMS" value={statistics.northRmsMeters} unit="m" />
          <SummaryMetric label="H RMS" value={statistics.heightRmsMeters} unit="m" />
          <SummaryMetric label="3D RMS" value={statistics.spatial3dRmsMeters} unit="m" />
          <SummaryMetric label="Image RMS" value={statistics.reprojectionRmsPixels} unit="px" />
          <SummaryMetric label="Max active" value={statistics.maxActiveComponentMeters} unit="m" />
        </dl>
      </div>
    </article>
  );
}

function SummaryMetric({
  label,
  value,
  unit,
}: {
  label: string;
  value: number | undefined;
  unit: string;
}): JSX.Element {
  return (
    <div>
      <dt>{label}</dt>
      <dd>{formatMetric(value, unit)}</dd>
    </div>
  );
}

function RoleBadge({ role }: { role: GcpAccuracyRole }): JSX.Element {
  const checkpoint = role.startsWith('checkpoint');
  const mask = role.endsWith('Xyz') ? 'XYZ' : role.endsWith('Xy') ? 'XY' : 'Z';
  return (
    <span className={`${styles.role} ${checkpoint ? styles.checkpoint : styles.control}`}>
      {checkpoint ? 'Check' : 'Control'} · {mask}
    </span>
  );
}

function Metric({
  value,
  unit,
  signed = false,
}: {
  value: number | undefined;
  unit: string;
  signed?: boolean;
}): JSX.Element {
  return <td className={styles.numeric}>{formatMetric(value, unit, signed)}</td>;
}

function formatMetric(value: number | undefined, unit: string, signed = false): string {
  if (value == null) return '—';
  const prefix = signed && value > 0 ? '+' : '';
  const digits = unit === 'px' ? 2 : Math.abs(value) < 0.1 ? 4 : 3;
  return `${prefix}${value.toLocaleString('en-US', {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  })} ${unit}`;
}
