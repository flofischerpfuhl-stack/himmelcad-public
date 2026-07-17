import type {
  AlignmentMergeCandidateRecord,
  CameraCalibrationGroupRecord,
  CaptureGroupRecord,
  HardwareCapabilities,
  MergedAlignmentRunRecord,
  PhotolabJob,
  ProcessingSetRecord,
  PublishedGcpOptimizationEntry,
} from '@himmelcad/data';

import type { GcpAccuracyReport } from './GcpAccuracyPanel.js';

export interface ProcessingReportProduct {
  entityId: string;
  kind: string;
  format: string;
  relativePath: string;
  pointCount?: number;
  versionHash?: string;
  sourceAlignmentEntityId?: string;
  processingSetId?: string;
  gcpOptimizationEntityId?: string;
  gcpOptimizationSnapshotSha256?: string;
}

export interface ProcessingReportInput {
  project: {
    id: string;
    name: string;
    formatVersion: number;
  };
  jobs: readonly PhotolabJob[];
  products: readonly ProcessingReportProduct[];
  hardware: HardwareCapabilities | null;
  accuracy: GcpAccuracyReport | null;
  processingSets: readonly ProcessingSetRecord[];
  captureGroups: readonly CaptureGroupRecord[];
  calibrationGroups: readonly CameraCalibrationGroupRecord[];
  alignmentMerges: readonly MergedAlignmentRunRecord[];
  alignmentRuns: readonly AlignmentMergeCandidateRecord[];
  gcpOptimizations: readonly PublishedGcpOptimizationEntry[];
  generatedAt?: Date;
}

/** Builds a self-contained, network-inert processing report suitable for HTML and PDF export. */
export function buildProcessingReportHtml(input: ProcessingReportInput): string {
  const generated = (input.generatedAt ?? new Date()).toISOString();
  const completedJobs = input.jobs.filter((job) => job.state.kind === 'completed').length;
  const interruptedJobs = input.jobs.filter(
    (job) => job.state.kind === 'failed' && job.state.code.startsWith('interrupted'),
  ).length;
  const failedJobs = input.jobs.filter(
    (job) => job.state.kind === 'failed' && !job.state.code.startsWith('interrupted'),
  ).length;
  const totalRuntimeMs = input.jobs.reduce((sum, job) => sum + jobRuntimeMs(job), 0);

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:">
<title>HimmelCAD PhotoLab Processing Report</title>
<style>${REPORT_CSS}</style>
</head>
<body>
<header><div><p class="eyebrow">HimmelCAD PhotoLab</p><h1>${escapeHtml(input.project.name)}</h1><p>Processing report · generated ${escapeHtml(generated)}</p><p><code>${escapeHtml(input.project.id)}</code> · project format ${input.project.formatVersion}</p></div><div class="summary"><strong>${input.jobs.length}</strong> runs · <strong>${completedJobs}</strong> completed · <strong>${interruptedJobs}</strong> interrupted · <strong>${failedJobs}</strong> failed<br><strong>${formatDuration(totalRuntimeMs)}</strong> recorded runtime · <strong>${input.products.length}</strong> products</div></header>
<main>
${hardwareSection(input.hardware)}
${processingScopeSection(input.processingSets)}
${alignmentLineageSection(input.captureGroups, input.calibrationGroups, input.alignmentRuns, input.gcpOptimizations, input.alignmentMerges)}
${jobSection(input.jobs)}
${productSection(input.products)}
${accuracySection(input.accuracy, input.gcpOptimizations, input.processingSets, input.alignmentRuns)}
</main>
<footer>HimmelCAD PhotoLab · reproducible photogrammetry processing record</footer>
</body>
</html>`;
}

function hardwareSection(hardware: HardwareCapabilities | null): string {
  if (!hardware)
    return section(
      'Hardware at export',
      '<p class="empty">A hardware probe was not available at export time. Historical job records do not invent a machine profile.</p>',
    );
  const rows: [string, string][] = [
    ['Operating system', hardware.operatingSystem],
    ['CPU', `${hardware.cpu.physicalCores} physical / ${hardware.cpu.logicalCores} logical cores`],
    ['AVX2', hardware.cpu.supportsAvx2 ? 'Available' : 'Unavailable'],
    ['RAM', formatBytes(hardware.ramBytes)],
    [
      'Dedicated VRAM',
      hardware.dedicatedVramBytes == null
        ? 'Not reported'
        : formatBytes(hardware.dedicatedVramBytes),
    ],
    [
      'Vulkan',
      hardware.vulkan
        ? `${hardware.vulkan.deviceName} · API ${hardware.vulkan.apiVersion}`
        : 'Not reported',
    ],
    [
      'CUDA',
      hardware.cuda
        ? `${hardware.cuda.deviceName} · compute ${hardware.cuda.computeCapability.major}.${hardware.cuda.computeCapability.minor}`
        : 'Not reported',
    ],
  ];
  return section(
    'Hardware at export',
    '<p class="note">Current workstation probe. It is not presented as historical processing hardware unless the run was executed in this session.</p>' +
      definitionList(rows),
  );
}

function processingScopeSection(processingSets: readonly ProcessingSetRecord[]): string {
  const body =
    processingSets.length === 0
      ? '<p class="empty">No saved processing sets were recorded; runs used an ad-hoc or project-wide scope.</p>'
      : `<table><thead><tr><th>Processing set</th><th>Cameras</th><th>Capture groups</th><th>Calibration groups</th><th>Membership SHA-256</th></tr></thead><tbody>${processingSets.map((set) => `<tr><td><strong>${escapeHtml(set.name)}</strong><small>${escapeHtml(set.entityId)}</small></td><td>${set.cameraEntityIds.length}${idList(set.cameraEntityIds)}</td><td>${set.captureGroupIds?.length ?? 0}${idList(set.captureGroupIds ?? [])}</td><td>${set.calibrationGroupIds?.length ?? 0}${idList(set.calibrationGroupIds ?? [])}</td><td><code>${escapeHtml(set.membershipSha256)}</code></td></tr>`).join('')}</tbody></table>`;
  return section('Processing sets and scope', body);
}

function alignmentLineageSection(
  captureGroups: readonly CaptureGroupRecord[],
  calibrationGroups: readonly CameraCalibrationGroupRecord[],
  alignmentRuns: readonly AlignmentMergeCandidateRecord[],
  gcpOptimizations: readonly PublishedGcpOptimizationEntry[],
  alignmentMerges: readonly MergedAlignmentRunRecord[],
): string {
  const captureRows = captureGroups
    .map(
      (group) =>
        `<tr><td><strong>${escapeHtml(group.name)}</strong><small>${escapeHtml(group.entityId)}</small></td><td>${group.cameraEntityIds.length}${idList(group.cameraEntityIds)}</td><td>${group.calibrationGroupIds.length}${idList(group.calibrationGroupIds)}</td><td><code>${escapeHtml(group.membershipSha256)}</code></td></tr>`,
    )
    .join('');
  const calibrationRows = calibrationGroups
    .map(
      (group) =>
        `<tr><td><strong>${escapeHtml(group.name)}</strong><small>${escapeHtml(group.entityId)}</small></td><td>${escapeHtml(group.groupingBasis)}</td><td>${group.cameraEntityIds.length}${idList(group.cameraEntityIds)}</td><td>${escapeHtml(group.captureGroupId)}</td><td><code>${escapeHtml(group.membershipSha256)}</code></td></tr>`,
    )
    .join('');
  const mergeRows = alignmentMerges
    .map(
      (merge) =>
        `<tr><td><strong>${escapeHtml(merge.name)}</strong><small>${escapeHtml(merge.entityId)}</small></td><td>${escapeHtml(merge.state)}</td><td>${merge.inputAlignmentEntityIds.length}${idList(merge.inputAlignmentEntityIds)}</td><td>${merge.inputGcpOptimizationEntityIds.length}${idList(merge.inputGcpOptimizationEntityIds)}</td><td>${merge.connections.length}${mergeConnectionList(merge)}</td><td>${merge.cameraEntityIds.length}${idList(merge.cameraEntityIds)}</td><td><code>${escapeHtml(merge.lineageSha256)}</code></td></tr>`,
    )
    .join('');
  const alignmentRows = alignmentRuns
    .map(
      (alignment) =>
        `<tr><td><strong>${escapeHtml(alignment.name)}</strong><small>${escapeHtml(alignment.entityId)}</small><small>Job ${escapeHtml(alignment.jobId)}</small></td><td>${alignment.cameraEntityIds.length}${idList(alignment.cameraEntityIds)}</td><td>${escapeHtml(alignment.processingSetId ?? 'Ad-hoc / project-wide')}</td><td>${alignment.calibrationGroups?.length ?? alignment.calibrationGroupIds?.length ?? 0}${alignmentCalibrationList(alignment)}</td></tr>`,
    )
    .join('');
  const optimizationRows = gcpOptimizations
    .map(({ entityId, optimization }) => {
      const result = optimization.artifact.result;
      return `<tr><td><strong>${escapeHtml(entityId)}</strong><small>${escapeHtml(optimization.operationId)}</small></td><td>${escapeHtml(optimization.sourceAlignmentEntityId ?? 'Unavailable')}</td><td>${escapeHtml(optimization.processingSetId ?? 'Project-wide')}</td><td>${result.converged ? 'Converged' : 'Not converged'}</td><td>${result.cameras.length}</td><td>${result.residuals.length}</td><td><code>${escapeHtml(optimization.snapshotSha256)}</code></td></tr>`;
    })
    .join('');
  return section(
    'Alignment lineage',
    `
<h3>Capture groups</h3>${captureRows ? `<table><thead><tr><th>Group</th><th>Cameras</th><th>Calibration groups</th><th>Membership SHA-256</th></tr></thead><tbody>${captureRows}</tbody></table>` : '<p class="empty">No capture groups recorded.</p>'}
<h3>Calibration groups</h3>${calibrationRows ? `<table><thead><tr><th>Group</th><th>Basis</th><th>Cameras</th><th>Capture group</th><th>Membership SHA-256</th></tr></thead><tbody>${calibrationRows}</tbody></table>` : '<p class="empty">No calibration groups recorded.</p>'}
<h3>Independent alignment runs</h3>${alignmentRows ? `<table><thead><tr><th>Alignment</th><th>Cameras</th><th>Processing set</th><th>Calibration groups</th></tr></thead><tbody>${alignmentRows}</tbody></table>` : '<p class="empty">No published sparse alignments recorded.</p>'}
<h3>GCP optimizations</h3>${optimizationRows ? `<table><thead><tr><th>Optimization</th><th>Source alignment</th><th>Processing set</th><th>State</th><th>Cameras</th><th>Residuals</th><th>Snapshot SHA-256</th></tr></thead><tbody>${optimizationRows}</tbody></table>` : '<p class="empty">No GCP optimizations recorded.</p>'}
<h3>Merged alignments</h3>${mergeRows ? `<table><thead><tr><th>Merge</th><th>State</th><th>Alignments</th><th>GCP solutions</th><th>Connections</th><th>Cameras</th><th>Lineage SHA-256</th></tr></thead><tbody>${mergeRows}</tbody></table>` : '<p class="empty">No merged alignment recorded.</p>'}`,
  );
}

function alignmentCalibrationList(alignment: AlignmentMergeCandidateRecord): string {
  const groups = alignment.calibrationGroups ?? [];
  if (groups.length === 0) return idList(alignment.calibrationGroupIds ?? []);
  return `<details><summary>Show exact intrinsics partition</summary>${groups
    .map(
      (group) =>
        `<strong>${escapeHtml(group.groupId)}</strong><small>${group.cameraEntityIds.length} images</small>${group.cameraEntityIds.map((id) => `<code>${escapeHtml(id)}</code>`).join('')}`,
    )
    .join('')}</details>`;
}

function idList(ids: readonly string[]): string {
  if (ids.length === 0) return '';
  return `<details><summary>Show membership</summary>${ids.map((id) => `<code>${escapeHtml(id)}</code>`).join('')}</details>`;
}

function mergeConnectionList(merge: MergedAlignmentRunRecord): string {
  if (merge.connections.length === 0) return '';
  const rows = merge.connections.map((connection) => {
    const endpoints = `${escapeHtml(connection.alignmentA)} ↔ ${escapeHtml(connection.alignmentB)}`;
    if (connection.kind === 'overlap') {
      return `<code>${endpoints} · ${connection.verifiedCrossRunTrackCount} verified tracks</code>`;
    }
    return `<code>${endpoints} · shared controls: ${connection.controlPointIds.map(escapeHtml).join(', ')}</code>`;
  });
  return `<details><summary>Show evidence</summary>${rows.join('')}</details>`;
}

function jobSection(jobs: readonly PhotolabJob[]): string {
  if (jobs.length === 0)
    return section('Processing runs', '<p class="empty">No processing runs recorded.</p>');
  const rows = jobs
    .map((job) => {
      const failure =
        job.state.kind === 'failed'
          ? `<strong class="failure">${escapeHtml(job.state.code)}</strong><br>${escapeHtml(job.state.message)}`
          : '—';
      const metrics = job.progress.metrics;
      const recordedWork = `${metrics.completedUnits.toLocaleString('en-US')}${metrics.totalUnits == null ? '' : ` / ${metrics.totalUnits.toLocaleString('en-US')}`}`;
      return `<tr><td><strong>${escapeHtml(jobLabel(job))}</strong><small>${escapeHtml(job.id)}</small></td><td>${escapeHtml(reportJobState(job))}</td><td>${formatDate(job.startedAtUnixMs)}</td><td>${formatDate(job.finishedAtUnixMs)}</td><td>${formatDuration(jobRuntimeMs(job))}</td><td>${escapeHtml(job.progress.stage.label)}<small>${job.progress.stage.index + 1} / ${job.progress.stage.stageCount} · ${escapeHtml(job.progress.stage.kind)} · ${recordedWork}</small></td><td><code>${escapeHtml(job.configHash)}</code></td><td><code>${escapeHtml(job.inputHash)}</code></td><td>${escapeHtml(jobRecovery(job))}</td><td>${failure}</td></tr>`;
    })
    .join('');
  return section(
    'Processing runs',
    `<table><thead><tr><th>Operation</th><th>State</th><th>Started</th><th>Finished</th><th>Runtime</th><th>Last recorded stage</th><th>Configuration SHA-256</th><th>Input SHA-256</th><th>Cancellation / recovery</th><th>Error</th></tr></thead><tbody>${rows}</tbody></table>`,
  );
}

function reportJobState(job: PhotolabJob): string {
  if (job.state.kind !== 'failed') return job.state.kind;
  if (job.state.code === 'interruptedRecoverable') return 'interrupted · recoverable';
  if (job.state.code === 'interrupted') return 'interrupted · restart required';
  return job.state.kind;
}

function jobRecovery(job: PhotolabJob): string {
  const checkpoint = job.lastCheckpointSequence;
  if (job.state.kind === 'completed') return 'Completed; no recovery required';
  if (job.state.kind === 'cancelled') {
    return checkpoint == null
      ? 'Cancelled; no committed checkpoint'
      : `Cancelled; checkpoint ${checkpoint} retained`;
  }
  if (job.state.kind === 'failed') {
    if (job.state.code === 'interruptedRecoverable') {
      return `Interrupted; resume available from checkpoint ${checkpoint ?? 'not recorded'}`;
    }
    if (job.state.code === 'interrupted') return 'Interrupted; restart required';
    return checkpoint == null
      ? 'Failed; no committed checkpoint'
      : `Failed; checkpoint ${checkpoint} retained`;
  }
  return checkpoint == null
    ? 'Operation did not reach a committed checkpoint'
    : `Checkpoint ${checkpoint} committed`;
}

function productSection(products: readonly ProcessingReportProduct[]): string {
  if (products.length === 0)
    return section('Published products', '<p class="empty">No products published.</p>');
  const rows = products
    .map(
      (product) =>
        `<tr><td><strong>${escapeHtml(product.kind)}</strong><small>${escapeHtml(product.entityId)}</small></td><td>${escapeHtml(product.format)}</td><td>${product.pointCount?.toLocaleString('en-US') ?? '—'}</td><td><code>${escapeHtml(product.versionHash ?? 'Not exposed by this project record')}</code></td><td><code>${escapeHtml(product.sourceAlignmentEntityId ?? 'Legacy / unavailable')}</code></td><td><code>${escapeHtml(product.processingSetId ?? 'Project-wide / merged')}</code></td><td><code>${escapeHtml(product.gcpOptimizationEntityId ?? 'No GCP optimization')}</code><small>${escapeHtml(product.gcpOptimizationSnapshotSha256 ?? '')}</small></td><td>${escapeHtml(product.relativePath)}</td></tr>`,
    )
    .join('');
  return section(
    'Published products',
    `<table><thead><tr><th>Product</th><th>Format</th><th>Points</th><th>Entity version SHA-256</th><th>Source alignment</th><th>Processing set</th><th>GCP revision</th><th>Project path</th></tr></thead><tbody>${rows}</tbody></table>`,
  );
}

function accuracySection(
  accuracy: GcpAccuracyReport | null,
  optimizations: readonly PublishedGcpOptimizationEntry[],
  processingSets: readonly ProcessingSetRecord[],
  alignmentRuns: readonly AlignmentMergeCandidateRecord[],
): string {
  if (optimizations.length === 0)
    return section(
      'Ground control and checkpoints',
      '<p class="empty">No persisted GCP optimization result was published for this report.</p>',
    );
  const body = optimizations
    .map(({ entityId, optimization }) => {
      const result = optimization.artifact.result;
      const matchingAccuracy =
        accuracy?.optimizationSnapshotSha256 === optimization.snapshotSha256 ? accuracy : null;
      const pointNames = new Map(
        matchingAccuracy?.residuals.map((residual) => [residual.pointId, residual.pointName]) ?? [],
      );
      const observations = new Map(
        result.points.map((point) => [point.pointId, point.observationCount]),
      );
      const processingSet = processingSets.find(
        (candidate) => candidate.entityId === optimization.processingSetId,
      );
      const alignment = alignmentRuns.find(
        (candidate) => candidate.entityId === optimization.sourceAlignmentEntityId,
      );
      const summary = [
        accuracySummaryCard('Controls', result.statistics.control ?? null),
        accuracySummaryCard('Checkpoints', result.statistics.checkpoint ?? null),
      ].join('');
      const rows = result.residuals
        .map(
          (residual) =>
            `<tr><td><strong>${escapeHtml(pointNames.get(residual.pointId) ?? residual.pointId)}</strong><small>${escapeHtml(residual.pointId)}</small></td><td>${escapeHtml(residual.role)}</td><td>${formatMetric(residual.eastMeters)}</td><td>${formatMetric(residual.northMeters)}</td><td>${formatMetric(residual.heightMeters)}</td><td>${formatMetric(residual.horizontalMeters)}</td><td>${formatMetric(residual.spatial3dMeters)}</td><td>${formatMetric(residual.reprojectionRmsPixels, 'px')}</td><td>${formatMetric(residual.reprojectionMaxPixels, 'px')}</td><td>${observations.get(residual.pointId) ?? '—'}</td></tr>`,
        )
        .join('');
      return `<article class="optimization"><h3>${escapeHtml(entityId)}</h3>${definitionList([
        ['Operation', optimization.operationId],
        [
          'Source alignment',
          alignment
            ? `${alignment.name} · ${alignment.entityId}`
            : (optimization.sourceAlignmentEntityId ?? 'Not recorded'),
        ],
        [
          'Processing set',
          processingSet
            ? `${processingSet.name} · ${processingSet.entityId}`
            : (optimization.processingSetId ?? 'Project-wide'),
        ],
        ['Solver', optimization.artifact.solver],
        ['State', result.converged ? 'Converged' : 'Completed without convergence'],
        ['Iterations', String(result.iterations)],
        [
          'Final objective',
          Number.isFinite(result.finalObjective)
            ? result.finalObjective.toPrecision(8)
            : 'Not recorded',
        ],
        ['Input SHA-256', optimization.inputSha256],
        ['Artifact SHA-256', optimization.artifactSha256],
        ['Snapshot SHA-256', optimization.snapshotSha256],
      ])}<div class="cards">${summary}</div><h3>Per-point errors</h3><table><thead><tr><th>Point</th><th>Role</th><th>East</th><th>North</th><th>Height</th><th>Horizontal</th><th>3D</th><th>Pixel RMS</th><th>Pixel max</th><th>Observations</th></tr></thead><tbody>${rows}</tbody></table></article>`;
    })
    .join('');
  return section('Ground control and checkpoints', body);
}

function accuracySummaryCard(
  label: string,
  statistics: NonNullable<GcpAccuracyReport['control']> | null,
): string {
  if (!statistics)
    return `<article class="card"><h3>${label}</h3><p class="empty">No points in this role.</p></article>`;
  return `<article class="card"><h3>${label}</h3>${definitionList([
    ['Points', String(statistics.pointCount)],
    ['East RMS', formatMetric(statistics.eastRmsMeters)],
    ['North RMS', formatMetric(statistics.northRmsMeters)],
    ['Height RMS', formatMetric(statistics.heightRmsMeters)],
    ['Horizontal RMS', formatMetric(statistics.horizontalRmsMeters)],
    ['3D RMS', formatMetric(statistics.spatial3dRmsMeters)],
    ['Pixel RMS', formatMetric(statistics.reprojectionRmsPixels, 'px')],
    ['Maximum active error', formatMetric(statistics.maxActiveComponentMeters)],
    ['Maximum pixel error', formatMetric(statistics.maxReprojectionPixels, 'px')],
  ])}</article>`;
}

function definitionList(rows: readonly [string, string][]): string {
  return `<dl>${rows.map(([label, value]) => `<dt>${escapeHtml(label)}</dt><dd>${escapeHtml(value)}</dd>`).join('')}</dl>`;
}

function section(title: string, body: string): string {
  return `<section><h2>${escapeHtml(title)}</h2>${body}</section>`;
}

function jobRuntimeMs(job: PhotolabJob): number {
  if (job.startedAtUnixMs == null || job.finishedAtUnixMs == null) return 0;
  return Math.max(0, job.finishedAtUnixMs - job.startedAtUnixMs);
}

function formatDate(value: number | undefined): string {
  return value == null ? '—' : escapeHtml(new Date(value).toISOString());
}

function formatDuration(milliseconds: number): string {
  if (milliseconds <= 0) return '—';
  if (milliseconds < 60_000) return `${(milliseconds / 1_000).toFixed(3)} s`;
  const seconds = Math.floor(milliseconds / 1_000);
  const hours = Math.floor(seconds / 3_600);
  const minutes = Math.floor((seconds % 3_600) / 60);
  const remainder = seconds % 60;
  return hours > 0 ? `${hours} h ${minutes} min ${remainder} s` : `${minutes} min ${remainder} s`;
}

function formatBytes(value: number): string {
  if (value < 1024) return `${value} B`;
  if (value < 1024 ** 2) return `${(value / 1024).toFixed(1)} KiB`;
  if (value < 1024 ** 3) return `${(value / 1024 ** 2).toFixed(1)} MiB`;
  return `${(value / 1024 ** 3).toFixed(2)} GiB`;
}

function formatMetric(value: number | undefined, unit = 'm'): string {
  return value == null ? '—' : `${value.toFixed(unit === 'px' ? 3 : 4)} ${unit}`;
}

function jobLabel(job: PhotolabJob): string {
  const labels: Record<PhotolabJob['kind'], string> = {
    analyzeImageQuality: 'Analyze Image Quality',
    alignPhotos: 'Align Photos',
    mergeAlignments: 'Merge Alignments',
    optimizeAlignment: 'Optimize Alignment',
    buildDepthMaps: 'Build Depth Maps',
    buildDensePointCloud: 'Build Dense Point Cloud',
    buildDem: 'Build DEM',
    buildOrthomosaic: 'Build Orthomosaic',
    buildMesh: 'Build Textured Mesh',
    buildGaussianSplat: 'Build Gaussian Splat',
    exportProduct: 'Export Product',
    batch: 'Batch Processing',
  };
  return labels[job.kind];
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

const REPORT_CSS = `
@page{size:A4 landscape;margin:10mm}*{box-sizing:border-box}body{margin:0;background:#fff;color:#18202d;font:11px system-ui,-apple-system,"Segoe UI",sans-serif}header{display:flex;align-items:flex-end;justify-content:space-between;gap:24px;padding:0 0 14px;border-bottom:3px solid #238be6}h1{margin:0;font-size:26px}header p{margin:4px 0 0;color:#5c6979}.eyebrow{color:#087dcc;font:700 9px ui-monospace,monospace;letter-spacing:.18em}.summary{text-align:right;line-height:1.7}section{margin-top:18px}h2{margin:0 0 8px;padding-bottom:4px;border-bottom:1px solid #b8c7d8;font-size:16px}h3{margin:12px 0 6px;font-size:12px}table{width:100%;border-collapse:collapse;font-size:8px;table-layout:auto}th,td{padding:4px 5px;border:1px solid #cbd5e0;text-align:left;vertical-align:top;overflow-wrap:anywhere}th{background:#eaf2f9;color:#34465a}td small{display:block;margin-top:2px;color:#66768a}code{font:7.5px ui-monospace,"Cascadia Mono",monospace;overflow-wrap:anywhere}dl{display:grid;grid-template-columns:max-content minmax(0,1fr);gap:3px 12px;margin:0}dt{color:#617085}dd{margin:0;font-weight:600}.cards{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-top:10px}.card{padding:9px;border:1px solid #cbd5e0;border-radius:5px;background:#f6f9fc}.card h3{margin-top:0}.optimization{break-before:auto;margin-top:14px;padding-top:2px}.note{color:#617085}.empty{color:#68778a;font-style:italic}.failure{color:#b42318}footer{margin-top:22px;padding-top:8px;border-top:1px solid #cbd5e0;color:#617085;font-size:9px}`;
