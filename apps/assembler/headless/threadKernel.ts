/**
 * The headless kernel adapter (assembler/ROBUSTNESS.md F13): OCCT in a Node
 * worker thread (`kernelThread.ts`) behind the same `WorkerKernelAdapter`
 * the app uses for its Web Worker — the same queue, crash recovery, heap
 * recycling and, here switched on, the **time budget**: a job that makes
 * no progress within `jobTimeoutMs` is stopped by terminating the thread,
 * fails with `KernelTimeoutError` (agent API `kernelTimeout`) and the
 * kernel restarts. An OCCT call that never returns can no longer hang a
 * headless or stdio agent caller.
 */
import { Worker as NodeWorker } from 'node:worker_threads';

import { WorkerKernelAdapter } from '../renderer/src/foundation/geometry-kernel/workerAdapter.js';
import type { EvaluationResult } from '../renderer/src/foundation/geometry-kernel/types.js';
import type { Feature } from '../renderer/src/foundation/document/document.js';
import type { EvaluateFreshParams, KernelThreadDiagnostics } from './kernelThread.js';

/** Responses that end a request (`workerProtocol.ts`); `progress`/`status` do not. */
const FINAL_RESPONSES: ReadonlySet<string> = new Set([
  'result',
  'failed',
  'fatal',
  'exportResult',
  'exportFailed',
  'meshResult',
  'meshFailed',
  'measureResult',
  'measureFailed',
  'clearanceResult',
  'queryResult',
  'queryFailed',
]);

/**
 * A Node worker thread with the part of the Web `Worker` interface the
 * adapter uses (`onmessage`, `onerror`, `postMessage`, `terminate`). The
 * thread writes nothing to stdout (the CLI's protocol stream, `kernelThread.ts`).
 *
 * The thread keeps the process alive only while it loads or has requests
 * outstanding (like a pending I/O call); an idle kernel thread lets a CLI,
 * a test file or the fuzzer exit without an explicit dispose.
 */
class ThreadWorker {
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onerror: ((event: { message: string; preventDefault?: () => void }) => void) | null = null;
  private readonly thread: NodeWorker;
  private terminated = false;
  /** Loading (until the first ready/error status) plus outstanding requests. */
  private busy = 1;
  private loading = true;

  constructor(url: URL, quiet: boolean) {
    // `execArgv: []`: the thread loads exactly what `kernelThread.ts` imports (the kernel
    // composition, like the app's kernel Web Worker), not a preload of the parent process
    // (`node --import test/setup.js` would otherwise put the whole app composition there).
    this.thread = new NodeWorker(url, { workerData: { quiet }, execArgv: [] });
    this.thread.on('message', (data: unknown) => {
      this.track(data);
      this.onmessage?.({ data });
    });
    this.thread.on('error', (error: Error) => this.onerror?.({ message: error.message }));
    this.thread.on('exit', (code) => {
      if (!this.terminated) this.onerror?.({ message: `the kernel thread exited (code ${code})` });
    });
  }

  private track(data: unknown): void {
    const message = data as { type?: string; status?: { status?: string } };
    if (message.type === 'status') {
      const status = message.status?.status;
      if (this.loading && (status === 'ready' || status === 'error')) {
        this.loading = false;
        this.release();
      }
    } else if (message.type && FINAL_RESPONSES.has(message.type)) {
      this.release();
    }
  }

  private release(): void {
    this.busy = Math.max(0, this.busy - 1);
    if (this.busy === 0) this.thread.unref();
  }

  postMessage(message: unknown, transfer: readonly ArrayBuffer[] = []): void {
    this.busy += 1;
    this.thread.ref();
    this.thread.postMessage(message, transfer);
  }

  terminate(): void {
    this.terminated = true;
    void this.thread.terminate();
  }
}
export interface ThreadKernelOptions {
  /** Budget of one kernel job without progress, ms; `undefined`: none. */
  jobTimeoutMs?: number;
  /** wasm heap after which the thread is recycled when idle (`adapter.ts`). */
  recycleHeapBytes?: number;
  /** Silences OCCT's console output (tests, fuzzer). */
  quiet?: boolean;
}

/** `WorkerKernelAdapter` over a Node worker thread, plus the cold re-evaluation query. */
export class ThreadKernelAdapter extends WorkerKernelAdapter {
  private readonly starts: { count: number };

  constructor(options: ThreadKernelOptions = {}) {
    const url = new URL('./kernelThread.js', import.meta.url);
    // Counted in a closure: the first thread starts inside the base constructor.
    const starts = { count: 0 };
    super(
      () => {
        starts.count += 1;
        return new ThreadWorker(url, options.quiet === true) as unknown as Worker;
      },
      {
        ...(options.recycleHeapBytes !== undefined
          ? { recycleHeapBytes: options.recycleHeapBytes }
          : {}),
        ...(options.jobTimeoutMs !== undefined ? { jobTimeoutMs: options.jobTimeoutMs } : {}),
      },
    );
    this.starts = starts;
  }

  /** How often a kernel thread was started (first load, recycles, restarts). */
  get loads(): number {
    return this.starts.count;
  }
  /**
   * A cold evaluation of `features` with a fresh evaluator on this kernel's
   * own OCCT instance (see `kernelThread.ts`), within the job budget, with
   * the arena-order counter of that thread.
   */
  async evaluateFresh(
    features: readonly Feature[],
    options: { staged?: boolean; perturbation?: number } = {},
  ): Promise<{ result: EvaluationResult; arenaInterleavings: number }> {
    await this.whenReady();
    const params: EvaluateFreshParams = { features: [...features], ...options };
    return this.query('evaluateFresh', params, 'a cold evaluation');
  }

  /** The kernel thread's OCCT arena-order counter (`occtArena.ts`). */
  async arenaInterleavings(): Promise<number> {
    return (await this.diagnostics()).arenaInterleavings;
  }

  /** What the kernel thread registered: its feature kinds and evaluators (`kernelThread.ts`). */
  async diagnostics(): Promise<KernelThreadDiagnostics> {
    await this.whenReady();
    return this.query<KernelThreadDiagnostics>('diagnostics', null, 'kernel diagnostics');
  }
}

/** The headless CLI's kernel: OCCT in a worker thread with a job time budget. */
export function createThreadKernel(options: ThreadKernelOptions = {}): ThreadKernelAdapter {
  return new ThreadKernelAdapter(options);
}
