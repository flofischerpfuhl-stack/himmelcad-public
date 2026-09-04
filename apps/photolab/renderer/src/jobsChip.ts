import type { PhotolabJob } from '@himmelcad/data';

// X6 tunable: four seconds prevents a just-finished job from disappearing
// before the user can read its outcome without reserving permanent status space.
export const JOBS_CHIP_LINGER_MS = 4_000;

export type JobsChipTone = 'hidden' | 'progress' | 'warning' | 'danger' | 'success';

export interface JobsChipState {
  label: string;
  tone: JobsChipTone;
  count: number;
}

const ACTIVE_STATES = new Set<PhotolabJob['state']['kind']>([
  'queued',
  'running',
  'pauseRequested',
  'paused',
  'cancelRequested',
]);

export function jobsChipState(jobs: readonly PhotolabJob[], nowMs: number): JobsChipState {
  const failed = mostRecent(jobs.filter((job) => job.state.kind === 'failed'));
  if (failed) {
    return {
      label: `Job failed — ${jobDisplayLabel(failed)}`,
      tone: 'danger',
      count: 1,
    };
  }

  const active = jobs.filter((job) => ACTIVE_STATES.has(job.state.kind));
  if (active.some((job) => job.state.kind === 'cancelRequested')) {
    return { label: 'Cancelling…', tone: 'warning', count: active.length };
  }
  if (active.length === 1) {
    const job = active[0]!;
    const percent = progressPercent(job);
    return {
      label: `1 job running · ${jobDisplayLabel(job)}${percent == null ? '' : ` ${percent}%`}`,
      tone: 'progress',
      count: 1,
    };
  }
  if (active.length > 1) {
    return { label: `${active.length} jobs running`, tone: 'progress', count: active.length };
  }

  const recent = mostRecent(
    jobs.filter(
      (job) => job.finishedAtUnixMs != null && nowMs - job.finishedAtUnixMs <= JOBS_CHIP_LINGER_MS,
    ),
  );
  if (!recent) return { label: '', tone: 'hidden', count: 0 };
  if (recent.state.kind === 'cancelled') {
    return { label: `Job cancelled — ${jobDisplayLabel(recent)}`, tone: 'warning', count: 1 };
  }
  return { label: `Job completed — ${jobDisplayLabel(recent)}`, tone: 'success', count: 1 };
}

export function jobDisplayLabel(job: PhotolabJob): string {
  const labels: Record<PhotolabJob['kind'], string> = {
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
  return labels[job.kind];
}

function progressPercent(job: PhotolabJob): number | null {
  const total = job.progress.metrics.totalUnits;
  if (total == null || total <= 0) return null;
  const stageFraction = Math.min(1, job.progress.metrics.completedUnits / total);
  const overall =
    (job.progress.stage.index + stageFraction) / Math.max(1, job.progress.stage.stageCount);
  return Math.round(Math.min(1, overall) * 100);
}

function mostRecent(jobs: readonly PhotolabJob[]): PhotolabJob | undefined {
  return [...jobs].sort(
    (left, right) =>
      (right.finishedAtUnixMs ?? right.startedAtUnixMs ?? right.createdAtUnixMs) -
      (left.finishedAtUnixMs ?? left.startedAtUnixMs ?? left.createdAtUnixMs),
  )[0];
}
