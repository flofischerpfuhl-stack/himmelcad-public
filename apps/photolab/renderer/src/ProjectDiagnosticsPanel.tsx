import type {
  AlignedGcpCameraRecord,
  GcpOptimizationPublicationRecord,
  PhotolabJob,
  ProjectCameraImageRecord,
} from '@himmelcad/data';
import type { ReactNode } from 'react';

import styles from './ProjectDiagnosticsPanel.module.css';

export type ProjectDiagnosticsKind =
  | 'images.metadata'
  | 'images.quality'
  | 'reference.transform'
  | 'alignment.report';

interface ProjectDiagnosticsPanelProps {
  kind: ProjectDiagnosticsKind;
  images: readonly ProjectCameraImageRecord[];
  alignedCameras: readonly AlignedGcpCameraRecord[];
  jobs: readonly PhotolabJob[];
  projectTargetCrs: string | null;
  gcpOptimization: GcpOptimizationPublicationRecord | null;
}

export function ProjectDiagnosticsPanel({
  kind,
  images,
  alignedCameras,
  jobs,
  projectTargetCrs,
  gcpOptimization,
}: ProjectDiagnosticsPanelProps): JSX.Element {
  if (kind === 'images.metadata') return <MetadataView images={images} />;
  if (kind === 'images.quality') return <ImageStatusView images={images} />;
  if (kind === 'reference.transform') {
    return <ReferenceView images={images} projectTargetCrs={projectTargetCrs} />;
  }
  return (
    <AlignmentReportView
      images={images}
      alignedCameras={alignedCameras}
      jobs={jobs}
      gcpOptimization={gcpOptimization}
    />
  );
}

function MetadataView({ images }: { images: readonly ProjectCameraImageRecord[] }): JSX.Element {
  const withGps = images.filter((image) => image.metadata.inspectedPhoto.metadata.exif.gps).length;
  const withRtk = images.filter((image) => image.metadata.statusTags.includes('rtkFixed')).length;
  const calibrated = images.filter(
    (image) =>
      image.metadata.inspectedPhoto.metadata.djiXmp.calibratedFocalLengthPixels !== undefined,
  ).length;
  const cameras = new Map<string, number>();
  for (const image of images) {
    const exif = image.metadata.inspectedPhoto.metadata.exif;
    const key =
      [exif.make, exif.model, exif.lensModel].filter(Boolean).join(' · ') || 'Unknown camera';
    cameras.set(key, (cameras.get(key) ?? 0) + 1);
  }
  return (
    <PanelRoot
      title="Imported camera metadata"
      hint="Metadata is copied into the project and remains immutable for reproducible processing."
    >
      <MetricGrid
        values={[
          ['Images', images.length],
          ['GPS', withGps],
          ['RTK fixed', withRtk],
          ['DJI calibration', calibrated],
        ]}
      />
      <List
        title="Camera and lens groups"
        rows={[...cameras].map(([label, count]) => [label, `${count}`])}
      />
    </PanelRoot>
  );
}

function ImageStatusView({ images }: { images: readonly ProjectCameraImageRecord[] }): JSX.Element {
  const count = (tag: ProjectCameraImageRecord['metadata']['statusTags'][number]): number =>
    images.filter((image) => image.metadata.statusTags.includes(tag)).length;
  const rows: [string, string][] = images
    .slice(0, 200)
    .map((image) => [
      image.name,
      image.metadata.statusTags.length > 0 ? image.metadata.statusTags.join(' · ') : 'imported',
    ]);
  return (
    <PanelRoot
      title="Processing readiness"
      hint="Status tags describe published project products. Alignment and depth tags are scoped and become stale when their inputs change."
    >
      <MetricGrid
        values={[
          ['Aligned', count('aligned')],
          ['Depth ready', count('depthReady')],
          ['Warnings', count('qualityWarning')],
          ['Masked', count('masked')],
        ]}
      />
      <List title="Per-image state" rows={rows} empty="No images imported." />
    </PanelRoot>
  );
}

function ReferenceView({
  images,
  projectTargetCrs,
}: {
  images: readonly ProjectCameraImageRecord[];
  projectTargetCrs: string | null;
}): JSX.Element {
  const transformed = images.filter((image) => image.metadata.projectedReference).length;
  const decisions = new Set(
    images
      .map((image) => image.metadata.projectedReference?.transformationDecisionSha256)
      .filter((hash): hash is NonNullable<typeof hash> => hash !== undefined),
  );
  return (
    <PanelRoot
      title="Project reference frame"
      hint="PhotoLab never reprojects silently. Horizontal and vertical operations, grids, and geoids are frozen during import."
    >
      <KeyValue label="Target CRS" value={projectTargetCrs ?? 'Not established'} />
      <KeyValue label="Referenced images" value={`${transformed} / ${images.length}`} />
      <KeyValue label="Frozen transformations" value={`${decisions.size}`} />
      <p className={styles.note}>
        Import additional images through Images. Their source WGS 84 coordinates will open the
        horizontal and vertical transformation workflow before commit.
      </p>
    </PanelRoot>
  );
}

function AlignmentReportView({
  images,
  alignedCameras,
  jobs,
  gcpOptimization,
}: {
  images: readonly ProjectCameraImageRecord[];
  alignedCameras: readonly AlignedGcpCameraRecord[];
  jobs: readonly PhotolabJob[];
  gcpOptimization: GcpOptimizationPublicationRecord | null;
}): JSX.Element {
  const alignmentJobs = jobs.filter(
    (job) => job.kind === 'alignPhotos' || job.kind === 'optimizeAlignment',
  );
  const latest = alignmentJobs.at(-1);
  return (
    <PanelRoot
      title="Alignment report"
      hint="The report always refers to the currently active alignment or processing set."
    >
      <MetricGrid
        values={[
          ['Imported', images.length],
          ['Aligned', alignedCameras.length],
          [
            'Alignment ratio',
            images.length === 0
              ? '—'
              : `${((alignedCameras.length / images.length) * 100).toFixed(1)}%`,
          ],
          ['GCP optimized', gcpOptimization ? 'Yes' : 'No'],
        ]}
      />
      <KeyValue label="Latest state" value={latest?.state.kind ?? 'No alignment run'} />
      <KeyValue label="Configuration" value={latest?.configHash.slice(0, 16) ?? '—'} mono />
      <KeyValue label="Input" value={latest?.inputHash.slice(0, 16) ?? '—'} mono />
      <KeyValue label="Checkpoint" value={latest?.lastCheckpointSequence?.toString() ?? '—'} />
    </PanelRoot>
  );
}

function PanelRoot({
  title,
  hint,
  children,
}: {
  title: string;
  hint: string;
  children: ReactNode;
}): JSX.Element {
  return (
    <section className={styles.root}>
      <div>
        <h3>{title}</h3>
        <p className={styles.hint}>{hint}</p>
      </div>
      {children}
    </section>
  );
}

function MetricGrid({
  values,
}: {
  values: readonly (readonly [string, string | number])[];
}): JSX.Element {
  return (
    <div className={styles.metrics}>
      {values.map(([label, value]) => (
        <div className={styles.metric} key={label}>
          <span>{label}</span>
          <strong>{value}</strong>
        </div>
      ))}
    </div>
  );
}

function KeyValue({
  label,
  value,
  mono = false,
}: {
  label: string;
  value: string;
  mono?: boolean;
}): JSX.Element {
  return (
    <div className={styles.keyValue}>
      <span>{label}</span>
      <strong className={mono ? styles.mono : undefined}>{value}</strong>
    </div>
  );
}

function List({
  title,
  rows,
  empty = 'No matching metadata.',
}: {
  title: string;
  rows: readonly (readonly [string, string])[];
  empty?: string;
}): JSX.Element {
  return (
    <section className={styles.list}>
      <h4>{title}</h4>
      {rows.length === 0 ? (
        <p className={styles.note}>{empty}</p>
      ) : (
        rows.map(([label, value], index) => (
          <div className={styles.listRow} key={`${label}-${index}`}>
            <span title={label}>{label}</span>
            <strong>{value}</strong>
          </div>
        ))
      )}
    </section>
  );
}
