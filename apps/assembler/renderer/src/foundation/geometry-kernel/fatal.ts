/**
 * Kernel failures that make the OCCT instance unusable (wasm abort, out of
 * memory, memory corruption) — as opposed to a feature that cannot be built.
 * Kept free of OCCT/replicad imports: the UI thread's adapters use it too.
 */

/** The kernel itself failed; it must be restarted before the next evaluation. */
export class KernelFatalError extends Error {
  readonly fatal = true;
}

/** `true` for errors after which the OCCT instance must not be used again. */
export function isFatalKernelError(error: unknown): boolean {
  if (error instanceof KernelFatalError) return true;
  if (
    typeof error === 'object' &&
    error !== null &&
    (error as { fatal?: unknown }).fatal === true
  ) {
    return true;
  }
  const RuntimeError = (globalThis as { WebAssembly?: { RuntimeError?: new () => Error } })
    .WebAssembly?.RuntimeError;
  if (RuntimeError && error instanceof RuntimeError) return true;
  if (error instanceof RangeError && /memory|allocation/i.test(error.message)) return true;
  const message = error instanceof Error ? error.message : typeof error === 'string' ? error : '';
  return /Aborted\(|out of memory|Cannot enlarge memory|memory access out of bounds/i.test(message);
}
