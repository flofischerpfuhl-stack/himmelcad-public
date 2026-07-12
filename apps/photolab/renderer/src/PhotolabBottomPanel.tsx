import { Console } from '@himmelcad/console';
import type { HardwareCapabilities, PhotolabJob } from '@himmelcad/data';
import { Ban, CircleGauge, FileChartColumn, FileDown } from 'lucide-react';
import { useState, type ReactNode } from 'react';

import { GcpAccuracyPanel, type GcpAccuracyReport } from './GcpAccuracyPanel.js';
import styles from './PhotolabBottomPanel.module.css';

type BottomTab = 'console' | 'jobs' | 'accuracy' | 'report';

export interface PhotolabBottomPanelProps {
  jobs: readonly PhotolabJob[];
  onCommand: (raw: string) => void;
  onCancelJob: (jobId: string) => void;
  onCollapse: () => void;
  accuracyReport: GcpAccuracyReport | null;
  hardware: HardwareCapabilities | null;
  products: readonly ReportProduct[];
}

export interface ReportProduct {
  entityId: string;
  kind: string;
  format: string;
  relativePath: string;
  pointCount?: number;
}

export function PhotolabBottomPanel({
  jobs,
  onCommand,
  onCancelJob,
  onCollapse,
  accuracyReport,
  hardware,
  products,
}: PhotolabBottomPanelProps): JSX.Element {
  const [tab, setTab] = useState<BottomTab>('console');
  return (
    <section className={styles.root}>
      <nav className={styles.tabs} aria-label="PhotoLab results">
        <TabButton active={tab === 'console'} onClick={() => setTab('console')}>
          Console
        </TabButton>
        <TabButton active={tab === 'jobs'} onClick={() => setTab('jobs')}>
          Jobs
          {jobs.length > 0 && <span className={styles.count}>{jobs.length}</span>}
        </TabButton>
        <TabButton active={tab === 'accuracy'} onClick={() => setTab('accuracy')}>
          Accuracy
        </TabButton>
        <TabButton active={tab === 'report'} onClick={() => setTab('report')}>
          Report
        </TabButton>
      </nav>
      <div className={styles.content}>
        {tab === 'console' && (
          <Console hideBrand defaultLevel="info" onCommand={onCommand} onCollapse={onCollapse} />
        )}
        {tab === 'jobs' && <JobsView jobs={jobs} onCancelJob={onCancelJob} />}
        {tab === 'accuracy' && <GcpAccuracyPanel report={accuracyReport} />}
        {tab === 'report' && (
          <ReportView
            jobs={jobs}
            accuracyReport={accuracyReport}
            hardware={hardware}
            products={products}
          />
        )}
      </div>
    </section>
  );
}

function TabButton({
  active,
  children,
  onClick,
}: {
  active: boolean;
  children: ReactNode;
  onClick: () => void;
}): JSX.Element {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      className={`${styles.tab} ${active ? styles.tabActive : ''}`}
      onClick={onClick}
    >
      {children}
    </button>
  );
}

function JobsView({
  jobs,
  onCancelJob,
}: {
  jobs: readonly PhotolabJob[];
  onCancelJob: (jobId: string) => void;
}): JSX.Element {
  if (jobs.length === 0) {
    return (
      <EmptyState
        icon={<CircleGauge size={22} />}
        title="No running or stored jobs"
        text="Alignment and product runs appear here with real progress, checkpoints, and cancellation status."
      />
    );
  }
  return (
    <div className={styles.jobs}>
      {jobs.map((job) => {
        const fraction = overallFraction(job);
        const cancellable = ['queued', 'running', 'pauseRequested'].includes(job.state.kind);
        return (
          <article className={styles.job} key={job.id}>
            <div className={styles.jobMain}>
              <div className={styles.jobTitleRow}>
                <span className={styles.jobTitle}>{jobLabel(job)}</span>
                <span className={`${styles.state} ${styles[`state_${job.state.kind}`] ?? ''}`}>
                  {stateLabel(job)}
                </span>
              </div>
              <div className={styles.jobStage}>{job.progress.stage.label}</div>
              <div className={styles.progressTrack}>
                <span className={styles.progressFill} style={{ width: `${fraction * 100}%` }} />
              </div>
            </div>
            <span className={styles.percent}>{Math.round(fraction * 100)}%</span>
            <button
              type="button"
              className={styles.cancel}
              disabled={!cancellable}
              onClick={() => onCancelJob(job.id)}
              title="Cancel cooperatively; the latest complete checkpoint remains valid"
            >
              <Ban size={14} />
              Cancel
            </button>
          </article>
        );
      })}
    </div>
  );
}

function ReportView({
  jobs,
  accuracyReport,
  hardware,
  products,
}: {
  jobs: readonly PhotolabJob[];
  accuracyReport: GcpAccuracyReport | null;
  hardware: HardwareCapabilities | null;
  products: readonly ReportProduct[];
}): JSX.Element {
  if (jobs.length === 0) {
    return (
      <EmptyState
        icon={<FileChartColumn size={22} />}
        title="No processing runs recorded yet"
        text="Configuration hashes, input hashes, checkpoints, progress, failures, and accuracy statistics will appear here."
      />
    );
  }
  const save = async (format: 'html' | 'pdf'): Promise<void> => {
    const html = processingReportHtml(jobs, products, hardware, accuracyReport);
    await window.himmelcad?.reports.save({
      format,
      suggestedName: `himmelcad-photolab-report-${new Date().toISOString().slice(0, 10)}`,
      html,
    });
  };
  return (
    <div className={styles.jobs} aria-label="Reproducible processing report">
      <div className={styles.reportToolbar}>
        <span>Immutable hashes, runtimes, hardware, products, and survey accuracy</span>
        <button type="button" onClick={() => void save('html')}>
          <FileDown size={14} /> HTML
        </button>
        <button type="button" onClick={() => void save('pdf')}>
          <FileDown size={14} /> PDF
        </button>
      </div>
      {accuracyReport && (
        <article className={styles.job}>
          <div className={styles.jobMain}>
            <span className={styles.jobTitle}>GCP accuracy</span>
            <span className={styles.jobStage}>
              {accuracyReport.label} · {accuracyReport.processingSetLabel} ·{' '}
              {accuracyReport.cameraCount} cameras
            </span>
          </div>
          <code title={accuracyReport.optimizationSnapshotSha256}>
            {accuracyReport.optimizationSnapshotSha256.slice(0, 12)}
          </code>
        </article>
      )}
      {jobs.map((job) => (
        <article className={styles.job} key={job.id}>
          <div className={styles.jobMain}>
            <div className={styles.jobTitleRow}>
              <span className={styles.jobTitle}>{jobLabel(job)}</span>
              <span className={`${styles.state} ${styles[`state_${job.state.kind}`] ?? ''}`}>
                {stateLabel(job)}
              </span>
            </div>
            <span className={styles.jobStage}>
              {job.progress.stage.label} · config {job.configHash.slice(0, 12)} · input{' '}
              {job.inputHash.slice(0, 12)}
              {job.lastCheckpointSequence != null
                ? ` · checkpoint ${job.lastCheckpointSequence}`
                : ''}
            </span>
          </div>
          <span className={styles.percent}>{Math.round(overallFraction(job) * 100)}%</span>
        </article>
      ))}
    </div>
  );
}

function processingReportHtml(
  jobs: readonly PhotolabJob[],
  products: readonly ReportProduct[],
  hardware: HardwareCapabilities | null,
  accuracy: GcpAccuracyReport | null,
): string {
  const generated = new Date().toISOString();
  const jobRows = jobs
    .map((job) => {
      const duration =
        job.startedAtUnixMs != null && job.finishedAtUnixMs != null
          ? `${((job.finishedAtUnixMs - job.startedAtUnixMs) / 1000).toFixed(3)} s`
          : 'n/a';
      return `<tr><td>${escapeHtml(job.id)}</td><td>${escapeHtml(jobLabel(job))}</td><td>${escapeHtml(stateLabel(job))}</td><td>${duration}</td><td><code>${escapeHtml(job.configHash)}</code></td><td><code>${escapeHtml(job.inputHash)}</code></td><td>${job.lastCheckpointSequence ?? '—'}</td></tr>`;
    })
    .join('');
  const productRows = products
    .map(
      (product) =>
        `<tr><td>${escapeHtml(product.kind)}</td><td>${escapeHtml(product.format)}</td><td>${product.pointCount?.toLocaleString('en-US') ?? '—'}</td><td><code>${escapeHtml(product.entityId)}</code></td><td>${escapeHtml(product.relativePath)}</td></tr>`,
    )
    .join('');
  const accuracySection = accuracy
    ? `<h2>Survey accuracy</h2><p>${escapeHtml(accuracy.processingSetLabel)} · ${escapeHtml(accuracy.alignmentRunLabel)} · ${accuracy.cameraCount} cameras</p><p>Optimization snapshot: <code>${escapeHtml(accuracy.optimizationSnapshotSha256)}</code></p><h3>Controls</h3><pre>${escapeHtml(JSON.stringify(accuracy.control ?? null, null, 2))}</pre><h3>Checkpoints</h3><pre>${escapeHtml(JSON.stringify(accuracy.checkpoint ?? null, null, 2))}</pre><h3>Point residuals</h3><pre>${escapeHtml(JSON.stringify(accuracy.residuals, null, 2))}</pre>`
    : '<h2>Survey accuracy</h2><p>No GCP optimization result was published for this report.</p>';
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'"><title>HimmelCAD PhotoLab Processing Report</title><style>@page{size:A4;margin:12mm}body{font:12px system-ui,sans-serif;color:#172033}h1{color:#087dcc}h2{margin-top:24px;border-bottom:1px solid #c9d5e3;padding-bottom:4px}table{width:100%;border-collapse:collapse;font-size:9px}th,td{border:1px solid #ccd6e0;padding:5px;vertical-align:top;text-align:left}th{background:#edf5fb}code,pre{font-family:ui-monospace,monospace;overflow-wrap:anywhere}pre{white-space:pre-wrap;background:#f4f7fa;padding:8px}footer{margin-top:24px;color:#566273}</style></head><body><h1>HimmelCAD PhotoLab Processing Report</h1><p>Generated ${escapeHtml(generated)} · fully offline processing record</p><h2>Hardware</h2><pre>${escapeHtml(JSON.stringify(hardware, null, 2))}</pre><h2>Processing runs</h2><table><thead><tr><th>Job</th><th>Operation</th><th>State</th><th>Runtime</th><th>Configuration SHA-256</th><th>Input SHA-256</th><th>Checkpoint</th></tr></thead><tbody>${jobRows}</tbody></table><h2>Published products</h2><table><thead><tr><th>Product</th><th>Format</th><th>Points</th><th>Entity</th><th>Project path</th></tr></thead><tbody>${productRows}</tbody></table>${accuracySection}<footer>HimmelCAD PhotoLab · reproducible offline photogrammetry</footer></body></html>`;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function EmptyState({
  icon,
  title,
  text,
}: {
  icon: ReactNode;
  title: string;
  text: string;
}): JSX.Element {
  return (
    <div className={styles.empty}>
      <span className={styles.emptyIcon}>{icon}</span>
      <div>
        <strong>{title}</strong>
        <p>{text}</p>
      </div>
    </div>
  );
}

function overallFraction(job: PhotolabJob): number {
  const total = job.progress.metrics.totalUnits;
  const stageFraction = total ? Math.min(1, job.progress.metrics.completedUnits / total) : 0;
  return Math.min(
    1,
    (job.progress.stage.index + stageFraction) / Math.max(1, job.progress.stage.stageCount),
  );
}

function jobLabel(job: PhotolabJob): string {
  const labels: Record<PhotolabJob['kind'], string> = {
    alignPhotos: 'Align Photos',
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

function stateLabel(job: PhotolabJob): string {
  if (job.state.kind === 'failed') return `Failed · ${job.state.message}`;
  const labels: Record<Exclude<PhotolabJob['state']['kind'], 'failed'>, string> = {
    queued: 'Queued',
    running: 'Running',
    pauseRequested: 'Pausing',
    paused: 'Paused',
    cancelRequested: 'Cancellation requested',
    cancelled: 'Cancelled',
    completed: 'Completed',
  };
  return labels[job.state.kind];
}
