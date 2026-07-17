import type { GcpCollectionRecord, GcpOptimizationPublicationRecord, GcpPoint } from '@himmelcad/data';

import styles from './ImagePropertiesPanel.module.css';

export function GcpPropertiesPanel({
  point,
  collection,
  optimization,
}: {
  point: GcpPoint;
  collection: GcpCollectionRecord;
  optimization: GcpOptimizationPublicationRecord | null;
}): JSX.Element {
  const observations = collection.observations.filter((item) => item.pointId === point.id);
  const residual = optimization?.artifact.result.residuals.find((item) => item.pointId === point.id);
  const manual = observations.filter((item) => item.state.state === 'manual').length;
  const predicted = observations.filter((item) => item.state.state === 'predicted').length;
  const blocked = observations.filter((item) => item.state.state === 'blocked').length;
  return (
    <div className={styles.root}>
      <section>
        <h3>Project coordinates</h3>
        <Row label="Easting (X)" value={`${format(point.coordinate.eastMeters)} m`} />
        <Row label="Northing (Y)" value={`${format(point.coordinate.northMeters)} m`} />
        <Row label="Height (Z)" value={`${format(point.coordinate.heightMeters)} m`} />
      </section>
      <section>
        <h3>Survey use</h3>
        <Row label="Role" value={roleLabel(point.role)} />
        <Row label="Components" value={componentLabel(point.role)} />
        <Row label="Horizontal σ" value={`${format(point.uncertainty.horizontalStddevMeters)} m`} />
        <Row label="Height σ" value={`${format(point.uncertainty.heightStddevMeters)} m`} />
      </section>
      <section>
        <h3>Image observations</h3>
        <Row label="Total" value={String(observations.length)} />
        <Row label="Manual" value={String(manual)} />
        <Row label="Predicted" value={String(predicted)} />
        <Row label="Blocked" value={String(blocked)} />
      </section>
      <section>
        <h3>Latest residual</h3>
        <Row label="East" value={metric(residual?.eastMeters)} />
        <Row label="North" value={metric(residual?.northMeters)} />
        <Row label="Height" value={metric(residual?.heightMeters)} />
        <Row label="Horizontal" value={metric(residual?.horizontalMeters)} />
        <Row label="3D" value={metric(residual?.spatial3dMeters)} />
        <Row label="Pixel RMS" value={residual ? `${residual.reprojectionRmsPixels.toFixed(3)} px` : '—'} />
      </section>
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }): JSX.Element {
  return <div className={styles.row}><span>{label}</span><strong title={value}>{value}</strong></div>;
}

function format(value: number): string {
  return value.toLocaleString('en-US', { minimumFractionDigits: 3, maximumFractionDigits: 4 });
}

function metric(value: number | undefined): string {
  return value == null ? '—' : `${(value * 1000).toFixed(2)} mm`;
}

function roleLabel(role: GcpPoint['role']): string {
  if (role === 'disabled') return 'Disabled';
  return role.startsWith('checkpoint') ? 'Checkpoint' : 'Control';
}

function componentLabel(role: GcpPoint['role']): string {
  if (role.endsWith('Xyz')) return 'XYZ';
  if (role.endsWith('Xy')) return 'XY';
  if (role.endsWith('Z')) return 'Z';
  return 'None';
}
