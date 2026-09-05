export const JOB_REGISTRATION_THRESHOLD_MS = 1_000;
export const JOB_CHIP_DEBOUNCE_MS = 300;
export const JOB_FAST_COMPLETION_MS = 1_000;
export const JOB_COMPLETED_RETENTION_MS = 30_000;

export type JobState =
  | 'pending-registration'
  | 'needs-input'
  | 'running'
  | 'cancelling'
  | 'completed'
  | 'failed'
  | 'cancelled';

export interface JobCancellation {
  readonly cancellable: boolean;
  /** Required whenever cancellation is unavailable. */
  readonly reason?: string;
  /** True while the owner is crossing a short atomic unit. */
  readonly atNextSafeBoundary?: boolean;
}

export interface AppJob {
  readonly id: string;
  readonly label: string;
  readonly owner: string;
  readonly state: JobState;
  readonly phase: string;
  readonly fraction: number | null;
  readonly progressKey: string | null;
  readonly cancellation: JobCancellation;
  readonly createdAtUnixMs: number;
  readonly registeredAtUnixMs: number | null;
  readonly finishedAtUnixMs: number | null;
  readonly error: string | null;
  readonly resultLabel: string | null;
  readonly suppressChip: boolean;
  readonly context?: Readonly<Record<string, string | number | boolean | null>>;
}

export interface RegisterJobInput {
  readonly id: string;
  readonly label: string;
  readonly owner: string;
  readonly phase?: string;
  readonly expectedDurationMs?: number;
  readonly needsInput?: boolean;
  readonly progressKey?: string;
  readonly cancellable: boolean;
  readonly cancellationReason?: string;
  readonly context?: Readonly<Record<string, string | number | boolean | null>>;
}

export type JobEvent =
  | { readonly kind: 'snapshot'; readonly jobs: readonly AppJob[] }
  | { readonly kind: 'started' | 'updated'; readonly job: AppJob }
  | { readonly kind: 'completed' | 'failed' | 'cancelled'; readonly job: AppJob };

export interface JobBridge {
  list(): Promise<readonly AppJob[]>;
  cancel(id: string): Promise<AppJob>;
  respond(id: string): Promise<AppJob>;
  onEvent(listener: (event: JobEvent) => void): () => void;
}

export interface JobOwnerController {
  cancel?: (job: AppJob) => void | Promise<void>;
  respond?: (job: AppJob) => void | Promise<void>;
}

type Clock = () => number;
type Timer = ReturnType<typeof setTimeout>;

/** Product-neutral registry. Electron main owns one instance for its lifetime. */
export class JobRegistry {
  private readonly jobs = new Map<string, AppJob>();
  private readonly controllers = new Map<string, JobOwnerController>();
  private readonly listeners = new Set<(event: JobEvent) => void>();
  private readonly timers = new Map<string, Timer>();

  constructor(private readonly now: Clock = Date.now) {}

  register(input: RegisterJobInput, controller: JobOwnerController = {}): AppJob {
    if (this.jobs.has(input.id)) throw new Error(`job already exists: ${input.id}`);
    if (!input.cancellable && !input.cancellationReason?.trim()) {
      throw new Error('a non-cancellable job must name the reason');
    }
    const now = this.now();
    const immediate = input.needsInput || (input.expectedDurationMs ?? 0) > JOB_REGISTRATION_THRESHOLD_MS;
    const job: AppJob = {
      id: input.id,
      label: input.label,
      owner: input.owner,
      state: immediate ? (input.needsInput ? 'needs-input' : 'running') : 'pending-registration',
      phase: input.phase ?? (input.needsInput ? 'Waiting for input' : 'Starting'),
      fraction: null,
      progressKey: input.progressKey ?? null,
      cancellation: {
        cancellable: input.cancellable,
        ...(input.cancellationReason ? { reason: input.cancellationReason } : {}),
      },
      createdAtUnixMs: now,
      registeredAtUnixMs: immediate ? now : null,
      finishedAtUnixMs: null,
      error: null,
      resultLabel: null,
      suppressChip: false,
      ...(input.context ? { context: input.context } : {}),
    };
    this.jobs.set(job.id, job);
    this.controllers.set(job.id, controller);
    if (immediate) this.emit({ kind: 'started', job });
    else {
      this.timers.set(
        job.id,
        setTimeout(() => this.promote(job.id), JOB_REGISTRATION_THRESHOLD_MS + 1),
      );
    }
    return job;
  }

  list(options: { includePending?: boolean } = {}): readonly AppJob[] {
    return [...this.jobs.values()]
      .filter((job) => options.includePending || job.state !== 'pending-registration')
      .sort((left, right) => left.createdAtUnixMs - right.createdAtUnixMs);
  }

  get(id: string): AppJob {
    const job = this.jobs.get(id);
    if (!job) throw new Error(`job not found: ${id}`);
    return job;
  }

  update(
    id: string,
    patch: Partial<Pick<AppJob, 'phase' | 'fraction' | 'progressKey' | 'cancellation'>>,
  ): AppJob {
    let current = this.get(id);
    if (current.state === 'pending-registration') current = this.promote(id);
    const fraction = patch.fraction;
    const job = this.replace(id, {
      ...current,
      ...patch,
      ...(fraction === undefined
        ? {}
        : { fraction: fraction === null ? null : Math.max(0, Math.min(1, fraction)) }),
    });
    this.emit({ kind: 'updated', job });
    return job;
  }

  updateByProgressKey(progressKey: string, fraction: number, phase: string): AppJob | null {
    const job = [...this.jobs.values()].find((candidate) => candidate.progressKey === progressKey);
    return job ? this.update(job.id, { fraction, phase }) : null;
  }

  needsInput(id: string, phase = 'Waiting for input'): AppJob {
    const current = this.get(id);
    if (isTerminal(current.state)) return current;
    return this.transition(id, 'needs-input', { phase });
  }

  async respond(id: string): Promise<AppJob> {
    const current = this.get(id);
    if (current.state !== 'needs-input') throw new Error('job is not waiting for input');
    await this.controllers.get(id)?.respond?.(current);
    return this.transition(id, 'running', { phase: 'Resuming' });
  }

  async cancel(id: string): Promise<AppJob> {
    const current = this.get(id);
    if (isTerminal(current.state)) return current;
    if (!current.cancellation.cancellable) {
      if (!current.cancellation.atNextSafeBoundary) {
        throw new Error(current.cancellation.reason ?? 'This job cannot be cancelled');
      }
      const job = this.transition(id, 'cancelling', {
        phase: 'Cancelling at next safe boundary',
      });
      await this.controllers.get(id)?.cancel?.(job);
      return job;
    }
    const job = this.transition(id, 'cancelling', { phase: 'Cancelling' });
    await this.controllers.get(id)?.cancel?.(job);
    return job;
  }

  complete(id: string, resultLabel?: string): AppJob {
    return this.finish(id, 'completed', { resultLabel: resultLabel ?? null });
  }

  fail(id: string, error: string): AppJob {
    return this.finish(id, 'failed', { error, phase: 'Failed' });
  }

  cancelled(id: string): AppJob {
    return this.finish(id, 'cancelled', { phase: 'Cancelled' });
  }

  clearFinished(): void {
    for (const [id, job] of this.jobs) {
      if (!isTerminal(job.state)) continue;
      this.jobs.delete(id);
      this.controllers.delete(id);
      this.clearTimer(id);
    }
    this.emit({ kind: 'snapshot', jobs: this.list() });
  }

  subscribe(listener: (event: JobEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private promote(id: string): AppJob {
    const current = this.get(id);
    if (current.state !== 'pending-registration') return current;
    this.clearTimer(id);
    const job = this.replace(id, {
      ...current,
      state: 'running',
      registeredAtUnixMs: this.now(),
    });
    this.emit({ kind: 'started', job });
    return job;
  }

  private transition(id: string, state: JobState, patch: Partial<AppJob>): AppJob {
    let current = this.get(id);
    if (current.state === 'pending-registration') current = this.promote(id);
    const job = this.replace(id, { ...current, ...patch, state });
    this.emit({ kind: 'updated', job });
    return job;
  }

  private finish(id: string, state: 'completed' | 'failed' | 'cancelled', patch: Partial<AppJob>) {
    const current = this.get(id);
    this.clearTimer(id);
    const now = this.now();
    const registeredAt = current.registeredAtUnixMs;
    const job: AppJob = {
      ...current,
      ...patch,
      state,
      fraction: state === 'completed' ? 1 : current.fraction,
      finishedAtUnixMs: now,
      suppressChip:
        registeredAt === null || now - registeredAt < JOB_FAST_COMPLETION_MS,
    };
    if (registeredAt === null) {
      this.jobs.delete(id);
      this.controllers.delete(id);
      return job;
    }
    this.replace(id, job);
    this.emit({ kind: state, job });
    return job;
  }

  private replace(id: string, job: AppJob): AppJob {
    this.jobs.set(id, job);
    return job;
  }

  private clearTimer(id: string): void {
    const timer = this.timers.get(id);
    if (timer) clearTimeout(timer);
    this.timers.delete(id);
  }

  private emit(event: JobEvent): void {
    for (const listener of this.listeners) listener(event);
  }
}

export class JobMirror {
  private jobs: readonly AppJob[] = [];
  private listeners = new Set<() => void>();
  private unsubscribe: (() => void) | null = null;

  constructor(private readonly bridge: JobBridge) {}

  async mount(): Promise<() => void> {
    this.unsubscribe?.();
    this.unsubscribe = this.bridge.onEvent((event) => {
      this.jobs = event.kind === 'snapshot' ? event.jobs : upsertJob(this.jobs, event.job);
      this.notify();
    });
    this.jobs = await this.bridge.list();
    this.notify();
    return () => {
      this.unsubscribe?.();
      this.unsubscribe = null;
    };
  }

  snapshot = (): readonly AppJob[] => this.jobs;
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
  cancel = (id: string): Promise<AppJob> => this.bridge.cancel(id);
  respond = (id: string): Promise<AppJob> => this.bridge.respond(id);

  private notify(): void {
    for (const listener of this.listeners) listener();
  }
}

export function jobVisibleInChip(job: AppJob, now: number): boolean {
  if (job.suppressChip || job.registeredAtUnixMs === null) return false;
  return !isTerminal(job.state) && now - job.registeredAtUnixMs >= JOB_CHIP_DEBOUNCE_MS;
}

export function isTerminal(state: JobState): boolean {
  return state === 'completed' || state === 'failed' || state === 'cancelled';
}

const SIDECAR_PROGRESS_PREFIX = '__HC_PROGRESS__';

export function parseSidecarJobProgress(line: string): {
  readonly progressKey: string;
  readonly fraction: number;
  readonly message: string;
} | null {
  const index = line.indexOf(SIDECAR_PROGRESS_PREFIX);
  if (index < 0) return null;
  try {
    const value = JSON.parse(line.slice(index + SIDECAR_PROGRESS_PREFIX.length).trim()) as Record<
      string,
      unknown
    >;
    if (!value.progressKey || typeof value.progressKey !== 'string') return null;
    if (typeof value.fraction !== 'number' || !Number.isFinite(value.fraction)) return null;
    if (typeof value.message !== 'string') return null;
    return {
      progressKey: value.progressKey,
      fraction: Math.max(0, Math.min(1, value.fraction)),
      message: value.message,
    };
  } catch {
    return null;
  }
}

function upsertJob(jobs: readonly AppJob[], job: AppJob): readonly AppJob[] {
  const index = jobs.findIndex((candidate) => candidate.id === job.id);
  if (index < 0) return [...jobs, job];
  return jobs.map((candidate, candidateIndex) => (candidateIndex === index ? job : candidate));
}
