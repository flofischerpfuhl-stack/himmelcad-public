import { Console, logEvent } from '@himmelcad/console';
import type {
  AlignmentMergeCandidateRecord,
  CameraCalibrationGroupRecord,
  CaptureGroupRecord,
  HardwareCapabilities,
  MergedAlignmentRunRecord,
  OpenPhotolabProjectResult,
  PhotolabJob,
  ProcessingSetRecord,
  PublishedGcpOptimizationEntry,
} from '@himmelcad/data';
import { Checkbox, EmptyState, ExpandChevron, IslandTabs } from '@himmelcad/ui';
import { AlertTriangle, Ban, CheckCircle2, FileDown, RotateCcw } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';

import { GcpAccuracyPanel, type GcpAccuracyReport } from './GcpAccuracyPanel.js';
import styles from './PhotolabBottomPanel.module.css';
import {
  buildProcessingReportHtml,
  type ProcessingReportProduct,
  type ProcessingReportSurveyData,
} from './processingReport.js';

export type BottomTab = 'console' | 'jobs' | 'accuracy' | 'report';

export interface PhotolabBottomPanelProps {
  project: {
    id: string;
    name: string;
    formatVersion: number;
  };
  jobs: readonly PhotolabJob[];
  onCommand: (raw: string) => void;
  onCancelJob: (jobId: string) => void;
  onResumeJob: (historyJobId: string) => Promise<void>;
  resumeErrors: Readonly<Record<string, string>>;
  onCollapse: () => void;
  accuracyReport: GcpAccuracyReport | null;
  selectedPointId: string | null;
  onSelectPoint: (pointId: string) => void;
  hardware: HardwareCapabilities | null;
  products: readonly ReportProduct[];
  processingSets: readonly ProcessingSetRecord[];
  captureGroups: readonly CaptureGroupRecord[];
  calibrationGroups: readonly CameraCalibrationGroupRecord[];
  alignmentMerges: readonly MergedAlignmentRunRecord[];
  alignmentRuns: readonly AlignmentMergeCandidateRecord[];
  gcpOptimizations: readonly PublishedGcpOptimizationEntry[];
  autoExpandJobId: string | null | undefined;
  activeTab: BottomTab;
  onTabChange: (tab: BottomTab) => void;
  autoSwitchTabs: boolean;
  onAutoSwitchTabsChange: (enabled: boolean) => void;
}

export type ReportProduct = ProcessingReportProduct;

export function PhotolabBottomPanel({
  project,
  jobs,
  onCommand,
  onCancelJob,
  onResumeJob,
  resumeErrors,
  onCollapse,
  accuracyReport,
  selectedPointId,
  onSelectPoint,
  hardware,
  products,
  processingSets,
  captureGroups,
  calibrationGroups,
  alignmentMerges,
  alignmentRuns,
  gcpOptimizations,
  autoExpandJobId,
  activeTab: tab,
  onTabChange,
  autoSwitchTabs,
  onAutoSwitchTabsChange,
}: PhotolabBottomPanelProps): JSX.Element {
  const [hiddenTerminalJobIds, setHiddenTerminalJobIds] = useState<ReadonlySet<string>>(new Set());
  const visibleJobs = jobs.filter(
    (job) => !hiddenTerminalJobIds.has(job.id) || !isTerminalJob(job),
  );
  const visibleTerminalIds = visibleJobs.filter(isTerminalJob).map((job) => job.id);
  return (
    <section className={styles.root}>
      <div className={styles.tabs}>
        <IslandTabs
          variant="strip"
          ariaLabel="PhotoLab results"
          value={tab}
          onChange={(id) => onTabChange(id as BottomTab)}
          items={[
            { id: 'console', label: 'Console' },
            {
              id: 'jobs',
              label: 'Jobs',
              badge: visibleJobs.length > 0 ? visibleJobs.length : undefined,
            },
            { id: 'accuracy', label: 'Accuracy' },
            { id: 'report', label: 'Report' },
          ]}
        />
        <div className={styles.tabActions}>
          <Checkbox
            checked={autoSwitchTabs}
            onChange={(event) => onAutoSwitchTabsChange(event.currentTarget.checked)}
            label="Auto-switch tabs"
          />
          <button
            type="button"
            disabled={visibleTerminalIds.length === 0}
            onClick={() =>
              setHiddenTerminalJobIds((current) => new Set([...current, ...visibleTerminalIds]))
            }
          >
            Clear finished
          </button>
        </div>
      </div>
      <div className={styles.content}>
        {tab === 'console' && (
          <Console
            defaultLevel="info"
            brandSubtitle="PhotoLab · console"
            onCommand={onCommand}
            onCollapse={onCollapse}
          />
        )}
        {tab === 'jobs' && (
          <JobsView
            jobs={visibleJobs}
            onCancelJob={onCancelJob}
            onResumeJob={onResumeJob}
            resumeErrors={resumeErrors}
            autoExpandJobId={autoExpandJobId}
          />
        )}
        {tab === 'accuracy' && (
          <GcpAccuracyPanel
            report={accuracyReport}
            selectedPointId={selectedPointId}
            onSelectPoint={onSelectPoint}
          />
        )}
        {tab === 'report' && (
          <ReportView
            project={project}
            jobs={jobs}
            accuracyReport={accuracyReport}
            hardware={hardware}
            products={products}
            processingSets={processingSets}
            captureGroups={captureGroups}
            calibrationGroups={calibrationGroups}
            alignmentMerges={alignmentMerges}
            alignmentRuns={alignmentRuns}
            gcpOptimizations={gcpOptimizations}
          />
        )}
      </div>
    </section>
  );
}

function JobsView({
  jobs,
  onCancelJob,
  onResumeJob,
  resumeErrors,
  autoExpandJobId,
}: {
  jobs: readonly PhotolabJob[];
  onCancelJob: (jobId: string) => void;
  onResumeJob: (historyJobId: string) => Promise<void>;
  resumeErrors: Readonly<Record<string, string>>;
  autoExpandJobId: string | null | undefined;
}): JSX.Element {
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const [resuming, setResuming] = useState<ReadonlySet<string>>(new Set());
  const telemetryRef = useRef(new Map<string, JobTelemetry>());
  useEffect(() => {
    if (!autoExpandJobId) return;
    setExpanded((current) => {
      if (current.has(autoExpandJobId)) return current;
      const next = new Set(current);
      next.add(autoExpandJobId);
      return next;
    });
  }, [autoExpandJobId]);
  const now = Date.now();
  if (jobs.length === 0) {
    return (
      <EmptyState
        title="No jobs yet"
        hint="Alignment and product runs appear here with progress, checkpoints, and cancellation status."
      />
    );
  }
  return (
    <div className={styles.jobs}>
      {jobs.map((job) => {
        const telemetry = observeJob(telemetryRef.current, job, now);
        const fraction = overallFraction(job);
        const cancellable = ['queued', 'running'].includes(job.state.kind);
        const resumable =
          job.state.kind === 'failed' && job.state.code === 'interruptedRecoverable';
        const isExpanded = expanded.has(job.id);
        return (
          <article className={`${styles.job} ${isExpanded ? styles.jobExpanded : ''}`} key={job.id}>
            <div className={styles.jobMain}>
              <div className={styles.jobTitleRow}>
                <button
                  type="button"
                  className={styles.expand}
                  aria-expanded={isExpanded}
                  onClick={() => setExpanded((current) => toggleSet(current, job.id))}
                >
                  <ExpandChevron expanded={isExpanded} size={14} />
                  <span className={styles.jobTitle}>{jobLabel(job)}</span>
                </button>
                <span className={`${styles.state} ${styles[`state_${job.state.kind}`] ?? ''}`}>
                  {stateLabel(job)}
                </span>
              </div>
              <div className={styles.jobStage}>
                <span>
                  Stage {job.progress.stage.index + 1}/{job.progress.stage.stageCount}:{' '}
                  {job.progress.stage.label}
                  {stageFraction(job) != null
                    ? ` · ${Math.round((stageFraction(job) as number) * 100)}% of stage`
                    : ''}
                </span>
                {' · '}
                <span>{compactProgress(job, telemetry, now)}</span>
              </div>
              <div className={styles.progressTrack} title="Overall job progress">
                <span className={styles.progressFill} style={{ width: `${fraction * 100}%` }} />
              </div>
              {stageFraction(job) != null && (
                <div
                  className={`${styles.progressTrack} ${styles.progressTrackStage}`}
                  title="Current stage progress"
                >
                  <span
                    className={`${styles.progressFill} ${styles.progressFillStage}`}
                    style={{ width: `${(stageFraction(job) as number) * 100}%` }}
                  />
                </div>
              )}
              {resumeErrors[job.id] && (
                <div className={styles.jobInlineError}>{resumeErrors[job.id]}</div>
              )}
            </div>
            <span className={styles.percent} title="Overall · stage">
              {Math.round(fraction * 100)}%
              {stageFraction(job) != null
                ? ` · ${Math.round((stageFraction(job) as number) * 100)}%`
                : ''}
            </span>
            {resumable ? (
              <button
                type="button"
                className={styles.resume}
                disabled={resuming.has(job.id)}
                onClick={() => {
                  setResuming((current) => new Set(current).add(job.id));
                  void onResumeJob(job.id).finally(() => {
                    setResuming((current) => {
                      const next = new Set(current);
                      next.delete(job.id);
                      return next;
                    });
                  });
                }}
                title="Resume from the latest committed checkpoint"
              >
                <RotateCcw size={14} />
                {resuming.has(job.id) ? 'Resuming…' : 'Resume'}
              </button>
            ) : (
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
            )}
            {isExpanded && <JobDetails job={job} telemetry={telemetry} now={now} />}
          </article>
        );
      })}
    </div>
  );
}

function JobDetails({
  job,
  telemetry,
  now,
}: {
  job: PhotolabJob;
  telemetry: JobTelemetry;
  now: number;
}): JSX.Element {
  const metrics = job.progress.metrics;
  const stateMessage =
    job.state.kind === 'failed' ? `${job.state.code}: ${job.state.message}` : null;
  const stateMessageLabel =
    job.state.kind === 'failed' && job.state.code.startsWith('interrupted') ? 'Recovery' : 'Error';
  return (
    <div className={styles.jobDetails}>
      <div>
        <span>Stage</span>
        <strong>
          {job.progress.stage.index + 1} / {job.progress.stage.stageCount} ·{' '}
          {job.progress.stage.kind}
        </strong>
      </div>
      <div>
        <span>Work</span>
        <strong>
          {metrics.completedUnits.toLocaleString('en-US')}
          {metrics.totalUnits == null ? '' : ` / ${metrics.totalUnits.toLocaleString('en-US')}`}
        </strong>
      </div>
      <div>
        <span>Bytes</span>
        <strong>
          {formatBytes(metrics.completedBytes)}
          {metrics.totalBytes == null ? '' : ` / ${formatBytes(metrics.totalBytes)}`}
        </strong>
      </div>
      <div>
        <span>Checkpoint</span>
        <strong>{job.lastCheckpointSequence ?? '—'}</strong>
      </div>
      <div>
        <span>Configuration</span>
        <code title={job.configHash}>{job.configHash}</code>
      </div>
      <div>
        <span>Input</span>
        <code title={job.inputHash}>{job.inputHash}</code>
      </div>
      <div>
        <span>Started</span>
        <strong>
          {job.startedAtUnixMs == null
            ? 'Queued'
            : new Date(job.startedAtUnixMs).toLocaleString('en-US')}
        </strong>
      </div>
      <div>
        <span>Elapsed</span>
        <strong>
          {formatDuration(Math.max(0, now - (job.startedAtUnixMs ?? job.createdAtUnixMs)))}
        </strong>
      </div>
      <div>
        <span>Stage ETA</span>
        <strong>{stageEta(telemetry)}</strong>
      </div>
      <div>
        <span>Throughput</span>
        <strong>{throughputLabel(job, telemetry)}</strong>
      </div>
      <div className={styles.jobActivity}>
        <span>Activity</span>
        <ol>
          {telemetry.stages.map((stage) => (
            <li
              key={`${stage.index}:${stage.label}`}
              className={stage.finishedAt == null ? styles.activityCurrent : styles.activityDone}
            >
              <span>{stage.label}</span>
              <code>
                {stage.completedUnits.toLocaleString('en-US')}
                {stage.totalUnits == null ? '' : ` / ${stage.totalUnits.toLocaleString('en-US')}`}
                {' · '}
                {formatDuration((stage.finishedAt ?? now) - stage.startedAt)}
              </code>
            </li>
          ))}
        </ol>
      </div>
      {stateMessage && (
        <div className={styles.jobFailure}>
          <span>{stateMessageLabel}</span>
          <strong>{stateMessage}</strong>
        </div>
      )}
    </div>
  );
}

interface StageActivity {
  index: number;
  label: string;
  startedAt: number;
  finishedAt?: number;
  completedUnits: number;
  totalUnits: number | undefined;
}

interface JobTelemetry {
  stages: StageActivity[];
  stageIndex: number;
  lastUnits: number;
  lastSampleAt: number;
  ratePerSecond: number | undefined;
}

function observeJob(
  telemetryByJob: Map<string, JobTelemetry>,
  job: PhotolabJob,
  now: number,
): JobTelemetry {
  const metrics = job.progress.metrics;
  const stage = job.progress.stage;
  let telemetry = telemetryByJob.get(job.id);
  if (!telemetry) {
    telemetry = {
      stages: [],
      stageIndex: stage.index,
      lastUnits: metrics.completedUnits,
      lastSampleAt: now,
      ratePerSecond: undefined,
    };
    telemetryByJob.set(job.id, telemetry);
  }
  let activity = telemetry.stages.at(-1);
  if (activity?.index !== stage.index || activity?.label !== stage.label) {
    if (activity && activity.finishedAt == null) activity.finishedAt = now;
    activity = {
      index: stage.index,
      label: stage.label,
      startedAt: now,
      completedUnits: metrics.completedUnits,
      totalUnits: metrics.totalUnits,
    };
    telemetry.stages.push(activity);
    telemetry.stageIndex = stage.index;
    telemetry.lastUnits = metrics.completedUnits;
    telemetry.lastSampleAt = now;
    telemetry.ratePerSecond = undefined;
  } else {
    const elapsedSeconds = (now - telemetry.lastSampleAt) / 1_000;
    const completedDelta = metrics.completedUnits - telemetry.lastUnits;
    if (completedDelta > 0 && elapsedSeconds > 0) {
      const observedRate = completedDelta / elapsedSeconds;
      telemetry.ratePerSecond =
        telemetry.ratePerSecond == null
          ? observedRate
          : telemetry.ratePerSecond * 0.7 + observedRate * 0.3;
      telemetry.lastUnits = metrics.completedUnits;
      telemetry.lastSampleAt = now;
    }
    activity.completedUnits = metrics.completedUnits;
    activity.totalUnits = metrics.totalUnits ?? activity.totalUnits;
  }
  if (!['queued', 'running', 'cancelRequested'].includes(job.state.kind)) {
    activity.finishedAt ??= job.finishedAtUnixMs ?? now;
  }
  return telemetry;
}

function compactProgress(job: PhotolabJob, telemetry: JobTelemetry, now: number): string {
  const { completedUnits, totalUnits } = job.progress.metrics;
  const overallPct = Math.round(overallFraction(job) * 100);
  const stagePct = stageFraction(job);
  const work =
    totalUnits == null
      ? `overall ${overallPct}%`
      : `overall ${overallPct}% · stage ${completedUnits.toLocaleString('en-US')}/${totalUnits.toLocaleString('en-US')}` +
        (stagePct != null ? ` (${Math.round(stagePct * 100)}%)` : '');
  const eta = stageEta(telemetry);
  const elapsed = formatDuration(Math.max(0, now - (job.startedAtUnixMs ?? job.createdAtUnixMs)));
  return [work, eta === 'Estimating…' || eta === '—' ? null : `ETA ${eta}`, elapsed]
    .filter(Boolean)
    .join(' · ');
}

function stageEta(telemetry: JobTelemetry): string {
  const stage = telemetry.stages.at(-1);
  if (!stage || stage.finishedAt != null) return '—';
  if (stage.totalUnits == null || telemetry.ratePerSecond == null || telemetry.ratePerSecond <= 0) {
    return 'Estimating…';
  }
  const remaining = Math.max(0, stage.totalUnits - stage.completedUnits);
  return formatDuration((remaining / telemetry.ratePerSecond) * 1_000);
}

function throughputLabel(job: PhotolabJob, telemetry: JobTelemetry): string {
  const rate = telemetry.ratePerSecond;
  if (rate == null || rate <= 0) return 'Estimating…';
  const noun = job.progress.stage.kind === 'featureExtraction' ? 'images' : 'units';
  return `${(rate * 60).toFixed(rate * 60 >= 10 ? 0 : 1)} ${noun}/min`;
}

function formatDuration(milliseconds: number): string {
  if (!Number.isFinite(milliseconds) || milliseconds < 0) return '—';
  const totalSeconds = Math.round(milliseconds / 1_000);
  const hours = Math.floor(totalSeconds / 3_600);
  const minutes = Math.floor((totalSeconds % 3_600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return `${hours}h ${String(minutes).padStart(2, '0')}m`;
  if (minutes > 0) return `${minutes}m ${String(seconds).padStart(2, '0')}s`;
  return `${seconds}s`;
}

function toggleSet(current: ReadonlySet<string>, value: string): ReadonlySet<string> {
  const next = new Set(current);
  if (next.has(value)) next.delete(value);
  else next.add(value);
  return next;
}

function formatBytes(value: number): string {
  if (value < 1024) return `${value} B`;
  if (value < 1024 ** 2) return `${(value / 1024).toFixed(1)} KiB`;
  if (value < 1024 ** 3) return `${(value / 1024 ** 2).toFixed(1)} MiB`;
  return `${(value / 1024 ** 3).toFixed(2)} GiB`;
}

function ReportView({
  project,
  jobs,
  accuracyReport,
  hardware,
  products,
  processingSets,
  captureGroups,
  calibrationGroups,
  alignmentMerges,
  alignmentRuns,
  gcpOptimizations,
}: {
  project: {
    id: string;
    name: string;
    formatVersion: number;
  };
  jobs: readonly PhotolabJob[];
  accuracyReport: GcpAccuracyReport | null;
  hardware: HardwareCapabilities | null;
  products: readonly ReportProduct[];
  processingSets: readonly ProcessingSetRecord[];
  captureGroups: readonly CaptureGroupRecord[];
  calibrationGroups: readonly CameraCalibrationGroupRecord[];
  alignmentMerges: readonly MergedAlignmentRunRecord[];
  alignmentRuns: readonly AlignmentMergeCandidateRecord[];
  gcpOptimizations: readonly PublishedGcpOptimizationEntry[];
}): JSX.Element {
  const [savingFormat, setSavingFormat] = useState<'html' | 'pdf' | null>(null);
  const [saveResult, setSaveResult] = useState<{ kind: 'saved' | 'error'; message: string } | null>(
    null,
  );
  const save = async (format: 'html' | 'pdf'): Promise<void> => {
    const api = window.himmelcad;
    if (!api) {
      setSaveResult({ kind: 'error', message: 'Desktop report export is unavailable.' });
      logEvent('error', 'renderer', 'Processing report export is unavailable in this runtime.');
      return;
    }
    const startedAt = performance.now();
    setSavingFormat(format);
    setSaveResult(null);
    logEvent('info', 'renderer', `Exporting processing report as ${format.toUpperCase()}`);
    try {
      const snapshot = await api.sidecar.call<OpenPhotolabProjectResult>(
        'photolab.project.snapshot',
      );
      let surveyData: ProcessingReportSurveyData | null = null;
      let surveyDataUnavailableReason: string | undefined;
      try {
        surveyData = await api.sidecar.call<ProcessingReportSurveyData>(
          'photolab.report.surveyData',
          {},
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : '';
        surveyDataUnavailableReason = /not allow/i.test(message)
          ? 'Survey data unavailable — query not allowlisted'
          : `Survey data unavailable — ${message || 'query failed'}`;
      }
      const snapshotTimestamp = new Date(snapshot.manifest.modifiedUnixMs);
      const saved = await api.reports.save({
        format,
        suggestedName: `${project.name}-processing-report-${snapshotTimestamp.toISOString().slice(0, 10)}`,
        html: buildProcessingReportHtml({
          project,
          jobs,
          products,
          hardware,
          accuracy: accuracyReport,
          processingSets,
          captureGroups,
          calibrationGroups,
          alignmentMerges,
          alignmentRuns,
          gcpOptimizations,
          surveyData,
          surveyDataUnavailableReason,
          generatedAt: snapshotTimestamp,
          generatedAtSource: 'Project snapshot modifiedUnixMs (last autosave/save timestamp)',
        }),
      });
      if (saved) {
        const durationMs = performance.now() - startedAt;
        setSaveResult({ kind: 'saved', message: `${format.toUpperCase()} report saved.` });
        logEvent(
          'info',
          'renderer',
          `Processing report saved as ${format.toUpperCase()} · ${durationMs.toFixed(1)} ms`,
        );
      } else {
        logEvent('info', 'renderer', 'Processing report export cancelled.');
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Report export failed.';
      setSaveResult({
        kind: 'error',
        message,
      });
      logEvent('error', 'renderer', `Processing report export failed: ${message}`);
    } finally {
      setSavingFormat(null);
    }
  };
  return (
    <div className={styles.jobs} aria-label="Reproducible processing report">
      <div className={styles.reportToolbar}>
        <span>Immutable hashes, runtimes, hardware, products, and survey accuracy</span>
        <button type="button" disabled={savingFormat != null} onClick={() => void save('html')}>
          <FileDown size={14} /> HTML
        </button>
        <button type="button" disabled={savingFormat != null} onClick={() => void save('pdf')}>
          <FileDown size={14} /> PDF
        </button>
      </div>
      {savingFormat && (
        <div className={styles.reportProgressGroup} role="status">
          <div>Preparing and writing {savingFormat.toUpperCase()} report…</div>
          <div
            className={styles.reportProgress}
            role="progressbar"
            aria-label={`Exporting ${savingFormat.toUpperCase()} processing report`}
          >
            <span />
          </div>
        </div>
      )}
      {saveResult && (
        <div
          className={`${styles.reportStatus} ${saveResult.kind === 'error' ? styles.reportStatusError : ''}`}
          role={saveResult.kind === 'error' ? 'alert' : 'status'}
        >
          {saveResult.kind === 'error' ? <AlertTriangle size={14} /> : <CheckCircle2 size={14} />}
          {saveResult.message}
        </div>
      )}
      <LineageOverview
        processingSets={processingSets}
        alignmentRuns={alignmentRuns}
        gcpOptimizations={gcpOptimizations}
        alignmentMerges={alignmentMerges}
        products={products}
      />
      {jobs.length === 0 && (
        <EmptyState
          title="No processing runs recorded yet"
          hint="The exported report still records current hardware, scope, products, and survey accuracy."
        />
      )}
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

function LineageOverview({
  processingSets,
  alignmentRuns,
  gcpOptimizations,
  alignmentMerges,
  products,
}: {
  processingSets: readonly ProcessingSetRecord[];
  alignmentRuns: readonly AlignmentMergeCandidateRecord[];
  gcpOptimizations: readonly PublishedGcpOptimizationEntry[];
  alignmentMerges: readonly MergedAlignmentRunRecord[];
  products: readonly ReportProduct[];
}): JSX.Element {
  if (alignmentRuns.length === 0 && alignmentMerges.length === 0 && products.length === 0)
    return <></>;
  const processingSetNames = new Map(processingSets.map((set) => [set.entityId, set.name]));
  return (
    <section className={styles.lineageOverview} aria-label="Alignment and calibration lineage">
      <div className={styles.lineageHeading}>Alignment and calibration lineage</div>
      {alignmentRuns.map((alignment) => {
        const revisions = gcpOptimizations.filter(
          (entry) => entry.optimization.sourceAlignmentEntityId === alignment.entityId,
        );
        return (
          <article className={styles.lineageCard} key={alignment.entityId}>
            <div>
              <strong>{alignment.name}</strong>
              <span>
                {alignment.cameraEntityIds.length} images ·{' '}
                {alignment.processingSetId
                  ? (processingSetNames.get(alignment.processingSetId) ?? alignment.processingSetId)
                  : 'ad-hoc / project-wide'}
              </span>
            </div>
            <details>
              <summary>
                {alignment.calibrationGroups?.length ?? alignment.calibrationGroupIds?.length ?? 0}{' '}
                frozen intrinsics groups · {revisions.length} GCP revisions
              </summary>
              <code>Alignment {alignment.entityId}</code>
              <code>Job {alignment.jobId}</code>
              {(alignment.calibrationGroups ?? []).map((group) => (
                <div key={group.groupId}>
                  <strong>{group.groupId}</strong>
                  <code>{group.cameraEntityIds.join(', ')}</code>
                </div>
              ))}
              {revisions.map((entry) => (
                <div key={entry.entityId}>
                  <strong>GCP revision {entry.optimization.operationId}</strong>
                  <code>Entity {entry.entityId}</code>
                  <code>Snapshot {entry.optimization.snapshotSha256}</code>
                </div>
              ))}
            </details>
          </article>
        );
      })}
      {alignmentMerges.map((merge) => (
        <article className={styles.lineageCard} key={merge.entityId}>
          <div>
            <strong>{merge.name}</strong>
            <span>
              {merge.state} · {merge.cameraEntityIds.length} images ·{' '}
              {merge.inputAlignmentEntityIds.length} independent alignments
            </span>
          </div>
          <details>
            <summary>
              {merge.inputGcpOptimizationEntityIds.length} pinned GCP revisions ·{' '}
              {merge.connections.length} connections
            </summary>
            {merge.inputAlignmentEntityIds.map((entityId) => (
              <code key={entityId}>Alignment {entityId}</code>
            ))}
            {merge.inputGcpOptimizationEntityIds.map((entityId) => (
              <code key={entityId}>GCP revision {entityId}</code>
            ))}
            <code>Lineage {merge.lineageSha256}</code>
          </details>
        </article>
      ))}
      {products.map((product) => (
        <article className={styles.lineageCard} key={product.entityId}>
          <div>
            <strong>{product.kind}</strong>
            <span>{product.format} · published product</span>
          </div>
          <details>
            <summary>Exact product lineage</summary>
            <code>Product {product.entityId}</code>
            <code>Alignment {product.sourceAlignmentEntityId ?? 'legacy / unavailable'}</code>
            <code>Processing set {product.processingSetId ?? 'merged / project-wide'}</code>
            <code>GCP revision {product.gcpOptimizationEntityId ?? 'none'}</code>
            {product.gcpOptimizationSnapshotSha256 && (
              <code>GCP snapshot {product.gcpOptimizationSnapshotSha256}</code>
            )}
          </details>
        </article>
      ))}
    </section>
  );
}

function stageFraction(job: PhotolabJob): number | null {
  const total = job.progress.metrics.totalUnits;
  if (total == null || total <= 0) return null;
  return Math.min(1, job.progress.metrics.completedUnits / total);
}

function overallFraction(job: PhotolabJob): number {
  const within = stageFraction(job) ?? 0;
  return Math.min(
    1,
    (job.progress.stage.index + within) / Math.max(1, job.progress.stage.stageCount),
  );
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

function stateLabel(job: PhotolabJob): string {
  if (job.state.kind === 'failed') {
    if (job.state.code === 'interruptedRecoverable') {
      return `Interrupted · Resume available from checkpoint ${job.lastCheckpointSequence ?? '—'}`;
    }
    if (job.state.code === 'interrupted') return 'Interrupted · Restart required';
    return `Failed · ${job.state.message}`;
  }
  const labels: Record<Exclude<PhotolabJob['state']['kind'], 'failed'>, string> = {
    queued: 'Queued',
    running: 'Running',
    pauseRequested: 'Running',
    paused: 'Running',
    cancelRequested: 'Cancellation requested',
    cancelled: 'Cancelled',
    completed: 'Completed',
  };
  return labels[job.state.kind];
}

function isTerminalJob(job: PhotolabJob): boolean {
  return ['completed', 'failed', 'cancelled'].includes(job.state.kind);
}
