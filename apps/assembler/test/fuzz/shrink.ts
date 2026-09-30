/**
 * Delta debugging (Zeller's ddmin) over fuzzer op sequences: finds a
 * smaller sequence that still breaks the same invariant. Ops resolve against
 * the document at run time (`ops.ts`), so every subsequence is runnable.
 * Bounded by a time budget; the result is the smallest failing sequence found.
 */
import type { Op } from './ops.js';

export async function shrink(
  ops: readonly Op[],
  fails: (candidate: readonly Op[]) => Promise<boolean>,
  options: { deadline: number; log?: (line: string) => void },
): Promise<Op[]> {
  let current = [...ops];
  let n = 2;
  const expired = () => Date.now() > options.deadline;
  while (current.length >= 2 && !expired()) {
    const size = Math.ceil(current.length / n);
    const chunks: Op[][] = [];
    for (let i = 0; i < current.length; i += size) chunks.push(current.slice(i, i + size));
    let reduced = false;
    // Try each subset, then each complement.
    for (const chunk of chunks) {
      if (expired()) break;
      if (chunk.length < current.length && (await fails(chunk))) {
        current = chunk;
        n = 2;
        reduced = true;
        break;
      }
    }
    if (!reduced) {
      for (let i = 0; i < chunks.length && !expired(); i += 1) {
        const complement = chunks.filter((_, j) => j !== i).flat();
        if (complement.length > 0 && (await fails(complement))) {
          current = complement;
          n = Math.max(n - 1, 2);
          reduced = true;
          break;
        }
      }
    }
    options.log?.(`shrink: ${current.length} ops (granularity ${n})`);
    if (!reduced) {
      if (n >= current.length) break;
      n = Math.min(current.length, n * 2);
    }
  }
  // Trailing ops after the failing step never matter; the harness stops there anyway.
  return current;
}
