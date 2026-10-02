/**
 * Which body pairs a clearance query needs (pure, no OCCT): the gap between
 * two axis-aligned boxes is a lower bound of the bodies' distance, so pairs
 * whose boxes are farther apart than the threshold cannot be closer and are
 * never sent to the kernel (Print analysis, all-pairs clearance checks).
 */
import type { Vec3 } from '../document/document.js';

interface Boxed {
  id: string;
  min: readonly number[];
  max: readonly number[];
}

/** Distance between two axis-aligned boxes (0 when they touch or overlap). */
export function boxGap(a: { min: readonly number[]; max: readonly number[] }, b: typeof a): number {
  let sum = 0;
  for (let i = 0; i < 3; i += 1) {
    const d = Math.max(0, a.min[i]! - b.max[i]!, b.min[i]! - a.max[i]!);
    sum += d * d;
  }
  return Math.sqrt(sum);
}

/**
 * Pairs of `bodies` (in list order, `a` before `b`) whose boxes are at most
 * `maxGap` apart (`Infinity`: every pair).
 */
export function clearanceCandidates(
  bodies: readonly Boxed[],
  maxGap: number,
): { a: string; b: string; boxGap: number }[] {
  const out: { a: string; b: string; boxGap: number }[] = [];
  for (let i = 0; i < bodies.length; i += 1) {
    for (let j = i + 1; j < bodies.length; j += 1) {
      const gap = boxGap(bodies[i]!, bodies[j]!);
      if (gap <= maxGap) out.push({ a: bodies[i]!.id, b: bodies[j]!.id, boxGap: gap });
    }
  }
  return out;
}

/** Canonical key of an unordered body pair (`"a|b"`, ids sorted). */
export function pairKey(a: string, b: string): string {
  return a < b ? `${a}|${b}` : `${b}|${a}`;
}

/** Midpoint of two points. */
export function midpoint(a: Vec3, b: Vec3): Vec3 {
  return [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2];
}
