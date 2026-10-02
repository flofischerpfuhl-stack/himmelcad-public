/**
 * The clearance part of the printability analysis (assembler/PRINTING.md
 * "Clearance between bodies"): body pairs whose bounding boxes are closer
 * than the minimum clearance are measured exactly in the kernel
 * (`KernelAdapter.measureClearance`: `BRepExtrema` distance, `Common`
 * overlap volume); overlaps and gaps below the minimum become findings.
 *
 * Runs after the mesh analysis, off the UI thread (the kernel worker), in
 * small chunks so Cancel takes effect between chunks and progress is
 * reported, within a total time budget — pairs left over are reported as
 * not checked, never silently dropped.
 */
import type { Feature } from '../../foundation/document/document.js';
import type { KernelAdapter } from '../../foundation/geometry-kernel/adapter.js';
import { clearanceCandidates, pairKey } from '../../foundation/geometry-kernel/clearancePairs.js';
import type { ClearancePairResult } from '../../foundation/geometry-kernel/types.js';
import type { PrintFinding } from './analysis.js';
import type { PrintSettings } from './settings.js';

/** Total kernel time of the clearance pass, ms. */
export const CLEARANCE_PASS_BUDGET_MS = 10_000;
/** Pairs per kernel request (Cancel is checked between requests). */
const CHUNK = 4;

export interface ClearanceBody {
  id: string;
  name: string;
  min: readonly number[];
  max: readonly number[];
}

export interface ClearancePassOptions {
  onProgress?: (done: number, total: number) => void;
  cancelled?: () => boolean;
  budgetMs?: number;
}

function fmt(value: number, digits = 2): string {
  return Number(value.toFixed(digits)).toString();
}

/** Findings of measured pairs (overlaps first, then the closest gaps). */
export function clearanceFindings(
  results: readonly ClearancePairResult[],
  bodies: readonly ClearanceBody[],
  minClearanceMm: number,
): PrintFinding[] {
  const name = (id: string) => bodies.find((b) => b.id === id)?.name ?? id;
  const out: PrintFinding[] = [];
  for (const r of results) {
    const [a, b] = r.a < r.b ? [r.a, r.b] : [r.b, r.a];
    const base = {
      bodyId: a,
      bodyName: name(a),
      otherBodyId: b,
      otherBodyName: name(b),
      faceKeys: [],
    };
    if (r.relation === 'overlap') {
      out.push({
        ...base,
        id: `overlap:${pairKey(a, b)}`,
        kind: 'overlap',
        severity: 'error',
        ...(r.overlapVolume !== null ? { value: r.overlapVolume } : {}),
        ...(r.overlapCenter ? { point: r.overlapCenter } : { point: r.pointA }),
        message: `${name(a)} and ${name(b)} overlap${r.overlapVolume !== null ? ` (${fmt(r.overlapVolume)} mm³)` : ''}: printed together they fuse.`,
      });
    } else if (r.distance < minClearanceMm - 1e-9) {
      out.push({
        ...base,
        id: `clearance:${pairKey(a, b)}`,
        kind: 'clearance',
        severity: 'warning',
        value: r.distance,
        segment: r.a === a ? [r.pointA, r.pointB] : [r.pointB, r.pointA],
        message:
          r.relation === 'contact'
            ? `${name(a)} and ${name(b)} touch (clearance 0 < ${fmt(minClearanceMm)} mm).`
            : `Clearance ${name(a)} ↔ ${name(b)} ${fmt(r.distance, 3)} mm < ${fmt(minClearanceMm)} mm.`,
      });
    }
  }
  return out.sort(
    (x, y) =>
      (x.kind === 'overlap' ? 0 : 1) - (y.kind === 'overlap' ? 0 : 1) ||
      (x.value ?? 0) - (y.value ?? 0),
  );
}

/** One info finding for pairs that were not measured. */
export function skippedFinding(
  skipped: number,
  total: number,
  reason: 'budget' | 'cancelled',
  first: ClearanceBody,
): PrintFinding {
  return {
    id: 'clearanceSkipped:all',
    kind: 'clearanceSkipped',
    severity: 'info',
    bodyId: first.id,
    bodyName: first.name,
    faceKeys: [],
    value: skipped,
    message:
      reason === 'budget'
        ? `Clearance not checked for ${skipped} of ${total} close body pairs (time budget).`
        : `Clearance not checked for ${skipped} of ${total} close body pairs (cancelled).`,
  };
}

/**
 * Measures the close pairs of `bodies` in the kernel and returns the
 * findings (see the module comment). `features` are the active features the
 * bodies were evaluated from.
 */
export async function runClearancePass(
  kernel: KernelAdapter,
  features: readonly Feature[],
  bodies: readonly ClearanceBody[],
  settings: Pick<PrintSettings, 'minClearanceMm'>,
  options: ClearancePassOptions = {},
): Promise<{ findings: PrintFinding[]; measured: number; candidates: number }> {
  if (!kernel.measureClearance || bodies.length < 2) {
    return { findings: [], measured: 0, candidates: 0 };
  }
  const candidates = clearanceCandidates(bodies, settings.minClearanceMm + 1e-6);
  const budget = options.budgetMs ?? CLEARANCE_PASS_BUDGET_MS;
  const started = Date.now();
  const results: ClearancePairResult[] = [];
  let reason: 'budget' | 'cancelled' | null = null;
  options.onProgress?.(0, candidates.length);
  for (let i = 0; i < candidates.length; i += CHUNK) {
    if (options.cancelled?.()) {
      reason = 'cancelled';
      break;
    }
    const left = budget - (Date.now() - started);
    if (left <= 0) {
      reason = 'budget';
      break;
    }
    const chunk = candidates.slice(i, i + CHUNK).map(({ a, b }) => ({ a, b }));
    const answer = await kernel.measureClearance(features, { pairs: chunk, budgetMs: left });
    results.push(...answer.pairs);
    if (answer.skipped.length > 0) {
      reason = 'budget';
      break;
    }
    options.onProgress?.(results.length, candidates.length);
  }
  const findings = clearanceFindings(results, bodies, settings.minClearanceMm);
  if (reason && results.length < candidates.length) {
    findings.push(
      skippedFinding(candidates.length - results.length, candidates.length, reason, bodies[0]!),
    );
  }
  return { findings, measured: results.length, candidates: candidates.length };
}
