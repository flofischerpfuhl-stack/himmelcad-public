import type { PhotolabJob } from '@himmelcad/data';
import type { JobSurfaceItem } from '@himmelcad/ui';

const JOB_LABELS: Record<PhotolabJob['kind'], string> = {
  analyzeImageQuality: 'Analyze image quality',
  alignPhotos: 'Align photos',
  optimizeAlignment: 'Optimize alignment',
  mergeAlignments: 'Merge alignments',
  buildDepthMaps: 'Build depth maps',
  buildDensePointCloud: 'Build dense point cloud',
  buildDem: 'Build DEM',
  buildOrthomosaic: 'Build orthomosaic',
  buildMesh: 'Build textured mesh',
  buildGaussianSplat: 'Build Gaussian splat',
  exportProduct: 'Export product',
  batch: 'Batch processing',
  archiveSave: 'Save archive',
  imageInspection: 'Inspect images',
  imageCommit: 'Commit images',
  imageMask: 'Apply image masks',
  gcpOperation: 'GCP operation',
};

export function jobSurfaceItems(jobs: readonly PhotolabJob[]): JobSurfaceItem[] {
  return jobs.map((job) => ({
    id: job.id,
    label: jobDisplayLabel(job),
    state: surfaceState(job.state.kind),
    phase:
      job.state.kind === 'paused'
        ? 'Paused'
        : job.state.kind === 'pauseRequested'
          ? 'Pausing…'
          : job.progress.stage.label,
    fraction: overallFraction(job),
    registeredAtUnixMs: job.createdAtUnixMs,
    finishedAtUnixMs: job.finishedAtUnixMs ?? null,
    suppressChip: false,
    cancellation: {
      cancellable: ['queued', 'running', 'paused'].includes(job.state.kind),
      atNextSafeBoundary: job.origin === 'sideOperation',
    },
  }));
}

export function jobDisplayLabel(job: PhotolabJob): string {
  return JOB_LABELS[job.kind];
}

function surfaceState(state: PhotolabJob['state']['kind']): JobSurfaceItem['state'] {
  switch (state) {
    case 'queued':
      return 'pending-registration';
    case 'running':
    case 'paused':
    case 'pauseRequested':
      return 'running';
    case 'cancelRequested':
      return 'cancelling';
    case 'completed':
    case 'failed':
    case 'cancelled':
      return state;
  }
}

function overallFraction(job: PhotolabJob): number | null {
  const totalUnits = job.progress.metrics.totalUnits;
  if (totalUnits == null || totalUnits <= 0) return null;
  const stageFraction = Math.min(1, job.progress.metrics.completedUnits / totalUnits);
  return Math.min(
    1,
    (job.progress.stage.index + stageFraction) / Math.max(1, job.progress.stage.stageCount),
  );
}
