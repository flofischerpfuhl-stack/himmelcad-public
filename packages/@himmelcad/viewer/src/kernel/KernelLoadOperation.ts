export type KernelLoadPhase = 'validating' | 'fetching' | 'verifying' | 'publishing' | 'complete';

/** Monotonic provider-load progress; `completed === total` only after atomic publication. */
export interface KernelLoadProgress {
  readonly phase: KernelLoadPhase;
  readonly completed: number;
  readonly total: number;
}

export interface KernelLoadOperationOptions {
  readonly signal?: AbortSignal;
  readonly onProgress?: (progress: KernelLoadProgress) => void;
}

export type KernelLoadControl = AbortSignal | KernelLoadOperationOptions;

export function loadOperationOptions(control?: KernelLoadControl): KernelLoadOperationOptions {
  return control instanceof AbortSignal ? { signal: control } : (control ?? {});
}

/** Product callbacks are observational and cannot make an atomic provider load fail. */
export function reportLoadProgress(
  callback: KernelLoadOperationOptions['onProgress'],
  phase: KernelLoadPhase,
  completed: number,
  total: number,
): void {
  if (callback === undefined) return;
  try {
    callback({ phase, completed, total });
  } catch {
    // Host callbacks never participate in canonical commit semantics.
  }
}
