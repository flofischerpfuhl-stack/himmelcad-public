import type {
  AlignedGcpCameraRecord,
  EntityId,
  GcpOptimizationPublicationRecord,
  ImageQualityAnalysisRecord,
  PhotolabJob,
  ProcessingSetRecord,
  ProjectCameraImageRecord,
} from '@himmelcad/data';
import { Select } from '@himmelcad/ui';
import type { ReactNode } from 'react';
import { useEffect, useMemo, useState } from 'react';

import styles from './ProjectDiagnosticsPanel.module.css';

export type ProjectDiagnosticsKind =
  | 'images.metadata'
  | 'images.quality'
  | 'reference.transform'
  | 'alignment.report';

interface ProjectDiagnosticsPanelProps {
  kind: ProjectDiagnosticsKind;
  images: readonly ProjectCameraImageRecord[];
  imageQualityAnalyses: readonly ImageQualityAnalysisRecord[];
  alignedCameras: readonly AlignedGcpCameraRecord[];
  jobs: readonly PhotolabJob[];
  processingSets: readonly ProcessingSetRecord[];
  activeProcessingSetId: EntityId | null;
  projectTargetCrs: string | null;
  gcpOptimization: GcpOptimizationPublicationRecord | null;
  imageQualityStarting: boolean;
  onAnalyzeImageQuality: (processingSetId: EntityId | null) => void;
}

export function ProjectDiagnosticsPanel({
  kind,
  images,
  imageQualityAnalyses,
  alignedCameras,
  jobs,
  processingSets,
  activeProcessingSetId,
  projectTargetCrs,
  gcpOptimization,
  imageQualityStarting,
  onAnalyzeImageQuality,
}: ProjectDiagnosticsPanelProps): JSX.Element {
  if (kind === 'images.metadata') return <MetadataView images={images} />;
  if (kind === 'images.quality') {
    return (
      <ImageStatusView
        images={images}
        analyses={imageQualityAnalyses}
        jobs={jobs}
        processingSets={processingSets}
        activeProcessingSetId={activeProcessingSetId}
        starting={imageQualityStarting}
        onAnalyze={onAnalyzeImageQuality}
      />
    );
  }
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

function ImageStatusView({
  images,
  analyses,
  jobs,
  processingSets,
  activeProcessingSetId,
  starting,
  onAnalyze,
}: {
  images: readonly ProjectCameraImageRecord[];
  analyses: readonly ImageQualityAnalysisRecord[];
  jobs: readonly PhotolabJob[];
  processingSets: readonly ProcessingSetRecord[];
  activeProcessingSetId: EntityId | null;
  starting: boolean;
  onAnalyze: (processingSetId: EntityId | null) => void;
}): JSX.Element {
  const [scope, setScope] = useState<EntityId | 'all'>(activeProcessingSetId ?? 'all');
  useEffect(() => {
    if (activeProcessingSetId) setScope(activeProcessingSetId);
  }, [activeProcessingSetId]);
  const scopedImages = useMemo(() => {
    if (scope === 'all') return images;
    const members = new Set(
      processingSets.find((processingSet) => processingSet.entityId === scope)?.cameraEntityIds ?? [],
    );
    return images.filter((image) => members.has(image.entityId));
  }, [images, processingSets, scope]);
  const scopedAnalyses = useMemo(
    () =>
      analyses.filter((analysis) =>
        scope === 'all'
          ? analysis.processingSetId === undefined
          : analysis.processingSetId === scope,
      ),
    [analyses, scope],
  );
  const latestByImage = useMemo(() => {
    const records = new Map<EntityId, ImageQualityAnalysisRecord>();
    for (const analysis of scopedAnalyses) {
      const previous = records.get(analysis.imageEntityId);
      if (!previous || previous.analyzedAtUnixMs < analysis.analyzedAtUnixMs) {
        records.set(analysis.imageEntityId, analysis);
      }
    }
    return records;
  }, [scopedAnalyses]);
  const measured = [...latestByImage.values()].filter(
    (analysis) => analysis.outcome.status === 'measured',
  );
  const warned = measured.filter(
    (analysis) => analysis.outcome.status === 'measured' && analysis.outcome.warnings.length > 0,
  ).length;
  const unavailable = [...latestByImage.values()].filter(
    (analysis) => analysis.outcome.status === 'unavailable',
  ).length;
  const countStatus = (
    tag: ProjectCameraImageRecord['metadata']['statusTags'][number],
  ): number => scopedImages.filter((image) => image.metadata.statusTags.includes(tag)).length;
  const activeJob = [...jobs]
    .reverse()
    .find(
      (job) =>
        job.kind === 'analyzeImageQuality' &&
        ['queued', 'running', 'cancelRequested'].includes(job.state.kind),
    );
  const mean = (selector: (analysis: ImageQualityAnalysisRecord) => number): string => {
    if (measured.length === 0) return '—';
    return `${(
      (measured.reduce((sum, analysis) => sum + selector(analysis), 0) / measured.length) *
      100
    ).toFixed(2)}%`;
  };
  const rows: [string, string][] = scopedImages.slice(0, 500).map((image) => {
    const status =
      image.metadata.statusTags.length > 0 ? image.metadata.statusTags.join(' · ') : 'imported';
    const analysis = latestByImage.get(image.entityId);
    if (!analysis) return [image.name, `${status} · Not analyzed`];
    if (analysis.outcome.status === 'unavailable') {
      return [image.name, `${status} · Unavailable · ${analysis.outcome.reason}`];
    }
    const { metrics, warnings } = analysis.outcome;
    return [
      image.name,
      `${status} · Sharp ${metrics.laplacianVariance.toExponential(2)} · Blur indicator ${(metrics.directionalGradientCoherence * 100).toFixed(1)}% · Clip ${(metrics.shadowClippedFraction * 100).toFixed(1)}/${(metrics.highlightClippedFraction * 100).toFixed(1)}% · Texture ${metrics.textureEntropyBits.toFixed(2)} bit${warnings.length > 0 ? ` · ${warnings.length} flag${warnings.length === 1 ? '' : 's'}` : ''}`,
    ];
  });
  const total = activeJob?.progress.metrics.totalUnits;
  const completed = activeJob?.progress.metrics.completedUnits ?? 0;
  return (
    <PanelRoot
      title="Image status and measured quality"
      hint="Published status tags remain visible alongside metrics measured from decoded project pixels. Directional blur is a structure-tensor indicator, not a fabricated camera score."
    >
      <div className={styles.controls}>
        <label>
          <span>Scope</span>
          <Select
            value={scope}
            onChange={(event) =>
              setScope(
                event.currentTarget.value === 'all'
                  ? 'all'
                  : (event.currentTarget.value as EntityId),
              )
            }
          >
            <option value="all">All imported images · {images.length}</option>
            {processingSets.map((processingSet) => (
              <option key={processingSet.entityId} value={processingSet.entityId}>
                {processingSet.name} · {processingSet.cameraEntityIds.length}
              </option>
            ))}
          </Select>
        </label>
        <button
          type="button"
          disabled={starting || activeJob !== undefined || scopedImages.length === 0}
          onClick={() => onAnalyze(scope === 'all' ? null : scope)}
        >
          {starting ? 'Queuing…' : activeJob ? 'Analysis running' : 'Analyze images'}
        </button>
      </div>
      {activeJob && (
        <div className={styles.progress} role="status">
          <span>
            {activeJob.progress.stage.label} · {completed} / {total ?? '—'} images
          </span>
          <progress value={completed} max={total ?? Math.max(1, completed)} />
        </div>
      )}
      <MetricGrid
        values={[
          ['Aligned', countStatus('aligned')],
          ['Depth ready', countStatus('depthReady')],
          ['Status warnings', countStatus('qualityWarning')],
          ['Masked', countStatus('masked')],
        ]}
      />
      <MetricGrid
        values={[
          ['Analyzed', `${latestByImage.size} / ${scopedImages.length}`],
          ['Review flags', warned + unavailable],
          [
            'Shadow clipping',
            mean((analysis) =>
              analysis.outcome.status === 'measured'
                ? analysis.outcome.metrics.shadowClippedFraction
                : 0,
            ),
          ],
          [
            'Highlight clipping',
            mean((analysis) =>
              analysis.outcome.status === 'measured'
                ? analysis.outcome.metrics.highlightClippedFraction
                : 0,
            ),
          ],
        ]}
      />
      <List title="Per-image status and measurements" rows={rows} empty="No images in this scope." />
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
