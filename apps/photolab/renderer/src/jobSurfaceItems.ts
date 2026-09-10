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
      job.state.kind === 'failed' &&
      ['alignmentNeedsUntiledExtraction', 'workerToolchainMissing'].includes(job.state.code)
        ? [job.state.message, memoryStatusText(job)].filter(Boolean).join(' · ')
        : job.state.kind === 'paused'
          ? 'Paused'
          : job.state.kind === 'pauseRequested'
            ? 'Pausing…'
            : [job.progress.stage.label, memoryStatusText(job)].filter(Boolean).join(' · '),
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

export function memoryStatusText(job: PhotolabJob): string | null {
  const memory = job.memory;
  if (!memory) return null;
  const parts = (memory.timeFirstChoices ?? []).map(
    (choice) =>
      `extraction tiled into ${choice.tiles.toLocaleString('en-US')} tiles with ${choice.overlapPx.toLocaleString('en-US')} px overlap`,
  );
  parts.push(
    ...memory.degradations.map((degradation) => {
      if (degradation.kind === 'extractionEdgeReduced') {
        return `extraction edge reduced ${degradation.from} px to ${degradation.to} px`;
      }
      if (degradation.kind === 'workerMemoryLimitHit') {
        return `worker memory limit hit in ${degradation.stage} (${(degradation.limitBytes / 1_073_741_824).toFixed(1)} GB)`;
      }
      if (degradation.kind === 'matchingThreadsHalved') {
        return `matching threads reduced ${degradation.from} to ${degradation.to} after a ${(degradation.observedPeakBytes / 1_073_741_824).toFixed(1)} GB peak`;
      }
      return `keypoints capped ${degradation.from.toLocaleString('en-US')} to ${degradation.to.toLocaleString('en-US')}`;
    }),
  );
  if (memory.matchingReplanned) {
    parts.push(
      `matching replanned for ${memory.matchingReplanned.actualMaxKeypoints.toLocaleString('en-US')} keypoints per image with ${memory.matchingReplanned.matchingWorkers} worker${memory.matchingReplanned.matchingWorkers === 1 ? '' : 's'}`,
    );
  }
  const extraction = memory.stages.find((stage) => stage.stage === 'Extract ALIKED');
  const matching = memory.stages.find(
    (stage) =>
      stage.stage === 'Match ALIKED with LightGlue' || stage.stage === 'Match SIFT features',
  );
  if (extraction && matching) {
    const parameters = matching.parameters as { sequentialPairBatches?: unknown } | null;
    parts.push(
      `${extraction.workers} extraction worker${extraction.workers === 1 ? '' : 's'} · ${matching.workers} matching worker${matching.workers === 1 ? '' : 's'}${parameters?.sequentialPairBatches ? ' · sequential pair batches' : ''}`,
    );
  }
  return parts.length > 0 ? `Memory envelope: ${parts.join(' · ')}` : null;
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
