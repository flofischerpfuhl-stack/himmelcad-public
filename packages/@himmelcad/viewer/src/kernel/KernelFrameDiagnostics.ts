export const KERNEL_FRAME_DIAGNOSTICS_CAPACITY = 2_048;

export type KernelPresentSource = 'raf-render-complete';

export type KernelDeadlineReasonCode =
  | 'within_target'
  | 'cpu_deadline'
  | 'gpu_deadline'
  | 'recovery_headroom'
  | 'invalid_timing'
  | 'resource_budget'
  | 'frame_budget'
  | 'invalid_benefit'
  | 'protected_work_over_budget';

export interface KernelFramePrimitiveCounts {
  readonly points: number;
  readonly triangles: number;
  readonly lines: number;
  readonly textQuads: number;
  readonly splats: number;
  readonly drawCalls: number;
}

export interface KernelFramePhaseTimers {
  /** Snapshot/current-camera work for protected lanes 1–3 before refinement planning. */
  readonly protectedLanes1To3Ms: number;
  /** Hierarchy planning plus host streaming for cloud/mesh refinement lanes 4–6. */
  readonly cloudMeshRefinementMs: number;
  /** Shared mixed-lane frame encoding/submission; intentionally not misattributed to either lane. */
  readonly sharedEncodeMs: number;
  readonly cpuPlanMs: number;
  readonly cpuHostMs: number;
  readonly cpuEncodeMs: number;
}

export interface KernelPresentedFrameSample {
  readonly frameId: number;
  readonly rafTimestampMs: number;
  readonly presentTimestampMs: number;
  readonly presentIntervalMs: number | null;
  readonly presentSource: KernelPresentSource;
  readonly inputId: string | null;
  readonly inputTimestampMs: number | null;
  readonly inputToPresentMs: number | null;
  readonly coalescedInputCount: number;
  readonly droppedInputCount: number;
  readonly cpuMs: number;
  readonly gpuMs: number | null;
  readonly gpuTimingSequence: number | null;
  readonly gpuTimestampSupported: boolean;
  readonly primitives: KernelFramePrimitiveCounts;
  readonly phases: KernelFramePhaseTimers;
  readonly deadlineReasonCodes: readonly KernelDeadlineReasonCode[];
  readonly renderScale: number;
  readonly detailScale: number;
  readonly uploadedBytes: number;
  readonly requestBacklog: number;
  readonly decodeBacklog: number;
  readonly uploadBacklog: number;
  readonly residencyBytes: number;
  readonly freshness: 'fresh' | 'reprojected';
}

export interface KernelDistribution {
  readonly samples: number;
  readonly p50: number;
  readonly p95: number;
  readonly p99: number;
  readonly maximum: number;
}

export interface KernelDiagnosticsSnapshot {
  readonly schemaId: 'hcad.view-diagnostics-snapshot@1';
  readonly capacity: 2_048;
  readonly frames: number;
  readonly presentSource: KernelPresentSource;
  readonly presentedFrameIntervalMs: KernelDistribution | null;
  readonly inputToPresentMs: KernelDistribution | null;
  readonly cpuMs: KernelDistribution | null;
  readonly gpuMs: KernelDistribution | null;
  readonly primitives: Readonly<Record<keyof KernelFramePrimitiveCounts, KernelDistribution | null>>;
  readonly phases: Readonly<Record<keyof KernelFramePhaseTimers, KernelDistribution | null>>;
  readonly lastFrames: readonly KernelPresentedFrameSample[];
}

export interface KernelDiagnosticsSampleRequest {
  readonly durationMs: number;
  readonly lastFrames?: number;
  readonly signal?: AbortSignal;
}

export type KernelDiagnosticsSampleResult = Omit<KernelDiagnosticsSnapshot, 'schemaId'> & {
  readonly schemaId: 'hcad.view-diagnostics-sample@1';
  readonly window: { readonly startedAtMs: number; readonly endedAtMs: number };
};

interface PendingInput {
  readonly id: string;
  readonly timestampMs: number;
}

/** Bounded, observational presented-frame recorder shared by the HUD and automation. */
export class KernelFrameDiagnostics {
  private readonly values: KernelPresentedFrameSample[] = [];
  private first = 0;
  private nextFrameId = 1;
  private nextInputId = 1;
  private pendingInputs: PendingInput[] = [];
  private sampling = false;

  recordInput(id = `input-${String(this.nextInputId++)}`, timestampMs = performance.now()): string {
    if (id.length === 0 || !finiteDuration(timestampMs)) {
      throw new RangeError('diagnostic input requires a non-empty id and finite timestamp');
    }
    this.pendingInputs.push({ id, timestampMs });
    if (this.pendingInputs.length > KERNEL_FRAME_DIAGNOSTICS_CAPACITY) this.pendingInputs.shift();
    return id;
  }

  recordFrame(
    sample: Omit<
      KernelPresentedFrameSample,
      | 'frameId'
      | 'inputId'
      | 'inputTimestampMs'
      | 'inputToPresentMs'
      | 'coalescedInputCount'
      | 'droppedInputCount'
    >,
  ): KernelPresentedFrameSample {
    const pending = this.pendingInputs;
    this.pendingInputs = [];
    const input = pending.at(-1) ?? null;
    const value: KernelPresentedFrameSample = Object.freeze({
      ...sample,
      frameId: this.nextFrameId++,
      inputId: input?.id ?? null,
      inputTimestampMs: input?.timestampMs ?? null,
      inputToPresentMs:
        input === null ? null : Math.max(0, sample.presentTimestampMs - input.timestampMs),
      coalescedInputCount: Math.max(0, pending.length - 1),
      droppedInputCount: 0,
      deadlineReasonCodes: Object.freeze([...sample.deadlineReasonCodes]),
      primitives: Object.freeze({ ...sample.primitives }),
      phases: Object.freeze({ ...sample.phases }),
    });
    if (this.values.length < KERNEL_FRAME_DIAGNOSTICS_CAPACITY) this.values.push(value);
    else {
      this.values[this.first] = value;
      this.first = (this.first + 1) % KERNEL_FRAME_DIAGNOSTICS_CAPACITY;
    }
    return value;
  }

  /** Correlates a later asynchronous timestamp readback to its submitted frame. */
  attachGpuSample(sequence: number, gpuMs: number): boolean {
    if (!Number.isSafeInteger(sequence) || sequence < 1 || !finiteDuration(gpuMs)) return false;
    const index = this.values.findIndex((frame) => frame.gpuTimingSequence === sequence);
    if (index < 0) return false;
    this.values[index] = Object.freeze({ ...this.values[index]!, gpuMs });
    return true;
  }

  snapshot(lastFrames = 120): KernelDiagnosticsSnapshot {
    return snapshotOf(this.ordered(), lastFrames);
  }

  async sample(request: KernelDiagnosticsSampleRequest): Promise<KernelDiagnosticsSampleResult> {
    if (this.sampling) throw new Error('view.diagnostics.sample is already running');
    if (!finiteDuration(request.durationMs) || request.durationMs > 3_600_000) {
      throw new RangeError('diagnostics sample durationMs must be from 0 through 3600000');
    }
    const lastFrames = request.lastFrames ?? 120;
    validateLastFrames(lastFrames);
    request.signal?.throwIfAborted();
    this.sampling = true;
    const startedAtMs = performance.now();
    const firstFrameId = this.nextFrameId;
    try {
      if (request.durationMs > 0) await abortableDelay(request.durationMs, request.signal);
      const endedAtMs = performance.now();
      const frames = this.ordered().filter((frame) => frame.frameId >= firstFrameId);
      return Object.freeze({
        ...snapshotOf(frames, lastFrames),
        schemaId: 'hcad.view-diagnostics-sample@1',
        window: Object.freeze({ startedAtMs, endedAtMs }),
      });
    } finally {
      this.sampling = false;
    }
  }

  private ordered(): readonly KernelPresentedFrameSample[] {
    if (this.values.length < KERNEL_FRAME_DIAGNOSTICS_CAPACITY || this.first === 0) {
      return [...this.values];
    }
    return [...this.values.slice(this.first), ...this.values.slice(0, this.first)];
  }
}

function snapshotOf(
  frames: readonly KernelPresentedFrameSample[],
  lastFrames: number,
): KernelDiagnosticsSnapshot {
  validateLastFrames(lastFrames);
  const primitive = <K extends keyof KernelFramePrimitiveCounts>(key: K) =>
    distribution(frames.map((frame) => frame.primitives[key]));
  const phase = <K extends keyof KernelFramePhaseTimers>(key: K) =>
    distribution(frames.map((frame) => frame.phases[key]));
  return Object.freeze({
    schemaId: 'hcad.view-diagnostics-snapshot@1',
    capacity: KERNEL_FRAME_DIAGNOSTICS_CAPACITY,
    frames: frames.length,
    presentSource: 'raf-render-complete',
    presentedFrameIntervalMs: distribution(
      frames.flatMap((frame) => (frame.presentIntervalMs === null ? [] : [frame.presentIntervalMs])),
    ),
    inputToPresentMs: distribution(
      frames.flatMap((frame) => (frame.inputToPresentMs === null ? [] : [frame.inputToPresentMs])),
    ),
    cpuMs: distribution(frames.map((frame) => frame.cpuMs)),
    gpuMs: distribution(frames.flatMap((frame) => (frame.gpuMs === null ? [] : [frame.gpuMs]))),
    primitives: Object.freeze({
      points: primitive('points'),
      triangles: primitive('triangles'),
      lines: primitive('lines'),
      textQuads: primitive('textQuads'),
      splats: primitive('splats'),
      drawCalls: primitive('drawCalls'),
    }),
    phases: Object.freeze({
      protectedLanes1To3Ms: phase('protectedLanes1To3Ms'),
      cloudMeshRefinementMs: phase('cloudMeshRefinementMs'),
      sharedEncodeMs: phase('sharedEncodeMs'),
      cpuPlanMs: phase('cpuPlanMs'),
      cpuHostMs: phase('cpuHostMs'),
      cpuEncodeMs: phase('cpuEncodeMs'),
    }),
    lastFrames: Object.freeze(frames.slice(-lastFrames).map((frame) => structuredClone(frame))),
  });
}

function distribution(values: readonly number[]): KernelDistribution | null {
  const sorted = values.filter(finiteDuration).sort((left, right) => left - right);
  if (sorted.length === 0) return null;
  const percentile = (fraction: number) =>
    sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)]!;
  return Object.freeze({
    samples: sorted.length,
    p50: percentile(0.5),
    p95: percentile(0.95),
    p99: percentile(0.99),
    maximum: sorted.at(-1)!,
  });
}

function validateLastFrames(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0 || value > KERNEL_FRAME_DIAGNOSTICS_CAPACITY) {
    throw new RangeError('lastFrames must be from 0 through 2048');
  }
}

function finiteDuration(value: number): boolean {
  return Number.isFinite(value) && value >= 0;
}

function abortableDelay(durationMs: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(finish, durationMs);
    const abort = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      reject(signal?.reason ?? new DOMException('Aborted', 'AbortError'));
    };
    function finish(): void {
      signal?.removeEventListener('abort', abort);
      resolve();
    }
    signal?.addEventListener('abort', abort, { once: true });
  });
}
