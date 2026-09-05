import { AlertTriangle, Check, CircleX, Clock3, X } from 'lucide-react';

import { Button } from './Button.js';
import { ProgressBar } from './ProgressBar.js';
import { SpinnerVisual } from './Spinner.js';
import { Tooltip } from './Tooltip.js';
import styles from './JobsSurfaces.module.css';

export interface JobSurfaceItem {
  readonly id: string;
  readonly label: string;
  readonly state:
    | 'pending-registration'
    | 'needs-input'
    | 'running'
    | 'cancelling'
    | 'completed'
    | 'failed'
    | 'cancelled';
  readonly phase: string;
  readonly fraction: number | null;
  readonly registeredAtUnixMs: number | null;
  readonly finishedAtUnixMs: number | null;
  readonly suppressChip: boolean;
  readonly cancellation: {
    readonly cancellable: boolean;
    readonly reason?: string;
    readonly atNextSafeBoundary?: boolean;
  };
}

const COMPLETED_RETENTION_MS = 30_000;
export const JOBS_CHIP_LINGER_MS = 4_000;

type JobsChipTone = 'accent' | 'warning' | 'error' | 'success';

interface JobsChipPresentation {
  readonly job: JobSurfaceItem;
  readonly label: string;
  readonly tone: JobsChipTone;
}

export function JobsStatusChip({
  jobs,
  now = Date.now(),
  debounceMs = 300,
  lingerMs = JOBS_CHIP_LINGER_MS,
  onClick,
}: {
  readonly jobs: readonly JobSurfaceItem[];
  readonly now?: number;
  readonly debounceMs?: number;
  readonly lingerMs?: number;
  readonly onClick: () => void;
}): JSX.Element | null {
  const presentation = jobsChipPresentation(jobs, now, debounceMs, lingerMs);
  if (!presentation) return null;
  const { job: lead, label, tone } = presentation;
  const percent = lead.fraction === null ? null : Math.round(lead.fraction * 100);
  return (
    <button
      type="button"
      className={styles.chip}
      data-tone={tone}
      onClick={onClick}
      aria-label={`Jobs: ${label}`}
    >
      {percent === null ? (
        <SpinnerVisual label={lead.phase} size="small" />
      ) : (
        <span className={styles.chipProgress}>
          <ProgressBar value={lead.fraction!} ariaLabel={`${lead.label} progress`} />
        </span>
      )}
      <span className={styles.chipLabel}>{label}</span>
    </button>
  );
}

export function JobsIsland({
  jobs,
  now = Date.now(),
  completedRetentionMs = COMPLETED_RETENTION_MS,
  onCancel,
  onRespond,
  onClearFinished,
}: {
  readonly jobs: readonly JobSurfaceItem[];
  readonly now?: number;
  readonly completedRetentionMs?: number;
  readonly onCancel: (id: string) => void;
  readonly onRespond: (id: string) => void;
  readonly onClearFinished?: () => void;
}): JSX.Element {
  const visible = jobs.filter(
    (job) => job.finishedAtUnixMs === null || now - job.finishedAtUnixMs < completedRetentionMs,
  );
  const collapsed = jobs.length - visible.length;
  return (
    <section className={styles.island} aria-label="Jobs">
      <header className={styles.header}>
        <h2>Jobs</h2>
      </header>
      <div className={styles.rows}>
        {visible.map((job) => (
          <JobRow key={job.id} job={job} onCancel={onCancel} onRespond={onRespond} />
        ))}
        {visible.length === 0 && collapsed === 0 ? <p className={styles.empty}>No jobs</p> : null}
      </div>
      {collapsed > 0 ? (
        <footer className={styles.finished}>
          <span>{collapsed} finished</span>
          <button type="button" onClick={onClearFinished}>
            Clear
          </button>
        </footer>
      ) : null}
    </section>
  );
}

function JobRow({
  job,
  onCancel,
  onRespond,
}: {
  readonly job: JobSurfaceItem;
  readonly onCancel: (id: string) => void;
  readonly onRespond: (id: string) => void;
}): JSX.Element {
  const disabled = !job.cancellation.cancellable && !job.cancellation.atNextSafeBoundary;
  return (
    <article className={styles.row} data-state={job.state}>
      <span className={styles.glyph} aria-hidden="true">
        {statusGlyph(job)}
      </span>
      <div className={styles.copy}>
        <strong>{job.label}</strong>
        <span className={styles.phase}>{job.phase}</span>
        {job.state === 'needs-input' ? (
          <Button size="small" variant="primary" onClick={() => onRespond(job.id)}>
            Respond
          </Button>
        ) : null}
      </div>
      <div className={styles.progress}>
        {job.state === 'needs-input' ? (
          <span>waiting for input</span>
        ) : terminal(job.state) ? (
          <span>{job.state}</span>
        ) : (
          <div className={styles.progressValue}>
            {job.fraction === null ? <span>in progress</span> : null}
            <ProgressBar
              value={job.fraction ?? 0}
              indeterminate={job.fraction === null}
              ariaLabel={`${job.label} progress`}
            />
          </div>
        )}
      </div>
      {!terminal(job.state) ? (
        <Tooltip
          content={
            disabled ? (job.cancellation.reason ?? 'Cancellation unavailable') : 'Cancel job'
          }
        >
          <span tabIndex={disabled ? 0 : -1}>
            <button
              type="button"
              className={styles.cancel}
              aria-label={`Cancel ${job.label}`}
              disabled={disabled || job.state === 'cancelling'}
              onClick={() => onCancel(job.id)}
            >
              <X size={14} />
            </button>
          </span>
        </Tooltip>
      ) : (
        <span className={styles.cancelSpacer} />
      )}
    </article>
  );
}

function statusGlyph(job: JobSurfaceItem): JSX.Element {
  if (job.state === 'failed') return <CircleX size={20} />;
  if (job.state === 'completed') return <Check size={20} />;
  if (job.state === 'cancelled') return <X size={20} />;
  if (job.state === 'needs-input') return <AlertTriangle size={20} />;
  if (job.state === 'cancelling') return <Clock3 size={20} />;
  return <SpinnerVisual label={job.phase} size="medium" />;
}

function terminal(state: JobSurfaceItem['state']): boolean {
  return state === 'completed' || state === 'failed' || state === 'cancelled';
}

function jobsChipPresentation(
  jobs: readonly JobSurfaceItem[],
  now: number,
  debounceMs: number,
  lingerMs: number,
): JobsChipPresentation | null {
  const eligible = jobs.filter(
    (job) =>
      !job.suppressChip &&
      job.registeredAtUnixMs !== null &&
      now - job.registeredAtUnixMs >= debounceMs,
  );
  const failed = mostRecent(eligible.filter((job) => job.state === 'failed'));
  if (failed) return { job: failed, label: `Job failed — ${failed.label}`, tone: 'error' };

  const active = eligible.filter((job) => !terminal(job.state));
  const cancelling = active.find((job) => job.state === 'cancelling');
  if (cancelling) return { job: cancelling, label: 'Cancelling…', tone: 'warning' };
  const waiting = active.find((job) => job.state === 'needs-input');
  if (waiting) {
    return { job: waiting, label: `Needs input · ${waiting.label}`, tone: 'warning' };
  }
  if (active.length > 1) {
    return { job: active[0]!, label: `${active.length} jobs running`, tone: 'accent' };
  }
  if (active.length === 1) {
    const lead = active[0]!;
    const percent = lead.fraction === null ? '' : ` ${Math.round(lead.fraction * 100)} %`;
    return {
      job: lead,
      label: `1 job running · ${lead.label}${percent}`,
      tone: 'accent',
    };
  }

  const completed = mostRecent(
    eligible.filter(
      (job) =>
        job.state === 'completed' &&
        job.finishedAtUnixMs !== null &&
        now - job.finishedAtUnixMs <= lingerMs,
    ),
  );
  return completed
    ? { job: completed, label: `Job completed — ${completed.label}`, tone: 'success' }
    : null;
}

function mostRecent(jobs: readonly JobSurfaceItem[]): JobSurfaceItem | undefined {
  return [...jobs].sort(
    (left, right) =>
      (right.finishedAtUnixMs ?? right.registeredAtUnixMs ?? 0) -
      (left.finishedAtUnixMs ?? left.registeredAtUnixMs ?? 0),
  )[0];
}
