export declare const JOB_REGISTRATION_THRESHOLD_MS = 1000;
export declare const JOB_CHIP_DEBOUNCE_MS = 300;
export declare const JOB_FAST_COMPLETION_MS = 1000;
export declare const JOB_COMPLETED_RETENTION_MS = 30000;
export type JobState = 'pending-registration' | 'needs-input' | 'running' | 'cancelling' | 'completed' | 'failed' | 'cancelled';
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
export type JobEvent = {
    readonly kind: 'snapshot';
    readonly jobs: readonly AppJob[];
} | {
    readonly kind: 'started' | 'updated';
    readonly job: AppJob;
} | {
    readonly kind: 'completed' | 'failed' | 'cancelled';
    readonly job: AppJob;
};
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
/** Product-neutral registry. Electron main owns one instance for its lifetime. */
export declare class JobRegistry {
    private readonly now;
    private readonly jobs;
    private readonly controllers;
    private readonly listeners;
    private readonly timers;
    constructor(now?: Clock);
    register(input: RegisterJobInput, controller?: JobOwnerController): AppJob;
    list(options?: {
        includePending?: boolean;
    }): readonly AppJob[];
    get(id: string): AppJob;
    update(id: string, patch: Partial<Pick<AppJob, 'phase' | 'fraction' | 'progressKey' | 'cancellation'>>): AppJob;
    updateByProgressKey(progressKey: string, fraction: number, phase: string): AppJob | null;
    needsInput(id: string, phase?: string): AppJob;
    respond(id: string): Promise<AppJob>;
    cancel(id: string): Promise<AppJob>;
    complete(id: string, resultLabel?: string): AppJob;
    fail(id: string, error: string): AppJob;
    cancelled(id: string): AppJob;
    clearFinished(): void;
    subscribe(listener: (event: JobEvent) => void): () => void;
    private promote;
    private transition;
    private finish;
    private replace;
    private clearTimer;
    private emit;
}
export declare class JobMirror {
    private readonly bridge;
    private jobs;
    private listeners;
    private unsubscribe;
    constructor(bridge: JobBridge);
    mount(): Promise<() => void>;
    snapshot: () => readonly AppJob[];
    subscribe: (listener: () => void) => (() => void);
    cancel: (id: string) => Promise<AppJob>;
    respond: (id: string) => Promise<AppJob>;
    private notify;
}
export declare function jobVisibleInChip(job: AppJob, now: number): boolean;
export declare function isTerminal(state: JobState): boolean;
export declare function parseSidecarJobProgress(line: string): {
    readonly progressKey: string;
    readonly fraction: number;
    readonly message: string;
} | null;
export {};
//# sourceMappingURL=jobs.d.ts.map