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
  imageMaskScopeSha256?: string;
  toolVersions?: Readonly<Record<string, string>>;
  provenanceStatus?: 'complete' | 'partial' | 'unknown';
  missingFieldIds?: readonly string[];
  packageSchemaId?: string;
  packageSha256?: string;
  normalizedFormatId?: string;
  disposition?: 'available' | 'needs_preparation' | 'needs_republish_recompute' | 'unsupported';
  reasonCode?: string;
}

export interface ProcessingReportSurveyData {
  schemaVersion: number;
  crs: unknown;
  alignments: readonly ProcessingReportAlignmentSurveyData[];
  jobs: readonly ProcessingReportJobConfiguration[];
}

export interface ProcessingReportAlignmentSurveyData {
  entityId: string;
  name: string;
  kind: string;
  imageCount: number;
  gsdMetersPerPixel: number | null;
  gsdMethod: string;
  footprintBbox: readonly [number, number, number, number] | null;
  footprintBboxAreaSquareMeters: number | null;
  calibrationGroups: readonly ProcessingReportCalibrationGroup[];
  gcpResiduals: readonly ProcessingReportGcpResidual[];
  gcpOptimizationEntityId: string | null;
  gcpOptimizationSnapshotSha256: string | null;
}

interface ReportIntrinsics {
  f: number | null;
  cx: number | null;
  cy: number | null;
  k1: number | null;
  k2: number | null;
  k3: number | null;
  p1: number | null;
  p2: number | null;
}

interface ReportIntrinsicsFlags {
  f: boolean;
  cx: boolean;
  cy: boolean;
  k1: boolean;
  k2: boolean;
  k3: boolean;
  p1: boolean;
  p2: boolean;
}

export interface ProcessingReportCalibrationGroup {
  groupId: string;
  imageCount: number;
  seed: ReportIntrinsics;
  solved: ReportIntrinsics;
  refined: ReportIntrinsicsFlags;
  fixed: boolean;
  sigmas: ReportIntrinsics | null;
  correlation: readonly (readonly number[])[] | null;
  uncertaintyNote: string;
}

export interface ProcessingReportGcpResidual {
  pointId: string;
  pointName: string;
  role: string;
  position: readonly [number, number];
  vectorMeters: readonly [number | null, number | null];
  heightMeters: number | null;
}

export interface ProcessingReportJobConfiguration {
  jobId: string;
  kind: string;
  method: string | null;
  profileName: string | null;
  resolvedPresetName: string | null;
  parameters: unknown | null;
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
  surveyData: ProcessingReportSurveyData | null;
  surveyDataUnavailableReason?: string | undefined;
  generatedAt: Date;
  generatedAtSource: string;
}

/** Builds a self-contained, network-inert processing report suitable for HTML and PDF export. */
export function buildProcessingReportHtml(input: ProcessingReportInput): string {
  const generated = input.generatedAt.toISOString();
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
<title>Himmel:CAD PhotoLab Processing Report</title>
<style>${REPORT_CSS}</style>
</head>
<body>
<header><div><p class="eyebrow">Himmel:CAD PhotoLab</p><h1>${escapeHtml(input.project.name)}</h1><p>Processing report · generated ${escapeHtml(generated)}</p><p>Timestamp source: ${escapeHtml(input.generatedAtSource)}</p><p><code>${escapeHtml(input.project.id)}</code> · project format ${input.project.formatVersion}</p></div><div class="summary"><strong>${input.jobs.length}</strong> runs · <strong>${completedJobs}</strong> completed · <strong>${interruptedJobs}</strong> interrupted · <strong>${failedJobs}</strong> failed<br><strong>${formatDuration(totalRuntimeMs)}</strong> recorded runtime · <strong>${input.products.length}</strong> products</div></header>
<main>
${surveyOverviewSection(input.surveyData, input.surveyDataUnavailableReason)}
${cameraCalibrationSection(input.surveyData, input.surveyDataUnavailableReason)}
${processingParametersSection(input.surveyData, input.surveyDataUnavailableReason)}
${gcpAccuracyMapSection(input.surveyData, input.surveyDataUnavailableReason)}
${mergeEvidenceSection(input.alignmentMerges)}
<h2 class="annex">Audit annex</h2>
${hardwareSection(input.hardware)}
${processingScopeSection(input.processingSets)}
${alignmentLineageSection(input.captureGroups, input.calibrationGroups, input.alignmentRuns, input.gcpOptimizations, input.alignmentMerges)}
${jobSection(input.jobs)}
${productSection(input.products)}
${accuracySection(input.accuracy, input.gcpOptimizations, input.processingSets, input.alignmentRuns)}
</main>
<footer>Himmel:CAD PhotoLab · reproducible photogrammetry processing record</footer>
</body>
</html>`;
}

function surveyUnavailable(reason?: string): string {
  return `<p class="empty">${escapeHtml(reason ?? 'Survey data unavailable.')}</p>`;
}

function surveyOverviewSection(
  survey: ProcessingReportSurveyData | null,
  unavailableReason?: string,
): string {
  if (!survey) return section('Survey overview', surveyUnavailable(unavailableReason));
  const crs = humanReadableValue(survey.crs);
  const rows = [...survey.alignments]
    .sort((left, right) => left.entityId.localeCompare(right.entityId, 'en-US'))
    .map(
      (alignment) =>
        `<tr><td><strong>${escapeHtml(alignment.name)}</strong><small>${escapeHtml(alignment.entityId)} · ${escapeHtml(humanize(alignment.kind))}</small></td><td>${formatInteger(alignment.imageCount)}</td><td>${formatMetric(alignment.gsdMetersPerPixel ?? undefined, 'm/px')}</td><td>${formatArea(alignment.footprintBboxAreaSquareMeters)}</td><td>${alignment.footprintBbox ? alignment.footprintBbox.map((value) => formatNumber(value, 3)).join(', ') : '—'}</td><td>${escapeHtml(crs)}</td></tr>`,
    )
    .join('');
  const method = survey.alignments.find((alignment) => alignment.gsdMethod)?.gsdMethod;
  return section(
    'Survey overview',
    `${method ? `<p class="note"><strong>GSD method:</strong> ${escapeHtml(method)}</p>` : ''}${rows ? `<table><thead><tr><th>Alignment</th><th>Images</th><th>Mean GSD</th><th>Footprint bbox area</th><th>Footprint bbox (E min, N min, E max, N max)</th><th>CRS</th></tr></thead><tbody>${rows}</tbody></table>` : '<p class="empty">No published alignments were recorded.</p>'}`,
  );
}

function cameraCalibrationSection(
  survey: ProcessingReportSurveyData | null,
  unavailableReason?: string,
): string {
  if (!survey) return section('Camera calibration per group', surveyUnavailable(unavailableReason));
  const parameterNames = ['f', 'cx', 'cy', 'k1', 'k2', 'k3', 'p1', 'p2'] as const;
  const rows = [...survey.alignments]
    .sort((left, right) => left.entityId.localeCompare(right.entityId, 'en-US'))
    .flatMap((alignment) =>
      [...alignment.calibrationGroups]
        .sort((left, right) => left.groupId.localeCompare(right.groupId, 'en-US'))
        .map((group) => {
          const values = parameterNames
            .map((name) => {
              const seed = group.seed[name];
              const solved = group.solved[name];
              const sigma = group.sigmas?.[name];
              const movement = `${formatNumber(seed)} → ${formatNumber(solved)}`;
              const flag = group.fixed || !group.refined[name] ? 'fixed' : 'refined';
              return `<td>${movement}<small>${flag}${sigma == null ? '' : ` · σ ${formatNumber(sigma)}`}</small></td>`;
            })
            .join('');
          const correlation = group.correlation
            ? stableJson(group.correlation)
            : `Not available · ${group.uncertaintyNote}`;
          return `<tr><td><strong>${escapeHtml(group.groupId)}</strong><small>${escapeHtml(alignment.name)} · ${formatInteger(group.imageCount)} images</small></td>${values}<td>${escapeHtml(correlation)}</td></tr>`;
        }),
    )
    .join('');
  return section(
    'Camera calibration per group',
    rows
      ? `<p class="note">Values are seed → solved. Parameters are marked refined only when the converged GCP snapshot records them as effective.</p><table><thead><tr><th>Group</th>${parameterNames.map((name) => `<th>${name}</th>`).join('')}<th>Sigmas / correlation</th></tr></thead><tbody>${rows}</tbody></table>`
      : '<p class="empty">No frozen calibration groups were recorded.</p>',
  );
}

function processingParametersSection(
  survey: ProcessingReportSurveyData | null,
  unavailableReason?: string,
): string {
  if (!survey) return section('Processing parameters', surveyUnavailable(unavailableReason));
  const rows = [...survey.jobs]
    .sort((left, right) => left.jobId.localeCompare(right.jobId, 'en-US'))
    .map((job) => {
      const knobs = flattenParameters(job.parameters)
        .map(([name, value]) => `<code>${escapeHtml(name)} = ${escapeHtml(value)}</code>`)
        .join('');
      return `<tr><td><strong>${escapeHtml(humanize(job.kind))}</strong><small>${escapeHtml(job.jobId)}</small></td><td>${escapeHtml(job.resolvedPresetName ?? 'No named preset recorded')}</td><td>${escapeHtml(job.profileName ? humanize(job.profileName) : 'No profile name recorded')}</td><td>${escapeHtml(job.method ?? 'Legacy job; method unavailable')}</td><td>${knobs || 'Frozen parameters unavailable'}</td></tr>`;
    })
    .join('');
  return section(
    'Processing parameters',
    rows
      ? `<table><thead><tr><th>Job</th><th>Resolved preset</th><th>Profile</th><th>Command</th><th>Frozen knobs</th></tr></thead><tbody>${rows}</tbody></table>`
      : '<p class="empty">No frozen job configurations were recorded.</p>',
  );
}

function gcpAccuracyMapSection(
  survey: ProcessingReportSurveyData | null,
  unavailableReason?: string,
): string {
  if (!survey) return section('GCP accuracy', surveyUnavailable(unavailableReason));
  const residuals = survey.alignments.flatMap((alignment) =>
    alignment.gcpResiduals.map((residual) => ({ alignment, residual })),
  );
  if (residuals.length === 0) {
    return section(
      'GCP accuracy',
      '<p class="empty">No residual vectors from a converged GCP optimization were recorded.</p>',
    );
  }
  return section('GCP accuracy', residualMapSvg(residuals));
}

function residualMapSvg(
  entries: readonly {
    alignment: ProcessingReportAlignmentSurveyData;
    residual: ProcessingReportGcpResidual;
  }[],
): string {
  const width = 760;
  const height = 320;
  const margin = 34;
  const east = entries.map(({ residual }) => residual.position[0]);
  const north = entries.map(({ residual }) => residual.position[1]);
  const minE = Math.min(...east);
  const maxE = Math.max(...east);
  const minN = Math.min(...north);
  const maxN = Math.max(...north);
  const spanE = Math.max(maxE - minE, 1);
  const spanN = Math.max(maxN - minN, 1);
  const positionScale = Math.min((width - margin * 2) / spanE, (height - margin * 2) / spanN);
  const magnitudes = entries.map(({ residual }) =>
    Math.hypot(residual.vectorMeters[0] ?? 0, residual.vectorMeters[1] ?? 0),
  );
  const maximumResidual = Math.max(...magnitudes, 0.001);
  const residualMetersPerPixel = maximumResidual / 42;
  const scaleBarMeters = niceScale(maximumResidual);
  const marks = [...entries]
    .sort((left, right) => left.residual.pointId.localeCompare(right.residual.pointId, 'en-US'))
    .map(({ alignment, residual }) => {
      const x = margin + (residual.position[0] - minE) * positionScale;
      const y = height - margin - (residual.position[1] - minN) * positionScale;
      const dx = (residual.vectorMeters[0] ?? 0) / residualMetersPerPixel;
      const dy = -(residual.vectorMeters[1] ?? 0) / residualMetersPerPixel;
      const checkpoint = residual.role.startsWith('checkpoint');
      const color = checkpoint ? 'var(--report-check)' : 'var(--report-control)';
      return `<g><title>${escapeHtml(`${residual.pointName} · ${alignment.name}`)}</title><circle cx="${formatNumber(x, 3)}" cy="${formatNumber(y, 3)}" r="3.5" fill="${color}"/><line x1="${formatNumber(x, 3)}" y1="${formatNumber(y, 3)}" x2="${formatNumber(x + dx, 3)}" y2="${formatNumber(y + dy, 3)}" stroke="${color}" stroke-width="2" marker-end="url(#arrow)"/><text x="${formatNumber(x + 5, 3)}" y="${formatNumber(y - 5, 3)}">${escapeHtml(residual.pointName)}</text></g>`;
    })
    .join('');
  const barPixels = scaleBarMeters / residualMetersPerPixel;
  return `<p class="note">Map positions use project East/North coordinates. Residual vectors are enlarged independently of position scale; the vector scale bar represents ${formatMetric(scaleBarMeters)}.</p><svg class="residual-map" viewBox="0 0 ${width} ${height}" role="img" aria-label="GCP residual vector map"><defs><marker id="arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="4" markerHeight="4" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" fill="context-stroke"/></marker></defs><rect x="0" y="0" width="${width}" height="${height}" fill="var(--report-map-bg)"/>${marks}<g class="scale"><line x1="${margin}" y1="${height - 12}" x2="${formatNumber(margin + barPixels, 3)}" y2="${height - 12}"/><text x="${margin}" y="${height - 17}">${formatMetric(scaleBarMeters)} residual</text></g><g class="legend"><circle cx="${width - 155}" cy="18" r="4" fill="var(--report-control)"/><text x="${width - 146}" y="21">Control</text><circle cx="${width - 82}" cy="18" r="4" fill="var(--report-check)"/><text x="${width - 73}" y="21">Check</text></g></svg>`;
}

function mergeEvidenceSection(merges: readonly MergedAlignmentRunRecord[]): string {
  const rows = [...merges]
    .sort((left, right) => left.entityId.localeCompare(right.entityId, 'en-US'))
    .map(
      (merge) =>
        `<tr><td><strong>${escapeHtml(merge.name)}</strong><small>${escapeHtml(merge.entityId)}</small></td><td>${escapeHtml(merge.mergeProfile?.name ?? 'Legacy default')}</td><td>${escapeHtml(merge.mergeProfile ? stableJson(merge.mergeProfile.overrides) : 'Not recorded')}</td><td>${merge.connections.length}${mergeConnectionList(merge)}</td></tr>`,
    )
    .join('');
  return section(
    'Merge evidence',
    rows
      ? `<table><thead><tr><th>Merge</th><th>Profile</th><th>Profile knobs</th><th>Connection evidence</th></tr></thead><tbody>${rows}</tbody></table>`
      : '<p class="empty">No merged alignment was recorded.</p>',
  );
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
        `<tr><td><strong>${escapeHtml(merge.name)}</strong><small>${escapeHtml(merge.entityId)}</small></td><td>${escapeHtml(merge.state)}</td><td>${escapeHtml(merge.mergeProfile?.name ?? 'Quality Hybrid (legacy default)')}</td><td>${merge.inputAlignmentEntityIds.length}${idList(merge.inputAlignmentEntityIds)}</td><td>${merge.inputGcpOptimizationEntityIds.length}${idList(merge.inputGcpOptimizationEntityIds)}</td><td>${merge.connections.length}${mergeConnectionList(merge)}</td><td>${merge.cameraEntityIds.length}${idList(merge.cameraEntityIds)}</td><td><code>${escapeHtml(merge.lineageSha256)}</code></td></tr>`,
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
<h3>Merged alignments</h3>${mergeRows ? `<table><thead><tr><th>Merge</th><th>State</th><th>Preset</th><th>Alignments</th><th>GCP solutions</th><th>Connection evidence</th><th>Cameras</th><th>Lineage SHA-256</th></tr></thead><tbody>${mergeRows}</tbody></table>` : '<p class="empty">No merged alignment recorded.</p>'}`,
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
  const rows = merge.connections.map((connection, connectionIndex) => {
    const endpoints = `${escapeHtml(connection.alignmentA)} ↔ ${escapeHtml(connection.alignmentB)}`;
    const evidence = merge.connectionEvidence?.find(
      (item) => item.connectionIndex === connectionIndex,
    );
    if (connection.kind === 'overlap') {
      const rms =
        evidence?.crossRunReprojectionRmsPx == null
          ? 'RMS unavailable'
          : `${evidence.crossRunReprojectionRmsPx.toFixed(3)} px RMS`;
      return `<code>${endpoints} · ${evidence?.crossRunTrackCount ?? connection.verifiedCrossRunTrackCount} verified tracks · ${rms}</code>`;
    }
    const misclosure = evidence?.controlMisclosure;
    const misclosureText = misclosure
      ? `mean absolute misclosure E ${misclosure.east.toFixed(4)} m · N ${misclosure.north.toFixed(4)} m · H ${misclosure.height.toFixed(4)} m · ${misclosure.count} controls`
      : 'misclosure unavailable';
    return `<code>${endpoints} · shared controls: ${connection.controlPointIds.map(escapeHtml).join(', ')} · ${misclosureText}</code>`;
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
  if (job.state.kind === 'pauseRequested' || job.state.kind === 'paused') return 'running';
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
        `<tr><td><strong>${escapeHtml(product.kind)}</strong><small>${escapeHtml(product.entityId)}</small></td><td>${escapeHtml(product.normalizedFormatId ?? product.format)}</td><td>${escapeHtml(humanize(product.provenanceStatus ?? 'unknown'))}<small>${(product.missingFieldIds?.length ?? 0) === 0 ? 'All mandatory fields present' : `Missing: ${escapeHtml(product.missingFieldIds?.join(', ') ?? '')}`}</small></td><td>${escapeHtml(productDispositionLabel(product.disposition))}<small>${escapeHtml(product.reasonCode ?? 'legacy_record')}${product.disposition === 'needs_republish_recompute' || product.disposition == null ? ' · Needs republish/recompute' : ''}</small></td><td><code>${escapeHtml(product.packageSha256 ?? 'No package')}</code></td><td>${product.pointCount?.toLocaleString('en-US') ?? '—'}</td><td><code>${escapeHtml(product.versionHash ?? 'Not exposed by this project record')}</code></td><td><code>${escapeHtml(product.sourceAlignmentEntityId ?? 'Legacy / unavailable')}</code></td><td><code>${escapeHtml(product.processingSetId ?? 'Project-wide / merged')}</code></td><td><code>${escapeHtml(product.gcpOptimizationEntityId ?? 'No GCP optimization')}</code><small>${escapeHtml(product.gcpOptimizationSnapshotSha256 ?? '')}</small></td><td><code>${escapeHtml(product.imageMaskScopeSha256 ?? 'Legacy / unavailable')}</code></td><td>${product.toolVersions ? escapeHtml(stableJson(product.toolVersions)) : 'Not recorded'}</td><td>${escapeHtml(product.relativePath)}</td></tr>`,
    )
    .join('');
  return section(
    'Published products',
    `<table><thead><tr><th>Product</th><th>Format</th><th>Provenance</th><th>Disposition</th><th>Package SHA-256</th><th>Points</th><th>Entity version SHA-256</th><th>Source alignment</th><th>Processing set</th><th>GCP revision</th><th>Mask-scope SHA-256</th><th>Tool versions</th><th>Project path</th></tr></thead><tbody>${rows}</tbody></table>`,
  );
}

function productDispositionLabel(disposition: ProcessingReportProduct['disposition']): string {
  if (disposition == null) return 'Needs republish/recompute';
  if (disposition === 'available') return 'Available';
  if (disposition === 'needs_preparation') return 'Needs preparation';
  if (disposition === 'needs_republish_recompute') return 'Needs republish/recompute';
  return 'Unsupported';
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

function formatInteger(value: number): string {
  return value.toLocaleString('en-US', { maximumFractionDigits: 0 });
}

function formatNumber(value: number | null | undefined, digits = 6): string {
  if (value == null || !Number.isFinite(value)) return '—';
  return value.toLocaleString('en-US', {
    minimumFractionDigits: 0,
    maximumFractionDigits: digits,
    useGrouping: true,
  });
}

function formatArea(value: number | null): string {
  return value == null ? '—' : `${formatNumber(value, 3)} m²`;
}

function humanize(value: string): string {
  const spaced = value.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replaceAll('_', ' ');
  return spaced ? `${spaced[0]?.toUpperCase() ?? ''}${spaced.slice(1)}` : value;
}

function humanReadableValue(value: unknown): string {
  if (value == null) return 'Not recorded';
  if (typeof value === 'string') return humanize(value);
  return stableJson(value);
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(', ')}]`;
  if (value && typeof value === 'object') {
    return `{ ${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right, 'en-US'))
      .map(([key, item]) => `${key}: ${stableJson(item)}`)
      .join(', ')} }`;
  }
  return String(value);
}

function flattenParameters(value: unknown, prefix = ''): [string, string][] {
  if (value == null) return [];
  if (Array.isArray(value)) {
    return value.flatMap((item, index) => flattenParameters(item, `${prefix}[${index}]`));
  }
  if (typeof value === 'object') {
    return Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right, 'en-US'))
      .flatMap(([key, item]) => flattenParameters(item, prefix ? `${prefix}.${key}` : key));
  }
  if (/(?:hash|sha256)$/i.test(prefix)) return [];
  return [[prefix || 'value', String(value)]];
}

function niceScale(maximum: number): number {
  const exponent = 10 ** Math.floor(Math.log10(maximum));
  const normalized = maximum / exponent;
  const step = normalized >= 5 ? 5 : normalized >= 2 ? 2 : 1;
  return step * exponent;
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
:root{--report-control:#238be6;--report-check:#d97706;--report-map-bg:#f6f9fc}@page{size:A4 landscape;margin:10mm}*{box-sizing:border-box}body{margin:0;background:#fff;color:#18202d;font:11px system-ui,-apple-system,"Segoe UI",sans-serif}header{display:flex;align-items:flex-end;justify-content:space-between;gap:24px;padding:0 0 14px;border-bottom:3px solid #238be6}h1{margin:0;font-size:26px}header p{margin:4px 0 0;color:#5c6979}.eyebrow{color:#087dcc;font:700 9px ui-monospace,monospace;letter-spacing:.18em}.summary{text-align:right;line-height:1.7}section{margin-top:18px}h2{margin:0 0 8px;padding-bottom:4px;border-bottom:1px solid #b8c7d8;font-size:16px}.annex{margin-top:26px;padding:7px;background:#eaf2f9;border-top:2px solid #238be6;font-size:18px}h3{margin:12px 0 6px;font-size:12px}table{width:100%;border-collapse:collapse;font-size:8px;table-layout:auto}th,td{padding:4px 5px;border:1px solid #cbd5e0;text-align:left;vertical-align:top;overflow-wrap:anywhere}th{background:#eaf2f9;color:#34465a}td small{display:block;margin-top:2px;color:#66768a}code{display:block;font:7.5px ui-monospace,"Cascadia Mono",monospace;overflow-wrap:anywhere}dl{display:grid;grid-template-columns:max-content minmax(0,1fr);gap:3px 12px;margin:0}dt{color:#617085}dd{margin:0;font-weight:600}.cards{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-top:10px}.card{padding:9px;border:1px solid #cbd5e0;border-radius:5px;background:#f6f9fc}.card h3{margin-top:0}.optimization{break-before:auto;margin-top:14px;padding-top:2px}.note{color:#617085}.empty{color:#68778a;font-style:italic}.failure{color:#b42318}.residual-map{display:block;width:100%;height:auto;border:1px solid #cbd5e0}.residual-map text{fill:#34465a;font:9px system-ui,sans-serif}.residual-map .scale line{stroke:#34465a;stroke-width:2}footer{margin-top:22px;padding-top:8px;border-top:1px solid #cbd5e0;color:#617085;font-size:9px}`;
