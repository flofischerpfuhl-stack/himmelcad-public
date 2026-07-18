export type KernelDecodeKind =
  | 'gltf'
  | 'threeDTilesContainer'
  | 'potreePoints'
  | 'gaussianSplats'
  | 'raster';

export interface KernelDecodeJob {
  readonly kind: KernelDecodeKind;
  readonly metadataJson: string;
  readonly bundleManifestJson: string;
  readonly decodeParametersJson: string;
  readonly primary: ArrayBuffer;
  readonly bundle: ArrayBuffer;
  readonly secondary: ArrayBuffer;
}

export interface KernelDecodedArtifact {
  readonly artifact: ArrayBuffer;
  readonly primary: ArrayBuffer;
  readonly bundle: ArrayBuffer;
  readonly secondary: ArrayBuffer;
  readonly workerDurationMs: number;
  readonly workerContext: boolean;
  readonly workerBaselineLinearMemoryBytes: number;
  readonly workerLinearMemoryBytes: number;
}

/** Decode failure whose transferred inputs were returned by a healthy worker. */
export class KernelDecodeWorkerError extends Error {
  override readonly name = 'KernelDecodeWorkerError';

  constructor(
    message: string,
    readonly primary: ArrayBuffer,
    readonly bundle: ArrayBuffer,
    readonly secondary: ArrayBuffer,
    readonly workerDurationMs: number,
    readonly workerContext: boolean,
    readonly workerBaselineLinearMemoryBytes: number,
    readonly workerLinearMemoryBytes: number,
  ) {
    super(message);
  }
}

export interface KernelDecodePoolDiagnostics {
  readonly requestedDecodeWorkers: number;
  readonly actualDecodeWorkers: number;
  readonly workerRamBudgetBytes: number;
  readonly perWorkerReservationBytes: number;
  readonly activeDecodes: number;
  readonly queuedDecodes: number;
  readonly transferredInputBytes: number;
  readonly transferredOutputBytes: number;
  readonly peakTransferBytes: number;
  readonly completedDecodes: number;
  readonly failedDecodes: number;
  readonly canceledDecodes: number;
  readonly workerDecodeMs: number;
  readonly mainThreadDispatchMs: number;
  readonly maximumWorkerBaselineLinearMemoryBytes: number;
  readonly maximumWorkerLinearMemoryBytes: number;
}

interface WorkerRequest {
  readonly kind: 'decode';
  readonly id: number;
  readonly wasmModuleUrl: string;
  readonly job: KernelDecodeJob;
}

interface WorkerResponse extends KernelDecodedArtifact {
  readonly kind: 'decoded';
  readonly id: number;
}

interface WorkerFailure {
  readonly kind: 'failed';
  readonly id: number;
  readonly message: string;
  readonly primary: ArrayBuffer;
  readonly bundle: ArrayBuffer;
  readonly secondary: ArrayBuffer;
  readonly workerDurationMs: number;
  readonly workerContext: boolean;
  readonly workerBaselineLinearMemoryBytes: number;
  readonly workerLinearMemoryBytes: number;
}

interface QueueEntry {
  readonly id: number;
  readonly job: KernelDecodeJob;
  readonly resolve: (artifact: KernelDecodedArtifact) => void;
  readonly reject: (reason: unknown) => void;
  readonly signal: AbortSignal;
  readonly abort: () => void;
  canceled: boolean;
  settled: boolean;
}

interface WorkerSlot {
  readonly worker: Worker;
  active: QueueEntry | null;
  retire: boolean;
}

/** Hardware-sized transferable worker pool shared by every streaming provider. */
export class KernelDecodeWorkerPool {
  private readonly queue: QueueEntry[] = [];
  private readonly slots: WorkerSlot[] = [];
  private nextId = 1;
  private disposed = false;
  private transferredInputBytes = 0;
  private transferredOutputBytes = 0;
  private peakTransferBytes = 0;
  private completedDecodes = 0;
  private failedDecodes = 0;
  private canceledDecodes = 0;
  private workerDecodeMs = 0;
  private mainThreadDispatchMs = 0;
  private maximumWorkerBaselineLinearMemoryBytes = 0;
  private maximumWorkerLinearMemoryBytes = 0;
  private requestedWorkers = 0;

  constructor(
    private readonly wasmModuleUrl: string,
    workers: number,
    private readonly createWorker: () => Worker = () => new Worker(
      new URL('./KernelDecodeWorker.js', import.meta.url),
      { type: 'module', name: 'himmelcad-streaming-decode' },
    ),
    private readonly workerRamBudgetBytes = 512 * 1024 * 1024,
    private readonly minimumPerWorkerReservationBytes = 256 * 1024 * 1024,
  ) {
    if (wasmModuleUrl.length === 0) throw new Error('decode worker wasmModuleUrl must be non-empty');
    this.setWorkerCount(workers);
  }

  setWorkerCount(workers: number): void {
    this.assertAlive();
    if (!Number.isSafeInteger(workers) || workers <= 0 || workers > 256) {
      throw new RangeError('decode worker count must be an integer from 1 through 256');
    }
    this.requestedWorkers = workers;
    this.reconcileDesiredWorkers();
    this.dispatch();
  }

  decode(job: KernelDecodeJob, signal: AbortSignal): Promise<KernelDecodedArtifact> {
    this.assertAlive();
    if (signal.aborted) return Promise.reject(new DOMException('decode aborted', 'AbortError'));
    return new Promise((resolve, reject) => {
      const id = this.nextId++;
      const entry: QueueEntry = {
        id,
        job,
        resolve,
        reject,
        signal,
        canceled: false,
        settled: false,
        abort: () => {
          if (entry.canceled) return;
          entry.canceled = true;
          this.canceledDecodes += 1;
          entry.signal.removeEventListener('abort', entry.abort);
          const queued = this.queue.indexOf(entry);
          if (queued >= 0) this.queue.splice(queued, 1);
          this.rejectEntry(entry, new DOMException('decode aborted', 'AbortError'));
          if (queued < 0) {
            const slot = this.slots.find((candidate) => candidate.active === entry);
            if (slot !== undefined) this.cancelActiveSlot(slot);
          }
        },
      };
      signal.addEventListener('abort', entry.abort, { once: true });
      this.queue.push(entry);
      this.dispatch();
    });
  }

  diagnostics(): KernelDecodePoolDiagnostics {
    return {
      requestedDecodeWorkers: this.requestedWorkers,
      actualDecodeWorkers: this.slots.length,
      workerRamBudgetBytes: this.workerRamBudgetBytes,
      perWorkerReservationBytes: this.perWorkerReservationBytes(),
      activeDecodes: this.slots.filter((slot) => slot.active !== null).length,
      queuedDecodes: this.queue.length,
      transferredInputBytes: this.transferredInputBytes,
      transferredOutputBytes: this.transferredOutputBytes,
      peakTransferBytes: this.peakTransferBytes,
      completedDecodes: this.completedDecodes,
      failedDecodes: this.failedDecodes,
      canceledDecodes: this.canceledDecodes,
      workerDecodeMs: this.workerDecodeMs,
      mainThreadDispatchMs: this.mainThreadDispatchMs,
      maximumWorkerBaselineLinearMemoryBytes: this.maximumWorkerBaselineLinearMemoryBytes,
      maximumWorkerLinearMemoryBytes: this.maximumWorkerLinearMemoryBytes,
    };
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const entry of this.queue.splice(0)) {
      this.rejectEntry(entry, new Error('decode worker pool disposed'));
    }
    for (const slot of this.slots.splice(0)) {
      if (slot.active !== null) {
        this.rejectEntry(slot.active, new Error('decode worker pool disposed'));
      }
      slot.worker.terminate();
    }
  }

  private addWorker(): void {
    const worker = this.createWorker();
    const slot: WorkerSlot = { worker, active: null, retire: false };
    worker.onmessage = (event: MessageEvent<unknown>) => {
      this.complete(slot, event.data);
    };
    worker.onerror = (event) => {
      event.preventDefault();
      this.failSlot(slot, new Error(event.message || 'decode worker failed'));
    };
    worker.onmessageerror = () => this.failSlot(
      slot,
      new Error('decode worker protocol message could not be deserialized'),
    );
    this.slots.push(slot);
  }

  private dispatch(): void {
    const started = performance.now();
    for (const slot of this.slots) {
      if (slot.active !== null || slot.retire) continue;
      let entry = this.queue.shift();
      while (entry?.canceled === true) entry = this.queue.shift();
      if (entry === undefined) break;
      slot.active = entry;
      const inputBytes = bufferBytes(entry.job);
      this.transferredInputBytes += inputBytes;
      this.peakTransferBytes = Math.max(this.peakTransferBytes, inputBytes);
      const request: WorkerRequest = {
        kind: 'decode', id: entry.id, wasmModuleUrl: this.wasmModuleUrl, job: entry.job,
      };
      try {
        slot.worker.postMessage(request, [
          entry.job.primary,
          entry.job.bundle,
          entry.job.secondary,
        ]);
      } catch (error) {
        this.failSlot(slot, error instanceof Error ? error : new Error(String(error)));
      }
    }
    this.mainThreadDispatchMs += performance.now() - started;
  }

  private complete(slot: WorkerSlot, response: unknown): void {
    if (!this.slots.includes(slot)) return;
    const entry = slot.active;
    if (entry === null || !isWorkerResponse(response) || response.id !== entry.id) {
      this.failSlot(slot, new Error('decode worker protocol response did not match the active job'));
      return;
    }
    slot.active = null;
    entry.signal.removeEventListener('abort', entry.abort);
    const rawOutputBytes = response.primary.byteLength + response.bundle.byteLength +
      response.secondary.byteLength;
    const outputBytes = rawOutputBytes + (response.kind === 'decoded' ? response.artifact.byteLength : 0);
    this.transferredOutputBytes += outputBytes;
    this.peakTransferBytes = Math.max(this.peakTransferBytes, outputBytes);
    this.workerDecodeMs += response.workerDurationMs;
    this.maximumWorkerBaselineLinearMemoryBytes = Math.max(
      this.maximumWorkerBaselineLinearMemoryBytes,
      response.workerBaselineLinearMemoryBytes,
    );
    this.maximumWorkerLinearMemoryBytes = Math.max(
      this.maximumWorkerLinearMemoryBytes,
      response.workerLinearMemoryBytes,
    );
    if (response.kind === 'failed') {
      if (!entry.canceled) {
        this.failedDecodes += 1;
        this.rejectEntry(entry, new KernelDecodeWorkerError(
          response.message,
          response.primary,
          response.bundle,
          response.secondary,
          response.workerDurationMs,
          response.workerContext,
          response.workerBaselineLinearMemoryBytes,
          response.workerLinearMemoryBytes,
        ));
      }
    } else {
      if (!entry.canceled) {
        this.completedDecodes += 1;
        this.resolveEntry(entry, response);
      }
    }
    this.reconcileDesiredWorkers();
    this.dispatch();
  }

  private failSlot(slot: WorkerSlot, error: Error): void {
    const index = this.slots.indexOf(slot);
    if (index < 0) return;
    const active = slot.active;
    slot.active = null;
    if (active !== null) {
      active.signal.removeEventListener('abort', active.abort);
      if (!active.canceled) {
        this.failedDecodes += 1;
        this.rejectEntry(active, error);
      }
    }
    slot.worker.terminate();
    this.slots.splice(index, 1);
    this.reconcileDesiredWorkers();
    this.dispatch();
  }

  private cancelActiveSlot(slot: WorkerSlot): void {
    const index = this.slots.indexOf(slot);
    if (index < 0) return;
    slot.active = null;
    slot.worker.terminate();
    this.slots.splice(index, 1);
    this.reconcileDesiredWorkers();
    this.dispatch();
  }

  private reconcileDesiredWorkers(): void {
    if (this.disposed) return;
    const ramLimitedWorkers = Math.max(1, Math.floor(
      this.workerRamBudgetBytes / this.perWorkerReservationBytes(),
    ));
    const desired = Math.min(this.requestedWorkers, ramLimitedWorkers);
    for (const slot of this.slots) slot.retire = false;

    let excess = this.slots.length - desired;
    for (let index = this.slots.length - 1; index >= 0 && excess > 0; index -= 1) {
      const slot = this.slots[index]!;
      if (slot.active !== null) continue;
      slot.worker.terminate();
      this.slots.splice(index, 1);
      excess -= 1;
    }
    for (let index = this.slots.length - 1; index >= 0 && excess > 0; index -= 1) {
      const slot = this.slots[index]!;
      if (slot.retire) continue;
      slot.retire = true;
      excess -= 1;
    }
    while (this.slots.length < desired) this.addWorker();
  }

  private resolveEntry(entry: QueueEntry, artifact: KernelDecodedArtifact): void {
    if (entry.settled) return;
    entry.settled = true;
    entry.signal.removeEventListener('abort', entry.abort);
    entry.resolve(artifact);
  }

  private rejectEntry(entry: QueueEntry, reason: unknown): void {
    if (entry.settled) return;
    entry.settled = true;
    entry.signal.removeEventListener('abort', entry.abort);
    entry.reject(reason);
  }

  private perWorkerReservationBytes(): number {
    const observedPeakWithTransferredInputs = this.maximumWorkerLinearMemoryBytes +
      this.peakTransferBytes;
    return Math.max(this.minimumPerWorkerReservationBytes, observedPeakWithTransferredInputs);
  }

  private assertAlive(): void {
    if (this.disposed) throw new Error('decode worker pool has been disposed');
  }
}

function isWorkerResponse(value: unknown): value is WorkerResponse | WorkerFailure {
  if (typeof value !== 'object' || value === null) return false;
  const response = value as Record<string, unknown>;
  if ((response.kind !== 'decoded' && response.kind !== 'failed') ||
      !Number.isSafeInteger(response.id) || !(response.primary instanceof ArrayBuffer) ||
      !(response.bundle instanceof ArrayBuffer) || !(response.secondary instanceof ArrayBuffer) ||
      typeof response.workerDurationMs !== 'number' || !Number.isFinite(response.workerDurationMs) ||
      response.workerDurationMs < 0 || typeof response.workerContext !== 'boolean') {
    return false;
  }
  if (!Number.isSafeInteger(response.workerBaselineLinearMemoryBytes) ||
      Number(response.workerBaselineLinearMemoryBytes) < 0 ||
      !Number.isSafeInteger(response.workerLinearMemoryBytes) ||
      Number(response.workerLinearMemoryBytes) < Number(response.workerBaselineLinearMemoryBytes)) {
    return false;
  }
  return response.kind === 'decoded'
    ? response.artifact instanceof ArrayBuffer
    : typeof response.message === 'string';
}

function bufferBytes(job: KernelDecodeJob): number {
  return job.primary.byteLength + job.bundle.byteLength + job.secondary.byteLength;
}
