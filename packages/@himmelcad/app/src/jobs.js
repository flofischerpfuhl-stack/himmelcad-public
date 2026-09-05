"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.JobMirror = exports.JobRegistry = exports.JOB_COMPLETED_RETENTION_MS = exports.JOB_FAST_COMPLETION_MS = exports.JOB_CHIP_DEBOUNCE_MS = exports.JOB_REGISTRATION_THRESHOLD_MS = void 0;
exports.jobVisibleInChip = jobVisibleInChip;
exports.isTerminal = isTerminal;
exports.parseSidecarJobProgress = parseSidecarJobProgress;
exports.JOB_REGISTRATION_THRESHOLD_MS = 1_000;
exports.JOB_CHIP_DEBOUNCE_MS = 300;
exports.JOB_FAST_COMPLETION_MS = 1_000;
exports.JOB_COMPLETED_RETENTION_MS = 30_000;
/** Product-neutral registry. Electron main owns one instance for its lifetime. */
class JobRegistry {
    now;
    jobs = new Map();
    controllers = new Map();
    listeners = new Set();
    timers = new Map();
    constructor(now = Date.now) {
        this.now = now;
    }
    register(input, controller = {}) {
        if (this.jobs.has(input.id))
            throw new Error(`job already exists: ${input.id}`);
        if (!input.cancellable && !input.cancellationReason?.trim()) {
            throw new Error('a non-cancellable job must name the reason');
        }
        const now = this.now();
        const immediate = input.needsInput || (input.expectedDurationMs ?? 0) > exports.JOB_REGISTRATION_THRESHOLD_MS;
        const job = {
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
        if (immediate)
            this.emit({ kind: 'started', job });
        else {
            this.timers.set(job.id, setTimeout(() => this.promote(job.id), exports.JOB_REGISTRATION_THRESHOLD_MS + 1));
        }
        return job;
    }
    list(options = {}) {
        return [...this.jobs.values()]
            .filter((job) => options.includePending || job.state !== 'pending-registration')
            .sort((left, right) => left.createdAtUnixMs - right.createdAtUnixMs);
    }
    get(id) {
        const job = this.jobs.get(id);
        if (!job)
            throw new Error(`job not found: ${id}`);
        return job;
    }
    update(id, patch) {
        let current = this.get(id);
        if (current.state === 'pending-registration')
            current = this.promote(id);
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
    updateByProgressKey(progressKey, fraction, phase) {
        const job = [...this.jobs.values()].find((candidate) => candidate.progressKey === progressKey);
        return job ? this.update(job.id, { fraction, phase }) : null;
    }
    needsInput(id, phase = 'Waiting for input') {
        const current = this.get(id);
        if (isTerminal(current.state))
            return current;
        return this.transition(id, 'needs-input', { phase });
    }
    async respond(id) {
        const current = this.get(id);
        if (current.state !== 'needs-input')
            throw new Error('job is not waiting for input');
        await this.controllers.get(id)?.respond?.(current);
        return this.transition(id, 'running', { phase: 'Resuming' });
    }
    async cancel(id) {
        const current = this.get(id);
        if (isTerminal(current.state))
            return current;
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
    complete(id, resultLabel) {
        return this.finish(id, 'completed', { resultLabel: resultLabel ?? null });
    }
    fail(id, error) {
        return this.finish(id, 'failed', { error, phase: 'Failed' });
    }
    cancelled(id) {
        return this.finish(id, 'cancelled', { phase: 'Cancelled' });
    }
    clearFinished() {
        for (const [id, job] of this.jobs) {
            if (!isTerminal(job.state))
                continue;
            this.jobs.delete(id);
            this.controllers.delete(id);
            this.clearTimer(id);
        }
        this.emit({ kind: 'snapshot', jobs: this.list() });
    }
    subscribe(listener) {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    }
    promote(id) {
        const current = this.get(id);
        if (current.state !== 'pending-registration')
            return current;
        this.clearTimer(id);
        const job = this.replace(id, {
            ...current,
            state: 'running',
            registeredAtUnixMs: this.now(),
        });
        this.emit({ kind: 'started', job });
        return job;
    }
    transition(id, state, patch) {
        let current = this.get(id);
        if (current.state === 'pending-registration')
            current = this.promote(id);
        const job = this.replace(id, { ...current, ...patch, state });
        this.emit({ kind: 'updated', job });
        return job;
    }
    finish(id, state, patch) {
        const current = this.get(id);
        this.clearTimer(id);
        const now = this.now();
        const registeredAt = current.registeredAtUnixMs;
        const job = {
            ...current,
            ...patch,
            state,
            fraction: state === 'completed' ? 1 : current.fraction,
            finishedAtUnixMs: now,
            suppressChip: registeredAt === null || now - registeredAt < exports.JOB_FAST_COMPLETION_MS,
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
    replace(id, job) {
        this.jobs.set(id, job);
        return job;
    }
    clearTimer(id) {
        const timer = this.timers.get(id);
        if (timer)
            clearTimeout(timer);
        this.timers.delete(id);
    }
    emit(event) {
        for (const listener of this.listeners)
            listener(event);
    }
}
exports.JobRegistry = JobRegistry;
class JobMirror {
    bridge;
    jobs = [];
    listeners = new Set();
    unsubscribe = null;
    constructor(bridge) {
        this.bridge = bridge;
    }
    async mount() {
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
    snapshot = () => this.jobs;
    subscribe = (listener) => {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    };
    cancel = (id) => this.bridge.cancel(id);
    respond = (id) => this.bridge.respond(id);
    notify() {
        for (const listener of this.listeners)
            listener();
    }
}
exports.JobMirror = JobMirror;
function jobVisibleInChip(job, now) {
    if (job.suppressChip || job.registeredAtUnixMs === null)
        return false;
    return !isTerminal(job.state) && now - job.registeredAtUnixMs >= exports.JOB_CHIP_DEBOUNCE_MS;
}
function isTerminal(state) {
    return state === 'completed' || state === 'failed' || state === 'cancelled';
}
const SIDECAR_PROGRESS_PREFIX = '__HC_PROGRESS__';
function parseSidecarJobProgress(line) {
    const index = line.indexOf(SIDECAR_PROGRESS_PREFIX);
    if (index < 0)
        return null;
    try {
        const value = JSON.parse(line.slice(index + SIDECAR_PROGRESS_PREFIX.length).trim());
        if (!value.progressKey || typeof value.progressKey !== 'string')
            return null;
        if (typeof value.fraction !== 'number' || !Number.isFinite(value.fraction))
            return null;
        if (typeof value.message !== 'string')
            return null;
        return {
            progressKey: value.progressKey,
            fraction: Math.max(0, Math.min(1, value.fraction)),
            message: value.message,
        };
    }
    catch {
        return null;
    }
}
function upsertJob(jobs, job) {
    const index = jobs.findIndex((candidate) => candidate.id === job.id);
    if (index < 0)
        return [...jobs, job];
    return jobs.map((candidate, candidateIndex) => (candidateIndex === index ? job : candidate));
}
//# sourceMappingURL=jobs.js.map